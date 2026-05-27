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
}

func (c *userCache) get(token, authentikURL string) ([]authentikUser, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	cacheValid := len(c.users) > 0 && time.Since(c.cachedAt) < cacheTTL

	if cacheValid {
		// Validate token and detect changes in one request
		page1, err := fetchUsersPage(token, authentikURL, 1, 1, "-last_updated")
		if err != nil {
			return nil, err
		}
		if len(page1.Results) > 0 {
			if t, err := time.Parse(time.RFC3339, page1.Results[0].LastUpdated); err == nil {
				if t.After(c.cachedAt) {
					c.users = nil // something changed, invalidate
				}
			}
		}
	}

	if len(c.users) == 0 {
		all, err := fetchAllUsers(token, authentikURL)
		if err != nil {
			return nil, err
		}
		c.users = all
		c.cachedAt = time.Now()
	}

	return c.users, nil
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
				strings.Contains(strings.ToLower(u.Email), search) {
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
		ordering := c.Query("ordering")
		desc := strings.HasPrefix(ordering, "-")
		field := strings.TrimPrefix(ordering, "-")
		if field == "membershipExpiration" {
			sort.SliceStable(filtered, func(i, j int) bool {
				ti := membershipTS(&filtered[i])
				tj := membershipTS(&filtered[j])
				// no-timestamp users go last regardless of direction
				if ti == 0 && tj == 0 {
					return false
				}
				if ti == 0 {
					return false
				}
				if tj == 0 {
					return true
				}
				if desc {
					return ti > tj
				}
				return ti < tj
			})
		}

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
	TotalUsers           int           `json:"totalUsers"`
	ActiveMembers        int           `json:"activeMembers"`
	ExpiredRecently      int           `json:"expiredRecently"`
	ExpiringIn7Days      int           `json:"expiringIn7Days"`
	ExpiredRecentlyUsers []summaryUser `json:"expiredRecentlyUsers"`
	ExpiringIn7DaysUsers []summaryUser `json:"expiringIn7DaysUsers"`
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
