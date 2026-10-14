package main

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// Matrix / Telegram integration (maintained by the im-inviter bot, see
// https://github.com/HackerspaceKRK/im-inviter, docs/usermanager-integration.md).
//
// Authentik user attributes this file reads (all camelCase):
//   matrixHandles       list of @user:server
//   matrixStatus        "ok" or a description of problems (written by the bot)
//   matrixAccounts      {handle: {state, detail, updated}} (written by the bot)
//   matrixInviteRequests / matrixInviteResults   manual invite queue and its outcomes
//   telegramIDs         list of Telegram numeric IDs (several per user are allowed)
//   telegramUsername    a pending request, cleared by the bot once the account /start-ed it
//   telegramStatus      last result reported by the bot
//   telegramInviteRequests / telegramInviteResults   manual "send group invite links" queue and its outcomes

var listSeparators = regexp.MustCompile(`[\s,;]+`)

// attrStrings reads a list attribute written in any form: a JSON array of strings/numbers
// or a delimited string such as "288245411, 111111111". Order is kept, duplicates and blanks dropped.
func attrStrings(v interface{}) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	addSplit := func(s string) {
		for _, p := range listSeparators.Split(s, -1) {
			add(p)
		}
	}
	switch t := v.(type) {
	case string:
		addSplit(t)
	case float64:
		add(strconv.FormatFloat(t, 'f', -1, 64))
	case []interface{}:
		for _, e := range t {
			switch x := e.(type) {
			case string:
				addSplit(x)
			case float64:
				add(strconv.FormatFloat(x, 'f', -1, 64))
			case json.Number:
				add(x.String())
			}
		}
	}
	return out
}

func attrString(u *authentikUser, key string) string {
	if u.Attributes == nil {
		return ""
	}
	s, _ := u.Attributes[key].(string)
	return strings.TrimSpace(s)
}

func matrixHandlesOf(u *authentikUser) []string {
	if u.Attributes == nil {
		return nil
	}
	return attrStrings(u.Attributes["matrixHandles"])
}

func telegramIDsOf(u *authentikUser) []string {
	if u.Attributes == nil {
		return nil
	}
	return attrStrings(u.Attributes["telegramIDs"])
}

type matrixStats struct {
	Users         int `json:"users"`         // users with at least one Matrix account
	Accounts      int `json:"accounts"`      // all Matrix accounts
	MultiUsers    int `json:"multiUsers"`    // users with two or more Matrix accounts
	MultiAccounts int `json:"multiAccounts"` // how many Matrix accounts those users hold together
	Healthy       int `json:"healthy"`       // matrixStatus == "ok"
	Problems      int `json:"problems"`      // matrixStatus is a problem description
	Unprocessed   int `json:"unprocessed"`   // no matrixStatus yet (the bot has not seen the user)
}

type telegramStats struct {
	Users         int `json:"users"`         // users with at least one Telegram account
	Accounts      int `json:"accounts"`      // all Telegram accounts
	MultiUsers    int `json:"multiUsers"`    // users with two or more Telegram accounts
	MultiAccounts int `json:"multiAccounts"` // how many Telegram accounts those users hold together
	Pending       int `json:"pending"`       // telegramUsername set: waiting for the user to /start the bot
}

// overallStats counts people across messengers, so "how many people" and "how many accounts" are not mixed up:
// a person with two Matrix accounts and one Telegram account is one person and three accounts.
type overallStats struct {
	People        int `json:"people"`        // users with at least one account in any messenger
	Accounts      int `json:"accounts"`      // all Matrix + Telegram accounts
	MultiPeople   int `json:"multiPeople"`   // users with two or more accounts (any messengers)
	MultiAccounts int `json:"multiAccounts"` // how many accounts those users hold together
}

type integrationStats struct {
	Overall  overallStats  `json:"overall"`
	Matrix   matrixStats   `json:"matrix"`
	Telegram telegramStats `json:"telegram"`
}

func computeIntegrationStats(users []authentikUser) integrationStats {
	var st integrationStats
	for i := range users {
		u := &users[i]
		handles, ids := matrixHandlesOf(u), telegramIDsOf(u)
		if total := len(handles) + len(ids); total > 0 {
			st.Overall.People++
			st.Overall.Accounts += total
			if total >= 2 {
				st.Overall.MultiPeople++
				st.Overall.MultiAccounts += total
			}
		}
		if len(handles) > 0 {
			st.Matrix.Users++
			st.Matrix.Accounts += len(handles)
			if len(handles) >= 2 {
				st.Matrix.MultiUsers++
				st.Matrix.MultiAccounts += len(handles)
			}
			switch status := attrString(u, "matrixStatus"); {
			case status == "":
				st.Matrix.Unprocessed++
			case status == "ok":
				st.Matrix.Healthy++
			default:
				st.Matrix.Problems++
			}
		}
		if len(ids) > 0 {
			st.Telegram.Users++
			st.Telegram.Accounts += len(ids)
			if len(ids) >= 2 {
				st.Telegram.MultiUsers++
				st.Telegram.MultiAccounts += len(ids)
			}
		}
		if attrString(u, "telegramUsername") != "" {
			st.Telegram.Pending++
		}
	}
	return st
}

// accountUser is one user on the Invitations page: anyone with at least one messenger account (a Matrix handle,
// a Telegram ID or a pending Telegram @username). The page shows one row per account.
type accountUser struct {
	PK                   int         `json:"pk"`
	Username             string      `json:"username"`
	Name                 string      `json:"name"`
	Avatar               string      `json:"avatar"`
	IsActive             bool        `json:"isActive"`
	MatrixHandles        []string    `json:"matrixHandles"`
	MatrixStatus         string      `json:"matrixStatus"`
	MatrixAccounts       interface{} `json:"matrixAccounts"`
	MatrixInviteRequests interface{} `json:"matrixInviteRequests"`
	MatrixInviteResults  interface{} `json:"matrixInviteResults"`
	TelegramIDs          []string    `json:"telegramIDs"`
	TelegramUsername     string      `json:"telegramUsername"`
	TelegramStatus       string      `json:"telegramStatus"`
	// Manual "send group links" queue for Telegram accounts and its outcomes (written by usermanager / the bot).
	TelegramInviteRequests interface{} `json:"telegramInviteRequests"`
	TelegramInviteResults  interface{} `json:"telegramInviteResults"`
}

func buildAccountUsers(users []authentikUser) []accountUser {
	out := []accountUser{}
	for i := range users {
		u := &users[i]
		handles := matrixHandlesOf(u)
		if len(handles) == 0 && len(telegramIDsOf(u)) == 0 && attrString(u, "telegramUsername") == "" {
			continue
		}
		if handles == nil {
			handles = []string{}
		}
		mu := accountUser{
			PK:               u.PK,
			Username:         u.Username,
			Name:             u.Name,
			Avatar:           u.Avatar,
			IsActive:         u.IsActive,
			MatrixHandles:    handles,
			MatrixStatus:     attrString(u, "matrixStatus"),
			TelegramIDs:      telegramIDsOf(u),
			TelegramUsername: attrString(u, "telegramUsername"),
			TelegramStatus:   attrString(u, "telegramStatus"),
		}
		if mu.TelegramIDs == nil {
			mu.TelegramIDs = []string{}
		}
		if u.Attributes != nil {
			mu.MatrixAccounts = u.Attributes["matrixAccounts"]
			mu.MatrixInviteRequests = u.Attributes["matrixInviteRequests"]
			mu.MatrixInviteResults = u.Attributes["matrixInviteResults"]
			mu.TelegramInviteRequests = u.Attributes["telegramInviteRequests"]
			mu.TelegramInviteResults = u.Attributes["telegramInviteResults"]
		}
		out = append(out, mu)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Username) < strings.ToLower(out[j].Username)
	})
	return out
}

type accountUsersResponse struct {
	Stats integrationStats `json:"stats"`
	Users []accountUser    `json:"users"`
}

// handleAccountUsers serves GET /api/local/account-users from the shared user cache.
// The cache is invalidated whenever any user's last_updated moves (the bot's writes do that).
func handleAccountUsers(cache *userCache, authentikURL string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		token := extractToken(c.Get("Authorization"))
		if token == "" {
			return c.Status(fiber.StatusUnauthorized).SendString("unauthorized")
		}
		users, err := cache.get(token, authentikURL)
		if err != nil {
			return handleCacheError(c, err)
		}
		return c.JSON(accountUsersResponse{
			Stats: computeIntegrationStats(users),
			Users: buildAccountUsers(users),
		})
	}
}
