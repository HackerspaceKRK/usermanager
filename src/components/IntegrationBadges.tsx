import { Badge } from "@/components/ui/badge"
import type { MatrixAccount, MatrixAccountState } from "@/api/authentik"

const OK = "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
const INFO = "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-800"
const WARN = "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800"
const BAD = "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
const MUTED = "bg-muted text-muted-foreground"
const SHOWN_IDS = 3 // Telegram IDs listed in a cell; the rest collapses into "+N" (full list in the tooltip)

const ACCOUNT_STATES: Record<MatrixAccountState, { label: string; className: string }> = {
  joined: { label: "Joined", className: OK },
  invited: { label: "Invited", className: INFO },
  pending: { label: "Not accepted", className: WARN },
  left: { label: "Declined / left", className: WARN },
  banned: { label: "Banned", className: BAD },
  error: { label: "Error", className: BAD },
  unknown: { label: "Unknown", className: MUTED },
}

/** State of a single Matrix account as reported by the bot (worst state across all rooms/spaces). */
export function MatrixAccountBadge({ account }: { account?: MatrixAccount }) {
  if (!account) {
    return (
      <Badge variant="outline" className={MUTED} title="The bot has not processed this account yet">
        Not processed yet
      </Badge>
    )
  }
  const style = ACCOUNT_STATES[account.state] ?? ACCOUNT_STATES.unknown
  return (
    <Badge variant="outline" className={style.className} title={account.detail || undefined}>
      {style.label}
    </Badge>
  )
}

/** Overall Matrix status of a user (matrixStatus is "ok" or a description of problems). */
export function MatrixStatusBadge({ handles, status }: { handles: string[]; status?: string }) {
  if (handles.length === 0) return <span className="text-muted-foreground text-sm">—</span>
  const count = `${handles.length} account${handles.length === 1 ? "" : "s"}`
  if (!status) {
    return (
      <Badge variant="outline" className={MUTED} title="The bot has not processed this user yet">
        {count} · not processed
      </Badge>
    )
  }
  if (status === "ok") {
    return (
      <Badge variant="outline" className={OK}>
        {count} · OK
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={WARN} title={status}>
      {count} · problem
    </Badge>
  )
}

/** Telegram accounts of a user (telegramIDs) and a pending verification request, if any. */
export function TelegramStatusBadge({
  ids,
  username,
  status,
  accounts,
}: {
  ids: string[]
  username?: string
  status?: string
  accounts?: Record<string, { username: string; name: string }>
}) {
  const failed = !!status && status !== "ok"
  if (ids.length === 0 && !username && !failed) {
    return <span className="text-muted-foreground text-sm">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.slice(0, SHOWN_IDS).map((id) => (
        <Badge
          key={id}
          variant="outline"
          className={`${OK} font-mono`}
          title={accounts?.[id]?.name ? `Telegram ID, ${accounts[id]!.name}` : "Telegram ID"}
        >
          {id}
          {accounts?.[id]?.username && <span className="ml-1 font-sans opacity-70">@{accounts[id]!.username}</span>}
        </Badge>
      ))}
      {ids.length > SHOWN_IDS && (
        <Badge variant="outline" className={MUTED} title={ids.slice(SHOWN_IDS).join(", ")}>
          +{ids.length - SHOWN_IDS}
        </Badge>
      )}
      {username && (
        <Badge variant="outline" className={WARN} title="Waiting for this Telegram account to send /start to the bot">
          waiting: {username}
        </Badge>
      )}
      {failed && (
        <Badge variant="outline" className={BAD} title={status}>
          problem
        </Badge>
      )}
    </div>
  )
}

/** True for account states that need an admin's attention. */
export function isProblemState(state: MatrixAccountState | undefined): boolean {
  return state !== "joined" && state !== "invited"
}

/** Matrix and Telegram stacked in one compact cell (keeps the Users table narrow enough to show both). */
export function MessengersCell({
  handles,
  matrixStatus,
  telegramIds,
  telegramUsername,
  telegramStatus,
  telegramAccounts,
}: {
  handles: string[]
  matrixStatus?: string
  telegramIds: string[]
  telegramUsername?: string
  telegramStatus?: string
  telegramAccounts?: Record<string, { username: string; name: string }>
}) {
  const none = handles.length === 0 && telegramIds.length === 0 && !telegramUsername && !telegramStatus
  if (none) return <span className="text-muted-foreground text-sm">—</span>
  return (
    <div className="space-y-1 max-w-64">
      <div className="flex items-center gap-1.5">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">Matrix</span>
        <MatrixStatusBadge handles={handles} status={matrixStatus} />
      </div>
      <div className="flex items-start gap-1.5">
        <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">Telegram</span>
        <TelegramStatusBadge ids={telegramIds} username={telegramUsername} status={telegramStatus} accounts={telegramAccounts} />
      </div>
    </div>
  )
}

/** State of a single Telegram account row on the Invitations page. */
export function TelegramAccountBadge({ pending, unreachable }: { pending: boolean; unreachable?: boolean }) {
  if (unreachable) {
    // The ID is trusted (it is in telegramIDs); this is only a side note that Invite cannot work yet, so it is muted, not a warning.
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Badge variant="outline" className={OK} title="Listed in telegramIDs">
          Linked
        </Badge>
        <span
          className="text-[11px] text-muted-foreground"
          title="Telegram bots cannot message someone first. This account has not written to the bot yet, so Invite is unavailable until it sends /start, /grupy or /verify to the bot."
        >
          bot can't DM yet
        </span>
      </div>
    )
  }
  if (pending) {
    return (
      <Badge variant="outline" className={WARN} title="Waiting for this Telegram account to send /start to the bot">
        Waiting for /start
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={OK} title="Listed in telegramIDs">
      Linked
    </Badge>
  )
}
