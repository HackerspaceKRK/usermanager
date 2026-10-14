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
	want := integrationStats{
		Matrix:   matrixStats{Users: 3, Accounts: 4, Healthy: 1, Problems: 1, Unprocessed: 1},
		Telegram: telegramStats{Users: 2, Accounts: 4, Pending: 1},
	}
	if got != want {
		t.Fatalf("stats = %+v, want %+v", got, want)
	}
}

func TestBuildMatrixUsers(t *testing.T) {
	users := []authentikUser{
		user(1, "Zed", map[string]interface{}{"matrixHandles": []interface{}{"@z:x.y"}}),
		user(2, "nohandles", map[string]interface{}{"telegramIDs": []interface{}{"1"}}),
		user(3, "alice", map[string]interface{}{
			"matrixHandles":        []interface{}{"@a:x.y"},
			"matrixAccounts":       map[string]interface{}{"@a:x.y": map[string]interface{}{"state": "joined"}},
			"matrixInviteRequests": []interface{}{map[string]interface{}{"handle": "@a:x.y"}},
		}),
	}
	got := buildMatrixUsers(users)
	if len(got) != 2 {
		t.Fatalf("expected 2 users with Matrix accounts, got %d", len(got))
	}
	if got[0].Username != "alice" || got[1].Username != "Zed" {
		t.Fatalf("expected case-insensitive sort by username, got %q, %q", got[0].Username, got[1].Username)
	}
	if got[0].MatrixAccounts == nil || got[0].MatrixInviteRequests == nil {
		t.Fatalf("bot attributes must be passed through to the UI: %+v", got[0])
	}
	if got[1].TelegramIDs == nil {
		t.Fatalf("telegramIDs must be [] (not null) in JSON")
	}
	if _, err := json.Marshal(matrixUsersResponse{Users: got}); err != nil {
		t.Fatalf("response must be JSON serializable: %v", err)
	}
}

func TestMatrixUsersEndpointAndSummary(t *testing.T) {
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
	app.Get("/api/local/matrix-users", handleMatrixUsers(cache, authentik.URL))
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

	if code := call("/api/local/matrix-users", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing token must be 401, got %d", code)
	}
	if code := call("/api/local/matrix-users", "wrong", nil); code != http.StatusForbidden {
		t.Fatalf("Authentik rejection must be passed through, got %d", code)
	}

	var mu matrixUsersResponse
	if code := call("/api/local/matrix-users", "tok", &mu); code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if len(mu.Users) != 1 || mu.Users[0].Username != "bob" {
		t.Fatalf("only users with Matrix accounts expected, got %+v", mu.Users)
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
