package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeAuthentik serves /api/v3/core/users/ like Authentik: pagination, and ordering=-last_updated (newest first).
type fakeAuthentik struct {
	mu    sync.Mutex
	users []map[string]interface{}
}

func (f *fakeAuthentik) set(pk int, name string, updated time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u := map[string]interface{}{
		"pk": pk, "username": name, "name": name, "is_active": true,
		"last_updated": updated.UTC().Format("2006-01-02T15:04:05.000000Z"), "attributes": map[string]interface{}{},
	}
	for i, e := range f.users {
		if e["pk"] == pk {
			f.users[i] = u
			return
		}
	}
	f.users = append(f.users, u)
}

func (f *fakeAuthentik) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	users := append([]map[string]interface{}(nil), f.users...)
	if r.URL.Query().Get("ordering") == "-last_updated" {
		sort.Slice(users, func(i, j int) bool { return users[i]["last_updated"].(string) > users[j]["last_updated"].(string) })
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if size > 0 && size < len(users) {
		users = users[:size]
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"pagination": map[string]interface{}{"next": 0}, "results": users})
}

func TestUserCacheIsRefreshedWhenAnotherUserChanges(t *testing.T) {
	fa := &fakeAuthentik{}
	srv := httptest.NewServer(http.HandlerFunc(fa.handler))
	defer srv.Close()

	fa.set(1, "alice", time.Now().Add(-time.Hour))
	cache := &userCache{}
	users, err := cache.get("tok", srv.URL)
	if err != nil || len(users) != 1 {
		t.Fatalf("first read: %v, %d users", err, len(users))
	}

	// Something changes in Authentik AFTER the cache was filled.
	time.Sleep(20 * time.Millisecond)
	fa.set(2, "bob", time.Now())

	users, err = cache.get("tok", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 {
		t.Fatalf("cache must be refreshed after a user was created/changed in Authentik, still sees %d user(s)", len(users))
	}
}

func TestUserCacheRefreshesAfterTTLAndAfterClockJump(t *testing.T) {
	for name, cachedAt := range map[string]time.Duration{
		"cache older than TTL":                             -11 * time.Minute,
		"cachedAt in the future (wall clock was set back)": 3 * time.Hour,
	} {
		t.Run(name, func(t *testing.T) {
			fa := &fakeAuthentik{}
			srv := httptest.NewServer(http.HandlerFunc(fa.handler))
			defer srv.Close()
			fa.set(1, "alice", time.Now().Add(-time.Hour))
			cache := &userCache{}
			if _, err := cache.get("tok", srv.URL); err != nil {
				t.Fatal(err)
			}
			cache.cachedAt = time.Now().Add(cachedAt) // simulate the long-running server state
			time.Sleep(20 * time.Millisecond)
			fa.set(2, "bob", time.Now())
			users, err := cache.get("tok", srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			if len(users) != 2 {
				t.Fatalf("%s: stale cache, sees %d user(s) instead of 2", name, len(users))
			}
		})
	}
}

func TestUserCacheDoesNotRefetchWhenNothingChanged(t *testing.T) {
	var full int
	var mu sync.Mutex
	fa := &fakeAuthentik{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page_size") == "100" {
			mu.Lock()
			full++
			mu.Unlock()
		}
		fa.handler(w, r)
	}))
	defer srv.Close()
	fa.set(1, "alice", time.Now().Add(-time.Hour))
	cache := &userCache{}
	for i := 0; i < 5; i++ {
		if _, err := cache.get("tok", srv.URL); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if full != 1 {
		t.Fatalf("the cache must serve unchanged data without refetching everything, full fetches: %d", full)
	}
}

func TestUserCacheDetectsChangeEvenIfServerClockIsBehindAuthentik(t *testing.T) {
	fa := &fakeAuthentik{}
	srv := httptest.NewServer(http.HandlerFunc(fa.handler))
	defer srv.Close()
	// Authentik's timestamps are two hours AHEAD of this server's clock: comparing them with time.Now() would hide
	// every later change. Comparing Authentik's timestamps with each other does not.
	ahead := time.Now().Add(2 * time.Hour)
	fa.set(1, "alice", ahead)
	cache := &userCache{}
	if _, err := cache.get("tok", srv.URL); err != nil {
		t.Fatal(err)
	}
	fa.set(2, "bob", ahead.Add(time.Minute))
	users, err := cache.get("tok", srv.URL)
	if err != nil || len(users) != 2 {
		t.Fatalf("change not detected under clock skew: %v, %d user(s)", err, len(users))
	}
}
