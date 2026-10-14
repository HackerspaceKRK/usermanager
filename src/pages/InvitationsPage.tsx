import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { format, formatDistanceToNow } from "date-fns"
import { Loader2Icon, RefreshCwIcon, SearchIcon, SendIcon } from "lucide-react"
import { useAuth } from "@/auth/AuthContext"
import { useMe } from "@/hooks/useMe"
import { listMatrixUsers, requestMatrixInvite } from "@/api/authentik"
import type { MatrixInviteResult, MatrixUser, MatrixUsersResponse } from "@/api/authentik"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  MatrixAccountBadge,
  TelegramStatusBadge,
  isProblemState,
} from "@/components/IntegrationBadges"

const POLL_MS = 5000 // how often we re-read while a manual invite is waiting for the bot
const WAIT_TIMEOUT_S = 180 // stop waiting for the bot after this long

function initials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  }
  return (name[0] ?? username[0] ?? "?").toUpperCase()
}

function lastResult(u: MatrixUser, handle: string): MatrixInviteResult | undefined {
  const results = (u.matrixInviteResults ?? []).filter((r) => r.handle === handle)
  return results[results.length - 1]
}

function hasProblem(u: MatrixUser): boolean {
  if (u.matrixStatus && u.matrixStatus !== "ok") return true
  return u.matrixHandles.some((h) => {
    const account = u.matrixAccounts?.[h]
    return account !== undefined && isProblemState(account.state)
  })
}

export function InvitationsPage() {
  const { token } = useAuth()
  const me = useMe(token)
  const [data, setData] = useState<MatrixUsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [onlyProblems, setOnlyProblems] = useState(false)
  // "pk:handle" -> unix seconds when an admin clicked Invite; cleared once the bot reports a result.
  const [waiting, setWaiting] = useState<Record<string, number>>({})
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [inviteError, setInviteError] = useState<string | null>(null)

  const load = useCallback(
    async (silent: boolean) => {
      if (!token) return
      if (!silent) setLoading(true)
      try {
        setData(await listMatrixUsers(token))
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
        const [pkStr, ...rest] = key.split(":")
        const handle = rest.join(":")
        const u = data.users.find((x) => String(x.pk) === pkStr)
        const stillQueued = u?.matrixInviteRequests?.some((r) => r.handle === handle) ?? false
        const reported = u?.matrixInviteResults?.some((r) => r.handle === handle && r.ts >= queuedAt - 5) ?? false
        const timedOut = now - queuedAt > WAIT_TIMEOUT_S
        if ((reported && !stillQueued) || timedOut) continue
        next[key] = queuedAt
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [data])

  const anyQueued =
    Object.keys(waiting).length > 0 ||
    (data?.users.some((u) => (u.matrixInviteRequests?.length ?? 0) > 0) ?? false)

  useEffect(() => {
    if (!anyQueued) return
    const t = setInterval(() => void load(true), POLL_MS)
    return () => clearInterval(t)
  }, [anyQueued, load])

  async function invite(u: MatrixUser, handle: string) {
    if (!token || !me) return
    const key = `${u.pk}:${handle}`
    setSending((prev) => ({ ...prev, [key]: true }))
    setInviteError(null)
    try {
      await requestMatrixInvite(token, u.pk, handle, me.username)
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
        u.matrixHandles.some((h) => h.toLowerCase().includes(q))
      )
    })
  }, [data, search, onlyProblems])

  const stats = data?.stats

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-5 space-y-1">
          <div className="text-sm font-medium text-muted-foreground">Matrix</div>
          {loading || !stats ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <>
              <div className="text-3xl font-bold">{stats.matrix.users} users</div>
              <div className="text-sm text-muted-foreground">
                {stats.matrix.accounts} accounts · {stats.matrix.healthy} OK ·{" "}
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
                {stats.telegram.accounts} accounts · {stats.telegram.pending} waiting for /start
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm w-full">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by user or Matrix account..."
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
        Invite sends the account to every configured room and space, ignoring an earlier decline. The bot picks the
        request up within about a minute and reports the result here.
      </p>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="font-bold">User</TableHead>
              <TableHead className="font-bold">Matrix account</TableHead>
              <TableHead className="font-bold">State</TableHead>
              <TableHead className="font-bold">Last manual invite</TableHead>
              <TableHead className="font-bold text-right">Action</TableHead>
              <TableHead className="font-bold">Telegram</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  {data && data.users.length > 0 ? "No users match the filters." : "No users have Matrix accounts yet."}
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) =>
                u.matrixHandles.map((handle, i) => {
                  const key = `${u.pk}:${handle}`
                  const queued = key in waiting || (u.matrixInviteRequests?.some((r) => r.handle === handle) ?? false)
                  const busy = !!sending[key]
                  const result = lastResult(u, handle)
                  const ok = result?.result.startsWith("ok")
                  return (
                    <TableRow key={key} className={i === 0 ? "border-t-2" : undefined}>
                      {i === 0 && (
                        <TableCell rowSpan={u.matrixHandles.length} className="align-top">
                          <div className="flex items-center gap-3 min-w-40">
                            <Avatar>
                              <AvatarImage src={u.avatar} alt={u.name} />
                              <AvatarFallback>{initials(u.name, u.username)}</AvatarFallback>
                            </Avatar>
                            <div>
                              <Link to={`/users/edit/${u.pk}`} className="font-medium leading-tight hover:underline">
                                {u.username}
                              </Link>
                              {!u.isActive && <div className="text-xs text-muted-foreground">inactive</div>}
                              {u.name !== u.username && (
                                <div className="text-xs text-muted-foreground leading-tight mt-0.5">{u.name}</div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      )}
                      <TableCell className="font-mono text-sm">{handle}</TableCell>
                      <TableCell>
                        <MatrixAccountBadge account={u.matrixAccounts?.[handle]} />
                      </TableCell>
                      <TableCell className="text-sm max-w-72">
                        {result ? (
                          <div title={result.result}>
                            <div className={`truncate ${ok ? "" : "text-destructive"}`}>{result.result}</div>
                            <div className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(result.ts * 1000), { addSuffix: true })} ·{" "}
                              {format(new Date(result.ts * 1000), "yyyy-MM-dd HH:mm")} · by {result.by}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!me || busy || queued}
                          onClick={() => void invite(u, handle)}
                        >
                          {busy || queued ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
                          {queued ? "Queued…" : "Invite"}
                        </Button>
                      </TableCell>
                      {i === 0 && (
                        <TableCell rowSpan={u.matrixHandles.length} className="align-top">
                          <TelegramStatusBadge
                            ids={u.telegramIDs}
                            username={u.telegramUsername}
                            status={u.telegramStatus}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  )
                }),
              )
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
