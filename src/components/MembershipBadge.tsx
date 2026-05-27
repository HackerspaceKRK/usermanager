import { format, formatDistanceToNow } from "date-fns"
import { Badge } from "@/components/ui/badge"

export function MembershipBadge({ ts, compact }: { ts: number; compact?: boolean }) {
  const d = new Date(ts * 1000)
  const now = new Date()
  const expired = d < now
  const daysLeft = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  const relative = formatDistanceToNow(d, { addSuffix: true })
  const label = expired ? `Expired ${relative}` : `Expires ${relative}`

  let badgeClass: string
  if (expired) {
    badgeClass =
      "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
  } else if (daysLeft < 3) {
    badgeClass =
      "bg-green-50 text-green-700/70 border-green-100 dark:bg-green-900/15 dark:text-green-500/70 dark:border-green-900"
  } else {
    badgeClass =
      "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
  }

  return (
    <div className="space-y-0.5">
      <Badge variant="outline" className={badgeClass}>
        {label}
      </Badge>
      {!compact && (
        <div className="text-xs text-muted-foreground">
          {format(d, "yyyy-MM-dd HH:mm")}
        </div>
      )}
    </div>
  )
}
