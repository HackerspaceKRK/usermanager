import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { format, addDays } from "date-fns"
import { useAuth } from "@/auth/AuthContext"
import { getSummary } from "@/api/authentik"
import type { Summary, SummaryUser } from "@/api/authentik"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MembershipBadge } from "@/components/MembershipBadge"
import {
  UsersIcon,
  CheckCircleIcon,
  ClockIcon,
  AlertCircleIcon,
  ArrowRightIcon,
  MessagesSquareIcon,
  SendIcon,
} from "lucide-react"

function initials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  }
  return (name[0] ?? username[0] ?? "?").toUpperCase()
}

function UserRow({ u }: { u: SummaryUser }) {
  return (
    <Link
      to={`/users/edit/${u.pk}`}
      className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 transition-colors"
    >
      <Avatar className="size-7 shrink-0">
        <AvatarImage src={u.avatar} alt={u.name} />
        <AvatarFallback className="text-xs">{initials(u.name, u.username)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{u.username}</div>
        {u.name !== u.username && (
          <div className="text-xs text-muted-foreground truncate">{u.name}</div>
        )}
      </div>
      <div className="shrink-0">
        <MembershipBadge ts={u.membershipTs} compact />
      </div>
    </Link>
  )
}

function ViewAllLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      <ArrowRightIcon className="size-3.5" />
    </Link>
  )
}

export function DashboardPage() {
  const { token } = useAuth()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    setLoading(true)
    getSummary(token)
      .then((s) => {
        setSummary(s)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [token])

  const matrix = summary?.integrations?.matrix
  const telegram = summary?.integrations?.telegram
  const today = format(new Date(), "yyyy-MM-dd")
  const yesterday = format(addDays(new Date(), -1), "yyyy-MM-dd")
  const sevenDaysAgo = format(addDays(new Date(), -7), "yyyy-MM-dd")
  const sevenDaysAhead = format(addDays(new Date(), 7), "yyyy-MM-dd")

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-2 text-sm border border-destructive/20">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Total users */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <UsersIcon className="size-4" />
            Total users
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold">{summary?.totalUsers ?? 0}</div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink to="/users" label="View all users" />
          </div>
        </div>

        {/* Active memberships */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CheckCircleIcon className="size-4 text-green-600 dark:text-green-400" />
            Active memberships
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-green-600 dark:text-green-400">
              {summary?.activeMembers ?? 0}
            </div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink
              to={`/users?membershipFrom=${today}`}
              label="View active members"
            />
          </div>
        </div>

        {/* Expiring in 7 days */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ClockIcon className="size-4 text-amber-600 dark:text-amber-400" />
            Expiring in 7 days
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-amber-600 dark:text-amber-400">
              {summary?.expiringIn7Days ?? 0}
            </div>
          )}
          {!loading && (summary?.expiringIn7DaysUsers.length ?? 0) > 0 && (
            <div className="space-y-0.5 border-t pt-2">
              {summary!.expiringIn7DaysUsers.map((u) => (
                <UserRow key={u.pk} u={u} />
              ))}
            </div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink
              to={`/users?membershipFrom=${today}&membershipTo=${sevenDaysAhead}`}
              label="View all expiring soon"
            />
          </div>
        </div>

        {/* Expired in last 7 days */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <AlertCircleIcon className="size-4 text-red-600 dark:text-red-400" />
            Expired in last 7 days
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
              {summary?.expiredRecently ?? 0}
            </div>
          )}
          {!loading && (summary?.expiredRecentlyUsers.length ?? 0) > 0 && (
            <div className="space-y-0.5 border-t pt-2">
              {summary!.expiredRecentlyUsers.map((u) => (
                <UserRow key={u.pk} u={u} />
              ))}
            </div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink
              to={`/users?membershipFrom=${sevenDaysAgo}&membershipTo=${yesterday}`}
              label="View recently expired"
            />
          </div>
        </div>

        {/* Matrix accounts (managed by the im-inviter bot) */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <MessagesSquareIcon className="size-4" />
            Users with Matrix
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold">{matrix?.users ?? "—"}</div>
          )}
          {!loading && matrix && (
            <div className="text-sm text-muted-foreground">
              {matrix.accounts} accounts · {matrix.healthy} OK ·{" "}
              <span className={matrix.problems > 0 ? "text-amber-600 dark:text-amber-400" : ""}>
                {matrix.problems} with problems
              </span>
            </div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink to="/invitations" label="View Matrix accounts" />
          </div>
        </div>

        {/* Telegram accounts */}
        <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <SendIcon className="size-4" />
            Users with Telegram
          </div>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold">{telegram?.users ?? "—"}</div>
          )}
          {!loading && telegram && (
            <div className="text-sm text-muted-foreground">
              {telegram.accounts} accounts · {telegram.pending} waiting for /start
            </div>
          )}
          <div className="mt-auto pt-3 border-t">
            <ViewAllLink to="/invitations" label="View Telegram status" />
          </div>
        </div>
      </div>
    </div>
  )
}
