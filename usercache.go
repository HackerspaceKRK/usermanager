package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

const cacheTTL = 10 * time.Minute

type authentikUser struct {
	PK          int                    `json:"pk"`
	Username    string                 `json:"username"`
	Name        string                 `json:"name"`
	IsActive    bool                   `json:"is_active"`
	LastLogin   *string                `json:"last_login"`
	DateJoined  string                 `json:"date_joined"`
	IsSuperuser bool                   `json:"is_superuser"`
	Groups      []string               `json:"groups"`
	GroupsObj   json.RawMessage        `json:"groups_obj"`
	Email       string                 `json:"email"`
	Avatar      string                 `json:"avatar"`
	Attributes  map[string]interface{} `json:"attributes"`
	UID         string                 `json:"uid"`
	Path        string                 `json:"path"`
	Type        string                 `json:"type"`
	UUID        string                 `json:"uuid"`
	LastUpdated string                 `json:"last_updated"`
}

type authentikPagination struct {
	Next       int `json:"next"`
	Previous   int `json:"previous"`
	Count      int `json:"count"`
	Current    int `json:"current"`
	TotalPages int `json:"total_pages"`
	StartIndex int `json:"start_index"`
	EndIndex   int `json:"end_index"`
}

type authentikUserList struct {
	Pagination authentikPagination `json:"pagination"`
	Results    []authentikUser     `json:"results"`
}

type apiError struct{ status int }

func (e *apiError) Error() string { return fmt.Sprintf("HTTP %d", e.status) }

type userCache struct {
	mu       sync.Mutex
	users    []authentikUser
	cachedAt time.Time
	// newest is the latest last_updated among the cached users. Changes are detected by comparing Authentik's own
	// timestamps with each other, never with this server's clock (which may differ or jump).
	newest time.Time
}

func (c *userCache) get(token, authentikURL string) ([]authentikUser, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	valid := len(c.users) > 0 && time.Since(c.cachedAt) < cacheTTL

	if valid {
		// Validate token and detect changes in one request: is the most recently updated user newer than
		// anything we cached? If the timestamp is missing or unparsable we cannot tell, so we refetch.
		page1, err := fetchUsersPage(token, authentikURL, 1, 1, "-last_updated")
		if err != nil {
			return nil, err
		}
		if len(page1.Results) > 0 {
			t, perr := time.Parse(time.RFC3339, page1.Results[0].LastUpdated)
			if perr != nil || t.After(c.newest) {
				valid = false // something changed (or cannot be verified)
			}
		}
	}

	if !valid {
		// Cache missing, older than cacheTTL, or invalidated above. (This used to be guarded by len(c.users) == 0,
		// which is never true once the cache has been filled, so after cacheTTL it was never refreshed again.)
		all, err := fetchAllUsers(token, authentikURL)
		if err != nil {
			return nil, err
		}
		c.users = all
		c.cachedAt = time.Now()
		c.newest = newestUpdate(all)
	}

	return c.users, nil
}

func newestUpdate(users []authentikUser) time.Time {
	var newest time.Time
	for i := range users {
		if t, err := time.Parse(time.RFC3339, users[i].LastUpdated); err == nil && t.After(newest) {
			newest = t
		}
	}
	return newest
}

func fetchUsersPage(token, authentikURL string, page, pageSize int, ordering string) (*authentikUserList, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("page_size", strconv.Itoa(pageSize))
	if ordering != "" {
		q.Set("ordering", ordering)
	}
	reqURL := authentikURL + "/api/v3/core/users/?" + q.Encode()

	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, &apiError{status: resp.StatusCode}
	}

	var list authentikUserList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, err
	}
	return &list, nil
}

func fetchAllUsers(token, authentikURL string) ([]authentikUser, error) {
	var all []authentikUser
	page := 1
	for {
		result, err := fetchUsersPage(token, authentikURL, page, 100, "")
		if err != nil {
			return nil, err
		}
		all = append(all, result.Results...)
		if result.Pagination.Next == 0 {
			break
		}
		page++
	}
	return all, nil
}

func extractToken(authHeader string) string {
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}
	return ""
}

func membershipTS(u *authentikUser) float64 {
	if u.Attributes == nil {
		return 0
	}
	v, ok := u.Attributes["membershipExpirationTimestamp"]
	if !ok {
		return 0
	}
	switch f := v.(type) {
	case float64:
		return f
	case json.Number:
		n, _ := f.Float64()
		return n
	}
	return 0
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func handleCacheError(c *fiber.Ctx, err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return c.Status(ae.status).SendString(ae.Error())
	}
	return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
}

func handleCachedUsers(cache *userCache, authentikURL string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		token := extractToken(c.Get("Authorization"))
		if token == "" {
			return c.Status(fiber.StatusUnauthorized).SendString("unauthorized")
		}

		users, err := cache.get(token, authentikURL)
		if err != nil {
			return handleCacheError(c, err)
		}

		// Filter
		search := strings.ToLower(c.Query("search"))
		var filtered []authentikUser
		for _, u := range users {
			if search == "" ||
				strings.Contains(strings.ToLower(u.Username), search) ||
				strings.Contains(strings.ToLower(u.Name), search) ||
				strings.Contains(strings.ToLower(u.Email), search) ||
				strings.Contains(messengerSearchText(&u), search) {
				filtered = append(filtered, u)
			}
		}

		// Date-range filter (applied after search, before sort)
		var fromTS, toTS int64
		if v := c.Query("membershipFrom"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				fromTS = t.Unix()
			}
		}
		if v := c.Query("membershipTo"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				toTS = t.Add(24*time.Hour - time.Second).Unix()
			}
		}
		if fromTS > 0 || toTS > 0 {
			var r []authentikUser
			for _, u := range filtered {
				ts := int64(membershipTS(&u))
				if ts == 0 {
					continue // no expiration date — excluded when range is active
				}
				if fromTS > 0 && ts < fromTS {
					continue
				}
				if toTS > 0 && ts > toTS {
					continue
				}
				r = append(r, u)
			}
			filtered = r
		}

		// Sort
		sortCachedUsers(filtered, c.Query("ordering"))

		// Paginate
		page := 1
		if p, err := strconv.Atoi(c.Query("page")); err == nil && p > 0 {
			page = p
		}
		pageSize := 20
		if ps, err := strconv.Atoi(c.Query("page_size")); err == nil && ps > 0 {
			pageSize = ps
		}

		total := len(filtered)
		totalPages := (total + pageSize - 1) / pageSize
		if totalPages == 0 {
			totalPages = 1
		}
		start := (page - 1) * pageSize
		if start > total {
			start = total
		}
		end := start + pageSize
		if end > total {
			end = total
		}
		pageUsers := filtered[start:end]

		nextPage := 0
		if page < totalPages {
			nextPage = page + 1
		}
		prevPage := 0
		if page > 1 {
			prevPage = page - 1
		}
		startIndex := 0
		endIndex := 0
		if total > 0 {
			startIndex = start + 1
			endIndex = end
		}

		response := authentikUserList{
			Pagination: authentikPagination{
				Count:      total,
				Current:    page,
				TotalPages: totalPages,
				Next:       nextPage,
				Previous:   prevPage,
				StartIndex: startIndex,
				EndIndex:   endIndex,
			},
			Results: pageUsers,
		}
		if response.Results == nil {
			response.Results = []authentikUser{}
		}

		return c.JSON(response)
	}
}

type summaryUser struct {
	PK           int    `json:"pk"`
	Username     string `json:"username"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	MembershipTS int64  `json:"membershipTs"`
}

type summaryResponse struct {
	TotalUsers           int              `json:"totalUsers"`
	ActiveMembers        int              `json:"activeMembers"`
	ExpiredRecently      int              `json:"expiredRecently"`
	ExpiringIn7Days      int              `json:"expiringIn7Days"`
	ExpiredRecentlyUsers []summaryUser    `json:"expiredRecentlyUsers"`
	ExpiringIn7DaysUsers []summaryUser    `json:"expiringIn7DaysUsers"`
	Integrations         integrationStats `json:"integrations"`
}

func handleSummary(cache *userCache, authentikURL string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		token := extractToken(c.Get("Authorization"))
		if token == "" {
			return c.Status(fiber.StatusUnauthorized).SendString("unauthorized")
		}

		users, err := cache.get(token, authentikURL)
		if err != nil {
			return handleCacheError(c, err)
		}

		now := time.Now().Unix()
		sevenDaysAgo := now - 7*86400
		sevenDaysAhead := now + 7*86400

		var resp summaryResponse
		resp.TotalUsers = len(users)
		resp.Integrations = computeIntegrationStats(users)
		for i := range users {
			u := &users[i]
			ts := int64(membershipTS(u))
			if ts == 0 {
				continue
			}
			su := summaryUser{PK: u.PK, Username: u.Username, Name: u.Name, Avatar: u.Avatar, MembershipTS: ts}
			if ts > now {
				resp.ActiveMembers++
			}
			if ts >= sevenDaysAgo && ts < now {
				resp.ExpiredRecently++
				resp.ExpiredRecentlyUsers = append(resp.ExpiredRecentlyUsers, su)
			}
			if ts >= now && ts <= sevenDaysAhead {
				resp.ExpiringIn7Days++
				resp.ExpiringIn7DaysUsers = append(resp.ExpiringIn7DaysUsers, su)
			}
		}

		// Sort and cap user lists
		sort.Slice(resp.ExpiredRecentlyUsers, func(i, j int) bool {
			return resp.ExpiredRecentlyUsers[i].MembershipTS > resp.ExpiredRecentlyUsers[j].MembershipTS
		})
		sort.Slice(resp.ExpiringIn7DaysUsers, func(i, j int) bool {
			return resp.ExpiringIn7DaysUsers[i].MembershipTS < resp.ExpiringIn7DaysUsers[j].MembershipTS
		})
		if len(resp.ExpiredRecentlyUsers) > 5 {
			resp.ExpiredRecentlyUsers = resp.ExpiredRecentlyUsers[:5]
		}
		if len(resp.ExpiringIn7DaysUsers) > 5 {
			resp.ExpiringIn7DaysUsers = resp.ExpiringIn7DaysUsers[:5]
		}

		// Ensure non-null arrays in JSON
		if resp.ExpiredRecentlyUsers == nil {
			resp.ExpiredRecentlyUsers = []summaryUser{}
		}
		if resp.ExpiringIn7DaysUsers == nil {
			resp.ExpiringIn7DaysUsers = []summaryUser{}
		}

		return c.JSON(resp)
	}
}

// sortCachedUsers orders users by the fields the Users table can sort by (the same set Authentik's own list supports there), so a
// search served from the cache keeps working with any column sort. Users without a value (no membership date, never logged in)
// go last in either direction.
func sortCachedUsers(us []authentikUser, ordering string) {
	desc := strings.HasPrefix(ordering, "-")
	field := strings.TrimPrefix(ordering, "-")
	type key struct {
		s  string
		f  float64
		ok bool
	}
	var get func(u *authentikUser) key
	switch field {
	case "membershipExpiration":
		get = func(u *authentikUser) key { ts := membershipTS(u); return key{f: ts, ok: ts != 0} }
	case "username":
		get = func(u *authentikUser) key { return key{s: strings.ToLower(u.Username), ok: true} }
	case "email":
		get = func(u *authentikUser) key { return key{s: strings.ToLower(u.Email), ok: u.Email != ""} }
	case "last_login":
		get = func(u *authentikUser) key {
			if u.LastLogin == nil || *u.LastLogin == "" {
				return key{}
			}
			return key{s: *u.LastLogin, ok: true}
		}
	case "date_joined":
		get = func(u *authentikUser) key { return key{s: u.DateJoined, ok: u.DateJoined != ""} }
	default:
		return
	}
	sort.SliceStable(us, func(i, j int) bool {
		a, b := get(&us[i]), get(&us[j])
		if !a.ok || !b.ok {
			return a.ok && !b.ok
		}
		var less, greater bool
		if field == "membershipExpiration" {
			less, greater = a.f < b.f, a.f > b.f
		} else {
			less, greater = a.s < b.s, a.s > b.s
		}
		if desc {
			return greater
		}
		return less
	})
}
