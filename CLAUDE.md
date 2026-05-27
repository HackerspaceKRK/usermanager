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

There are no automated tests. Verify changes by running `go build ./...` and `npm run build`.

## Architecture

This is a single-binary admin UI for managing [Authentik](https://goauthentik.io) users. A Go HTTP server embeds the compiled React frontend and proxies Authentik API calls.

### Go backend (`main.go`, `scan.go`, `usercache.go`)

- **`main.go`** — sets up routes and starts the server. In production, serves embedded `dist/` and dynamically generates `/config.js` from env vars. In `-dev` mode, spawns `npm run dev` and proxies everything to Vite.
- **`scan.go`** — WebSocket relay (`/ws/scan`, `/ws/scan/{id}`) that pairs a desktop NFC reader with a mobile browser for Mifare card scanning.
- **`usercache.go`** — in-memory cache of all Authentik users (10-minute TTL). Exposes `/api/local/cached-users` (filterable/sortable by `membershipExpiration`) and `/api/local/summary` (membership stats). On each cache access within TTL, fetches 1 user ordered by `-last_updated` to validate the token and detect changes. All `/api/v3/*` requests are reverse-proxied directly to Authentik.

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

**Key hooks:**
- `useAuth()` — token + logout from `AuthContext`
- `useMe(token)` — fetches the current user once
- `useGroups(token)` — fetches all groups, returns a `Map<uuid, name>`
