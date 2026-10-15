# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend
npm run build       # TypeScript typecheck + Vite production build
npm run lint        # oxlint (fast Rust-based linter)
npm run dev         # Vite dev server on :5173 (use with Go dev mode below)

# Backend
go build ./...      # compile all Go packages
go run .            # run server (production mode, requires dist/ to exist)
go run . -dev       # dev mode: spawns Vite and proxies to it on :5173

# Docker
docker build -t usermanager .
```

Go has a small test suite (`go test ./...`, see `integrations_test.go`); the frontend has none. Verify changes by running
`go vet ./... && go test ./...`, `npm run build`, `npm run lint` and `npx tsc -b --noEmit` (what CI runs).
Use `go build -o /dev/null ./...`: a plain `go build ./...` overwrites the `usermanager` binary tracked in this repo.

## Architecture

This is a single-binary admin UI for managing [Authentik](https://goauthentik.io) users. A Go HTTP server embeds the compiled React frontend and proxies Authentik API calls.

### Go backend (`main.go`, `scan.go`, `usercache.go`, `integrations.go`)

- **`main.go`** — sets up routes and starts the server. In production, serves embedded `dist/` and dynamically generates `/config.js` from env vars. In `-dev` mode, spawns `npm run dev` and proxies everything to Vite.
- **`scan.go`** — WebSocket relay (`/ws/scan`, `/ws/scan/{id}`) that pairs a desktop NFC reader with a mobile browser for Mifare card scanning.
- **`usercache.go`** — in-memory cache of all Authentik users (10-minute TTL). Exposes `/api/local/cached-users` (filterable/sortable by `membershipExpiration`) and `/api/local/summary` (membership stats). On each cache access within TTL, fetches 1 user ordered by `-last_updated` to validate the token and detect changes. A change is detected by comparing that user's `last_updated` with the newest `last_updated` seen when the cache was filled (Authentik's timestamps against each other, never against this server's clock). A cache older than the TTL, or one that cannot be verified, is refetched (see `usercache_test.go`). All `/api/v3/*` requests are reverse-proxied directly to Authentik.

- **`integrations.go`** — Matrix/Telegram integration, a read-only view of attributes maintained by the
  [im-inviter](https://github.com/HackerspaceKRK/im-inviter) bot (contract: its `docs/usermanager-integration.md`).
  `computeIntegrationStats` feeds `integrations` in `/api/local/summary`; `/api/local/account-users` lists users that have any
  messenger account (`matrixHandles`, `telegramIDs` or a pending `telegramUsername`) with the bot's `matrixAccounts` and
  the manual-invite queues/results (`matrixInvite*`, `telegramInvite*`). List attributes
  (`matrixHandles`, `telegramIDs`) may be stored as a JSON array or as a string like `"288245411, 111111111"`;
  `attrStrings` (Go) and `listAttr` (TS) read both.

**Environment variables:**
- `AUTHENTIK_URL` (default: `https://auth.hskrk.pl`)
- `OAUTH_CLIENT_ID` (required)

**Authentik API schema:** `curl https://auth.hskrk.pl/api/v3/schema/` (OpenAPI 3.0)

### React frontend (`src/`)

**Config:** `src/config.ts` reads from `window.APP_CONFIG` (injected by Go's `/config.js` in production) with fallback to `VITE_AUTHENTIK_URL` / `VITE_CLIENT_ID` env vars for pure Vite dev.

**Auth flow** (`src/auth/AuthContext.tsx`): OAuth 2.0 + PKCE with `offline_access` scope so Authentik issues long-lived refresh tokens. Tokens stored in `localStorage` (`um_access_token`, `um_refresh_token`, `um_token_expiry`). Proactive refresh fires 60 s before expiry via `setTimeout`; a `visibilitychange` listener catches sleep/wake cases where timers freeze.

**API layer** (`src/api/authentik.ts`): All calls go to `/api/v3/` (proxied to Authentik) or `/api/local/` (handled locally by Go). The `getMe` response wraps the user under a `user` key — the function unwraps it.

**Pages** (`src/pages/`): `UsersPage` uses TanStack Table with manual pagination/sorting; sorting by `membershipExpiration` switches the fetcher to `listCachedUsers` (the local cached endpoint). `EditUserPage` handles both create (`/users/edit/new`) and edit (`/users/edit/:id`) with timezone-aware membership date handling (Europe/Warsaw).

**UI components** (`src/components/ui/`): shadcn/ui style components built on Radix UI primitives + Tailwind CSS v4. The `combobox.tsx` uses `@base-ui/react` (not the standard shadcn registry component). The `@` alias maps to `src/`.

**Attributes and PATCH:** Authentik replaces the WHOLE `attributes` object on `PATCH /core/users/{id}/`. Never send a
partial object: start from the user's loaded attributes and overwrite only the keys you manage (`mergeAttributes` in
`EditUserPage`, `requestMatrixInvite` in the API layer). Otherwise attributes of other tools (bot statuses, Authentik
settings, ...) are wiped. Attribute naming is camelCase (`telegramIDs`, `matrixHandles`, ...).

**Manual invites:** the Invitations page is one table with a row per account of any messenger (user, account, state, last
manual invite, action). Invite appends `{handle|id, by, ts}` to the user's `matrixInviteRequests` (Matrix: invite to every
configured room/space) or `telegramInviteRequests` (Telegram: send fresh group invite links in a DM); the bot executes it on
its next run (about a minute) and writes the outcome to `matrixInviteResults` / `telegramInviteResults`. The page polls
while a request is queued. The bot only honors accounts on that user's own lists, and no Matrix/Telegram credentials live here.

**Discovered Telegram nicks:** the bot writes `telegramAccounts` ({ID: {username, name, updated}}) for IDs it has seen; the Invitations page
shows `@nick` (or the name when the account has none) muted next to the ID and the search box matches it. Display only, nothing here writes it.

**Telegram reachability:** a Telegram bot cannot message anyone first, so Invite is hidden for a Telegram ID with no trace of
contact with the bot (e.g. an ID added by hand). The ID itself is trusted: this is only a muted side note, not a warning. Rule (`telegramReachable` in `InvitationsPage.tsx`): reachable if the ID is in
the bot-written `telegramReachableIDs`; if that attribute is absent, the account counts as reachable only when the user has
`telegramStatus` (linked by the bot before the attribute existed). The bot records contact when the account writes to it
(`/start`, `/grupy`, button, code); it never probes unknown accounts. `/api/local/account-users` also returns `missing`
(active, non-expired members with no Matrix handle and no Telegram ID, via `buildMissingUsers`) and the overall stats split
people into both messengers / only Matrix / only Telegram.

**Key hooks:**
- `useAuth()` — token + logout from `AuthContext`
- `useMe(token)` — fetches the current user once
- `useGroups(token)` — fetches all groups, returns a `Map<uuid, name>`
