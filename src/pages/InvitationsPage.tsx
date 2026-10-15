import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { format, formatDistanceToNow } from "date-fns"
import { Loader2Icon, RefreshCwIcon, SearchIcon, SendIcon } from "lucide-react"
import { useAuth } from "@/auth/AuthContext"
import { useMe } from "@/hooks/useMe"
import { listAccountUsers, requestMatrixInvite, requestTelegramInvite } from "@/api/authentik"
import type { AccountUser, AccountUsersResponse, MissingUser } from "@/api/authentik"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MatrixAccountBadge, TelegramAccountBadge, isProblemState } from "@/components/IntegrationBadges"
import { MembershipBadge } from "@/components/MembershipBadge"

const POLL_MS = 5000 // how often we re-read while a manual invite is waiting for the bot
const WAIT_TIMEOUT_S = 180 // stop waiting for the bot after this long

type AccountKind = "matrix" | "telegram"

/** One account of a user in any messenger; the table shows one row per account. */
interface AccountRow {
  key: string // unique per user: "<kind>:<id>" (a pending @username request uses "telegram-request:<@name>")
  kind: AccountKind
  id: string // Matrix handle, Telegram ID, or the @username of a pending Telegram request
  pendingUsername: boolean // a Telegram @username that has not sent /start yet (nothing to invite)
  // A Telegram ID with no trace of ever writing to the bot (e.g. added by hand): the ID is trusted, but the bot cannot DM it yet.
  unreachable: boolean
}

interface LastResult {
  ts: number
  by: string
  result: string
}

function initials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  }
  return (name[0] ?? username[0] ?? "?").toUpperCase()
}

/**
 * Can the bot DM this Telegram ID? Only accounts that wrote to it (the bot records them in telegramReachableIDs).
 * Accounts linked by the bot before that attribute existed have no list but do have telegramStatus: treat them as reachable.
 * No list and no status = the ID was typed in by hand and never talked to the bot.
 */
function telegramReachable(u: AccountUser, id: string): boolean {
  if (u.telegramReachableIDs != null) return u.telegramReachableIDs.includes(id)
  return u.telegramStatus !== ""
}

function accountRows(u: AccountUser): AccountRow[] {
  const rows: AccountRow[] = u.matrixHandles.map((h) => ({
    key: `matrix:${h}`, kind: "matrix", id: h, pendingUsername: false, unreachable: false,
  }))
  for (const id of u.telegramIDs) {
    rows.push({
      key: `telegram:${id}`, kind: "telegram", id, pendingUsername: false,
      unreachable: !telegramReachable(u, id),
    })
  }
  if (u.telegramUsername) {
    rows.push({
      key: `telegram-request:${u.telegramUsername}`, kind: "telegram", id: u.telegramUsername, pendingUsername: true,
      unreachable: false,
    })
  }
  return rows
}

function lastResult(u: AccountUser, row: AccountRow): LastResult | undefined {
  if (row.pendingUsername) return undefined
  const results =
    row.kind === "matrix"
      ? (u.matrixInviteResults ?? []).filter((r) => r.handle === row.id)
      : (u.telegramInviteResults ?? []).filter((r) => r.id === row.id)
  const last = results[results.length - 1]
  return last ? { ts: last.ts, by: last.by, result: last.result } : undefined
}

function isQueued(u: AccountUser, row: AccountRow): boolean {
  return row.kind === "matrix"
    ? (u.matrixInviteRequests ?? []).some((r) => r.handle === row.id)
    : (u.telegramInviteRequests ?? []).some((r) => r.id === row.id)
}

function hasProblem(u: AccountUser): boolean {
  if (u.matrixStatus && u.matrixStatus !== "ok") return true
  if (u.telegramStatus && u.telegramStatus !== "ok") return true
  return u.matrixHandles.some((h) => {
    const account = u.matrixAccounts?.[h]
    return account !== undefined && isProblemState(account.state)
  })
}

/** "pk:<kind>:<id>" -> parts (the id of a Matrix account itself contains ":"). */
function parseWaitingKey(key: string): { pk: string; kind: string; id: string } {
  const [pk = "", kind = "", ...rest] = key.split(":")
  return { pk, kind, id: rest.join(":") }
}

function renderKind(row: AccountRow) {
  return (
    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide shrink-0">
      {row.kind === "matrix" ? "Matrix" : "Telegram"}
    </Badge>
  )
}

function renderState(u: AccountUser, row: AccountRow) {
  return row.kind === "matrix" ? (
    <MatrixAccountBadge account={u.matrixAccounts?.[row.id]} />
  ) : (
    <TelegramAccountBadge pending={row.pendingUsername} unreachable={row.unreachable} />
  )
}

export function InvitationsPage() {
  const { token } = useAuth()
  const me = useMe(token)
  const [data, setData] = useState<AccountUsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [onlyProblems, setOnlyProblems] = useState(false)
  // "pk:<account key>" -> unix seconds when an admin clicked Invite; cleared once the bot reports a result.
  const [waiting, setWaiting] = useState<Record<string, number>>({})
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [inviteError, setInviteError] = useState<string | null>(null)

  const load = useCallback(
    async (silent: boolean) => {
      if (!token) return
      if (!silent) setLoading(true)
      try {
        setData(await listAccountUsers(token))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  // Drop "waiting" entries once the bot has reported back (request gone and a fresh result present) or on timeout.
  useEffect(() => {
    if (!data) return
    const now = Math.floor(Date.now() / 1000)
    setWaiting((prev) => {
      const next: Record<string, number> = {}
      for (const [key, queuedAt] of Object.entries(prev)) {
        const { pk, kind, id } = parseWaitingKey(key)
        const u = data.users.find((x) => String(x.pk) === pk)
        const row = u && accountRows(u).find((r) => r.kind === (kind === "matrix" ? "matrix" : "telegram") && r.id === id)
        const result = u && row ? lastResult(u, row) : undefined
        const stillQueued = u && row ? isQueued(u, row) : false
        const reported = !!result && result.ts >= queuedAt - 5
        const timedOut = now - queuedAt > WAIT_TIMEOUT_S
        if ((reported && !stillQueued) || timedOut) continue
        next[key] = queuedAt
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [data])

  const anyQueued =
    Object.keys(waiting).length > 0 ||
    (data?.users.some(
      (u) => (u.matrixInviteRequests?.length ?? 0) > 0 || (u.telegramInviteRequests?.length ?? 0) > 0,
    ) ?? false)

  useEffect(() => {
    if (!anyQueued) return
    const t = setInterval(() => void load(true), POLL_MS)
    return () => clearInterval(t)
  }, [anyQueued, load])

  async function invite(u: AccountUser, row: AccountRow) {
    if (!token || !me || row.pendingUsername || row.unreachable) return
    const key = `${u.pk}:${row.key}`
    setSending((prev) => ({ ...prev, [key]: true }))
    setInviteError(null)
    try {
      if (row.kind === "matrix") await requestMatrixInvite(token, u.pk, row.id, me.username)
      else await requestTelegramInvite(token, u.pk, row.id, me.username)
      setWaiting((prev) => ({ ...prev, [key]: Math.floor(Date.now() / 1000) }))
      void load(true)
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const users = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.users ?? []).filter((u) => {
      if (onlyProblems && !hasProblem(u)) return false
      if (!q) return true
      return (
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        accountRows(u).some((r) => r.id.toLowerCase().includes(q))
      )
    })
  }, [data, search, onlyProblems])

  // Shared by the table (lg and up) and the cards (phones and tablets), so the invite logic lives in one place.
  function renderUserInfo(u: AccountUser) {
    return (
      <>
        <Avatar>
          <AvatarImage src={u.avatar} alt={u.name} />
          <AvatarFallback>{initials(u.name, u.username)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <Link to={`/users/edit/${u.pk}`} className="font-medium leading-tight hover:underline">
            {u.username}
          </Link>
          {!u.isActive && <div className="text-xs text-muted-foreground">inactive</div>}
          {u.name !== u.username && <div className="text-xs text-muted-foreground leading-tight mt-0.5">{u.name}</div>}
          {u.matrixStatus && u.matrixStatus !== "ok" && (
            <div className="mt-1 text-xs text-amber-600 dark:text-amber-400 line-clamp-2" title={u.matrixStatus}>
              Matrix: {u.matrixStatus}
            </div>
          )}
          {u.telegramStatus && u.telegramStatus !== "ok" && (
            <div className="mt-1 text-xs text-destructive line-clamp-2" title={u.telegramStatus}>
              Telegram: {u.telegramStatus}
            </div>
          )}
        </div>
      </>
    )
  }

  function renderLast(u: AccountUser, row: AccountRow) {
    const result = lastResult(u, row)
    if (!result) return <span className="text-muted-foreground">—</span>
    const ok = result.result.startsWith("ok")
    return (
      <div title={result.result}>
        <div className={`line-clamp-2 break-words ${ok ? "" : "text-destructive"}`}>{result.result}</div>
        <div className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(result.ts * 1000), { addSuffix: true })} ·{" "}
          {format(new Date(result.ts * 1000), "yyyy-MM-dd HH:mm")} · by {result.by}
        </div>
      </div>
    )
  }

  function renderAction(u: AccountUser, row: AccountRow) {
    if (row.pendingUsername) {
      return (
        <span className="text-xs text-muted-foreground" title="Nothing to invite yet: this account has to send /start to the bot first">
          —
        </span>
      )
    }
    if (row.unreachable) {
      return (
        <span
          className="text-xs text-muted-foreground"
          title="Telegram bots cannot message someone first: Invite becomes available once this account writes to the bot (/start, /grupy or /verify)"
        >
          —
        </span>
      )
    }
    const key = `${u.pk}:${row.key}`
    const queued = key in waiting || isQueued(u, row)
    const busy = !!sending[key]
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={!me || busy || queued}
        title={
          row.kind === "matrix"
            ? "Invite this account to every configured room and space"
            : "Send fresh one-time group invite links to this account in a DM"
        }
        onClick={() => void invite(u, row)}
      >
        {busy || queued ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
        {queued ? "Queued…" : "Invite"}
      </Button>
    )
  }

  function renderMissing(m: MissingUser) {
    return (
      <li key={m.pk} className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar>
            <AvatarImage src={m.avatar} alt={m.name} />
            <AvatarFallback>{initials(m.name, m.username)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <Link to={`/users/edit/${m.pk}`} className="font-medium leading-tight hover:underline">
              {m.username}
            </Link>
            {m.name !== m.username && <div className="text-xs text-muted-foreground leading-tight">{m.name}</div>}
            {m.telegramUsername && (
              <div className="text-xs text-muted-foreground">Telegram request: {m.telegramUsername}</div>
            )}
          </div>
        </div>
        <MembershipBadge ts={m.membershipTS} compact />
      </li>
    )
  }

  const emptyText =
    data && data.users.length > 0 ? "No users match the filters." : "No users have Matrix or Telegram accounts yet."

  const stats = data?.stats
  const missing = data?.missing ?? []
  const missingShown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return missing.filter((m) => !q || m.username.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [missing, search])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Invitations</h1>
        <Button variant="outline" size="sm" onClick={() => void load(false)} disabled={loading}>
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-2 text-sm border border-destructive/20">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-5 space-y-1">
          <div className="text-sm font-medium text-muted-foreground">People with an account</div>
          {loading || !stats ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <>
              <div className="text-3xl font-bold">{stats.overall.people} people</div>
              <div className="text-sm text-muted-foreground">
                {stats.overall.accounts} accounts in total. {stats.overall.multiPeople} of those people have several
                accounts ({stats.overall.multiAccounts} accounts together).
              </div>
              <div className="text-sm text-muted-foreground">
                {stats.overall.bothMessengers} on both · {stats.overall.onlyMatrix} only Matrix ·{" "}
                {stats.overall.onlyTelegram} only Telegram
              </div>
              {missing.length > 0 && (
                <div className="text-sm text-amber-600 dark:text-amber-400">
                  {missing.length} active {missing.length === 1 ? "member has" : "members have"} neither
                </div>
              )}
            </>
          )}
        </div>
        <div className="rounded-xl border bg-card p-5 space-y-1">
          <div className="text-sm font-medium text-muted-foreground">Matrix</div>
          {loading || !stats ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <>
              <div className="text-3xl font-bold">{stats.matrix.users} users</div>
              <div className="text-sm text-muted-foreground">
                {stats.matrix.accounts} accounts, {stats.matrix.multiUsers} users with several (
                {stats.matrix.multiAccounts} accounts)
              </div>
              <div className="text-sm text-muted-foreground">
                {stats.matrix.healthy} OK ·{" "}
                <span className={stats.matrix.problems > 0 ? "text-amber-600 dark:text-amber-400" : ""}>
                  {stats.matrix.problems} with problems
                </span>
                {stats.matrix.unprocessed > 0 && ` · ${stats.matrix.unprocessed} not processed yet`}
              </div>
            </>
          )}
        </div>
        <div className="rounded-xl border bg-card p-5 space-y-1">
          <div className="text-sm font-medium text-muted-foreground">Telegram</div>
          {loading || !stats ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <>
              <div className="text-3xl font-bold">{stats.telegram.users} users</div>
              <div className="text-sm text-muted-foreground">
                {stats.telegram.accounts} accounts, {stats.telegram.multiUsers} users with several (
                {stats.telegram.multiAccounts} accounts)
              </div>
              <div className="text-sm text-muted-foreground">{stats.telegram.pending} waiting for /start</div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm w-full">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by user or account..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant={onlyProblems ? "default" : "outline"} size="sm" onClick={() => setOnlyProblems((v) => !v)}>
          Only with problems
        </Button>
      </div>

      {inviteError && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-2 text-sm border border-destructive/20">
          Could not queue the invite: {inviteError}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Invite on a Matrix account sends it to every configured room and space, ignoring an earlier decline. On a Telegram
        account it sends fresh one-time group invite links in a DM: Telegram bots cannot message anyone first, so Invite is
        unavailable for accounts that have not written to the bot yet (/start, /grupy or /verify). The bot picks the request up within
        about a minute and reports the result here.
      </p>

      {/* Below ~1000px: one card per user (the table needs ~880px; narrower, the Invite button would be off-screen). */}
      <div className="lg:hidden space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
        ) : users.length === 0 ? (
          <div className="rounded-md border py-12 text-center text-muted-foreground">{emptyText}</div>
        ) : (
          users.map((u) => (
            <div key={u.pk} className="rounded-xl border bg-card p-4 space-y-2">
              <div className="flex items-start gap-3">{renderUserInfo(u)}</div>
              <div className="divide-y">
                {accountRows(u).map((row) => (
                  <div key={row.key} className="py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {renderKind(row)}
                        <span className="font-mono text-sm break-all">{row.id}</span>
                      </div>
                      <div className="shrink-0">{renderState(u, row)}</div>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <div className="text-sm min-w-0">{renderLast(u, row)}</div>
                      <div className="shrink-0">{renderAction(u, row)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="hidden lg:block rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="font-bold">User</TableHead>
              <TableHead className="font-bold">Account</TableHead>
              <TableHead className="font-bold">State</TableHead>
              <TableHead className="font-bold">Last manual invite</TableHead>
              <TableHead className="font-bold text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => {
                const rows = accountRows(u)
                return rows.map((row, i) => (
                  <TableRow key={`${u.pk}:${row.key}`} className={i === 0 ? "border-t-2" : undefined}>
                    {i === 0 && (
                      <TableCell rowSpan={rows.length} className="align-top">
                        <div className="flex items-start gap-3 min-w-40 max-w-56">{renderUserInfo(u)}</div>
                      </TableCell>
                    )}
                    <TableCell>
                      {/* nowrap: an account ID must never be squeezed into one-character lines */}
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {renderKind(row)}
                        <span className="font-mono text-sm">{row.id}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{renderState(u, row)}</TableCell>
                    <TableCell className="text-sm max-w-52">{renderLast(u, row)}</TableCell>
                    <TableCell className="text-right">{renderAction(u, row)}</TableCell>
                  </TableRow>
                ))
              })
            )}
          </TableBody>
        </Table>
      </div>

      {!loading && missing.length > 0 && (
        <details open className="rounded-xl border bg-card">
          <summary className="cursor-pointer select-none px-4 py-3 font-medium">
            Active members with no Matrix or Telegram account ({missingShown.length}
            {missingShown.length !== missing.length ? ` of ${missing.length}` : ""})
          </summary>
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            Membership not expired, no matrixHandles and no telegramIDs. Open a user to add the accounts by hand.
          </p>
          <ul className="divide-y border-t">
            {missingShown.map((m) => renderMissing(m))}
          </ul>
        </details>
      )}
    </div>
  )
}
