package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestAttrStrings(t *testing.T) {
	cases := []struct {
		name string
		in   interface{}
		want []string
	}{
		{"nil", nil, nil},
		{"array of strings", []interface{}{"288245411", "111111111"}, []string{"288245411", "111111111"}},
		{"array of numbers", []interface{}{float64(288245411), json.Number("111111111")}, []string{"288245411", "111111111"}},
		{"comma string", "288245411, 111111111", []string{"288245411", "111111111"}},
		{"mixed separators", "1;2  3,4", []string{"1", "2", "3", "4"}},
		{"duplicates and blanks", []interface{}{"1", "", " 1 ", "2"}, []string{"1", "2"}},
		{"single number", float64(5), []string{"5"}},
		{"case is preserved (Matrix user names are case-sensitive)", []interface{}{"@Jan:x.y", "@jan:x.y"}, []string{"@Jan:x.y", "@jan:x.y"}},
		{"unsupported type", true, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := attrStrings(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("attrStrings(%v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func user(pk int, name string, attrs map[string]interface{}) authentikUser {
	return authentikUser{PK: pk, Username: name, Name: name, IsActive: true, Attributes: attrs}
}

func TestComputeIntegrationStats(t *testing.T) {
	users := []authentikUser{
		user(1, "ok", map[string]interface{}{
			"matrixHandles": []interface{}{"@a:x.y", "@b:x.y"}, "matrixStatus": "ok",
			"telegramIDs": []interface{}{"1", "2"},
		}),
		user(2, "problem", map[string]interface{}{
			"matrixHandles": []interface{}{"@c:x.y"}, "matrixStatus": "@c:x.y has a ban in Room",
			"telegramUsername": "@pending_user",
		}),
		user(3, "fresh", map[string]interface{}{"matrixHandles": "@d:x.y"}),                      // bot has not seen it yet
		user(4, "tg-only-string", map[string]interface{}{"telegramIDs": "288245411, 111111111"}), // string form
		user(5, "nothing", nil),
		user(6, "empty", map[string]interface{}{"matrixHandles": []interface{}{}, "telegramIDs": []interface{}{}}),
	}
	got := computeIntegrationStats(users)
	// ok: 2 Matrix + 2 Telegram; problem: 1 Matrix; fresh: 1 Matrix; tg-only-string: 2 Telegram.
	want := integrationStats{
		// "ok" (4 accounts, both messengers) and "tg-only-string" (2) are multi; problem/fresh are Matrix only.
		Overall:  overallStats{People: 4, Accounts: 8, MultiPeople: 2, MultiAccounts: 6, BothMessengers: 1, OnlyMatrix: 2, OnlyTelegram: 1},
		Matrix:   matrixStats{Users: 3, Accounts: 4, MultiUsers: 1, MultiAccounts: 2, Healthy: 1, Problems: 1, Unprocessed: 1},
		Telegram: telegramStats{Users: 2, Accounts: 4, MultiUsers: 2, MultiAccounts: 4, Pending: 1},
	}
	if got != want {
		t.Fatalf("stats = %+v, want %+v", got, want)
	}
}

func TestBuildAccountUsers(t *testing.T) {
	users := []authentikUser{
		user(1, "Zed", map[string]interface{}{"matrixHandles": []interface{}{"@z:x.y"}}),
		user(2, "nohandles", map[string]interface{}{"telegramIDs": []interface{}{"1"}}),
		user(3, "alice", map[string]interface{}{
			"matrixHandles":        []interface{}{"@a:x.y"},
			"matrixAccounts":       map[string]interface{}{"@a:x.y": map[string]interface{}{"state": "joined"}},
			"matrixInviteRequests": []interface{}{map[string]interface{}{"handle": "@a:x.y"}},
		}),
	}
	users = append(users,
		user(4, "tg-only", map[string]interface{}{"telegramIDs": "288245411, 111111111"}),
		user(5, "pending-only", map[string]interface{}{"telegramUsername": "@jan_tg"}),
		user(6, "nothing", map[string]interface{}{"mifareCardId": []interface{}{"x"}}),
	)
	got := buildAccountUsers(users)
	names := []string{}
	for _, g := range got {
		names = append(names, g.Username)
	}
	// Anyone with a Matrix handle, a Telegram ID or a pending Telegram @username; sorted case-insensitively.
	if !reflect.DeepEqual(names, []string{"alice", "nohandles", "pending-only", "tg-only", "Zed"}) {
		t.Fatalf("unexpected users on the Invitations page: %v", names)
	}
	for _, g := range got {
		if g.MatrixHandles == nil {
			t.Fatalf("matrixHandles must be [] (not null) for %s", g.Username)
		}
	}
	if got[0].MatrixAccounts == nil || got[0].MatrixInviteRequests == nil {
		t.Fatalf("bot attributes must be passed through to the UI: %+v", got[0])
	}
	if got[4].TelegramIDs == nil {
		t.Fatalf("telegramIDs must be [] (not null) in JSON")
	}
	if _, err := json.Marshal(accountUsersResponse{Users: got}); err != nil {
		t.Fatalf("response must be JSON serializable: %v", err)
	}
}

func TestAccountUsersEndpointAndSummary(t *testing.T) {
	authentik := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"pagination": map[string]interface{}{"next": 0},
			"results": []map[string]interface{}{
				{"pk": 1, "username": "bob", "name": "Bob", "is_active": true, "attributes": map[string]interface{}{
					"matrixHandles": []string{"@bob:x.y"}, "matrixStatus": "ok", "telegramIDs": "288245411, 111111111",
					"matrixAccounts": map[string]interface{}{"@bob:x.y": map[string]interface{}{"state": "joined", "detail": "", "updated": 1}},
				}},
				{"pk": 2, "username": "plain", "name": "Plain", "is_active": true, "attributes": map[string]interface{}{}},
			},
		})
	}))
	defer authentik.Close()

	app := fiber.New()
	cache := &userCache{}
	app.Get("/api/local/account-users", handleAccountUsers(cache, authentik.URL))
	app.Get("/api/local/summary", handleSummary(cache, authentik.URL))

	call := func(path, token string, out interface{}) int {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if out != nil && resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}

	if code := call("/api/local/account-users", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing token must be 401, got %d", code)
	}
	if code := call("/api/local/account-users", "wrong", nil); code != http.StatusForbidden {
		t.Fatalf("Authentik rejection must be passed through, got %d", code)
	}

	var mu accountUsersResponse
	if code := call("/api/local/account-users", "tok", &mu); code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if len(mu.Users) != 1 || mu.Users[0].Username != "bob" {
		t.Fatalf("only users with messenger accounts expected, got %+v", mu.Users)
	}
	if !reflect.DeepEqual(mu.Users[0].TelegramIDs, []string{"288245411", "111111111"}) {
		t.Fatalf("telegramIDs stored as a string must be split: %v", mu.Users[0].TelegramIDs)
	}
	if mu.Stats.Matrix.Healthy != 1 || mu.Stats.Telegram.Accounts != 2 {
		t.Fatalf("unexpected stats: %+v", mu.Stats)
	}

	var sum summaryResponse
	if code := call("/api/local/summary", "tok", &sum); code != http.StatusOK {
		t.Fatalf("summary: expected 200, got %d", code)
	}
	if sum.TotalUsers != 2 || sum.Integrations.Matrix.Users != 1 || sum.Integrations.Telegram.Users != 1 {
		t.Fatalf("summary must carry integration stats: %+v", sum)
	}
}

func TestOverallStatsDistinguishPeopleFromAccounts(t *testing.T) {
	users := []authentikUser{
		user(1, "single-matrix", map[string]interface{}{"matrixHandles": []interface{}{"@a:x.y"}}),
		user(2, "single-telegram", map[string]interface{}{"telegramIDs": []interface{}{"1"}}),
		user(3, "two-matrix", map[string]interface{}{"matrixHandles": []interface{}{"@b:x.y", "@c:x.y"}}),
		user(4, "one-each", map[string]interface{}{"matrixHandles": []interface{}{"@d:x.y"}, "telegramIDs": []interface{}{"2"}}),
		user(5, "pending-only", map[string]interface{}{"telegramUsername": "@x_tg"}), // a request, not an account
		user(6, "nothing", nil),
	}
	got := computeIntegrationStats(users).Overall
	want := overallStats{People: 4, Accounts: 6, MultiPeople: 2, MultiAccounts: 4, BothMessengers: 1, OnlyMatrix: 2, OnlyTelegram: 1}
	if got != want {
		t.Fatalf("overall = %+v, want %+v", got, want)
	}
}

func TestBuildMissingUsers(t *testing.T) {
	const now = int64(1_800_000_000)
	member := func(pk int, name string, ts float64, attrs map[string]interface{}) authentikUser {
		if attrs == nil {
			attrs = map[string]interface{}{}
		}
		attrs["membershipExpirationTimestamp"] = ts
		return user(pk, name, attrs)
	}
	inactive := member(7, "inactive", float64(now+100), nil)
	inactive.IsActive = false
	service := member(8, "svc", float64(now+100), nil)
	service.Type = "service_account"
	users := []authentikUser{
		member(1, "zed", float64(now+100), nil),                                                 // member, no accounts -> listed
		member(2, "Alice", float64(now+100), map[string]interface{}{"telegramUsername": "@al"}), // pending request only -> listed with hint
		member(3, "expired", float64(now-1), nil),                                               // expired
		member(4, "expires-now", float64(now), nil),                                             // exactly now = expired (same rule as the dashboard)
		member(5, "has-matrix", float64(now+100), map[string]interface{}{"matrixHandles": []interface{}{"@a:x.y"}}),
		member(6, "has-tg", float64(now+100), map[string]interface{}{"telegramIDs": "1, 2"}),
		inactive,
		service,
		user(9, "no-membership-date", nil), // never had a membership date -> not a member
	}
	got := buildMissingUsers(users, now)
	names := []string{}
	for _, g := range got {
		names = append(names, g.Username)
	}
	if !reflect.DeepEqual(names, []string{"Alice", "zed"}) {
		t.Fatalf("unexpected members without accounts: %v", names)
	}
	if got[0].TelegramUsername != "@al" || got[0].MembershipTS != now+100 {
		t.Fatalf("hint and membership timestamp must be passed through: %+v", got[0])
	}
}

func TestTelegramReachableIDsPassThrough(t *testing.T) {
	users := []authentikUser{
		user(1, "unknown", map[string]interface{}{"telegramIDs": []interface{}{"1"}}),
		user(2, "known", map[string]interface{}{"telegramIDs": []interface{}{"2", "3"}, "telegramReachableIDs": []interface{}{"2"}}),
		user(3, "none-reachable", map[string]interface{}{"telegramIDs": []interface{}{"4"}, "telegramReachableIDs": []interface{}{}}),
	}
	got := buildAccountUsers(users)
	byName := map[string]accountUser{}
	for _, g := range got {
		byName[g.Username] = g
	}
	if byName["unknown"].TelegramReachableIDs != nil {
		t.Fatalf("absent attribute must stay null (= unknown): %+v", byName["unknown"].TelegramReachableIDs)
	}
	if !reflect.DeepEqual(byName["known"].TelegramReachableIDs, []string{"2"}) {
		t.Fatalf("reachable ids not passed: %+v", byName["known"].TelegramReachableIDs)
	}
	if r := byName["none-reachable"].TelegramReachableIDs; r == nil || len(r) != 0 {
		t.Fatalf("empty list must stay [] (nothing reachable), got %#v", r)
	}
}
