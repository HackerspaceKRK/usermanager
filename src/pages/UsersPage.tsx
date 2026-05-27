import { useState, useEffect, useCallback } from "react"
import type { ColumnDef, VisibilityState, SortingState, OnChangeFn } from "@tanstack/react-table"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"
import { format, formatDistanceToNow } from "date-fns"
import {
  PencilIcon,
  SlidersHorizontalIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  SearchIcon,
  UserPlusIcon,
  RotateCcwIcon,
} from "lucide-react"
import { useNavigate, useSearchParams, Link } from "react-router-dom"
import { listUsers } from "../api/authentik"
import type { User, Pagination } from "../api/authentik"
import { useAuth } from "../auth/AuthContext"
import { useGroups } from "../hooks/useGroups"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { PageLayout } from "@/components/PageLayout"

const VISIBILITY_KEY = "usermanager-column-visibility"
const PAGE_SIZE = 20

const DEFAULT_VISIBILITY: VisibilityState = {
  last_login: true,
  groups: false,
  mifareCardId: false,
  bankAccountNumber: false,
  telegramIDs: false,
  created_at: false,
}

const COLUMN_LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  last_login: "Last Authentik Login",
  groups: "Groups",
  membershipExpiration: "Membership Expiration",
  mifareCardId: "Mifare IDs",
  bankAccountNumber: "Bank Account",
  telegramIDs: "Telegram IDs",
  created_at: "Created At",
}

const SORT_FIELD_MAP: Record<string, string> = {
  name: "username",
  email: "email",
  last_login: "last_login",
  created_at: "date_joined",
}

function loadVisibility(): VisibilityState {
  try {
    const stored = localStorage.getItem(VISIBILITY_KEY)
    return stored ? (JSON.parse(stored) as VisibilityState) : DEFAULT_VISIBILITY
  } catch {
    return DEFAULT_VISIBILITY
  }
}

function sortingFromParam(param: string | null): SortingState {
  if (!param) return [{ id: "last_login", desc: true }]
  const desc = param.startsWith("-")
  const id = desc ? param.slice(1) : param
  return [{ id, desc }]
}

function sortingToParam(sorting: SortingState): string | null {
  if (!sorting.length) return null
  const s = sorting[0]!
  return s.desc ? `-${s.id}` : s.id
}

function initials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  }
  return (name[0] ?? username[0] ?? "?").toUpperCase()
}

function SortHeader({
  label,
  isSorted,
  onToggle,
}: {
  label: string
  isSorted: false | "asc" | "desc"
  onToggle: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 font-bold"
      onClick={onToggle}
    >
      {label}
      {isSorted === "asc" ? (
        <ChevronUpIcon className="ml-1 size-3.5" />
      ) : isSorted === "desc" ? (
        <ChevronDownIcon className="ml-1 size-3.5" />
      ) : (
        <ChevronsUpDownIcon className="ml-1 size-3.5 opacity-40" />
      )}
    </Button>
  )
}

function MembershipBadge({ ts }: { ts: number }) {
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
    // Desaturated green for expiring very soon
    badgeClass =
      "bg-green-50 text-green-700/70 border-green-100 dark:bg-green-900/15 dark:text-green-500/70 dark:border-green-900"
  } else {
    badgeClass =
      "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
  }

  return (
    <div className="space-y-1">
      <Badge variant="outline" className={badgeClass}>
        {label}
      </Badge>
      <div className="text-xs text-muted-foreground">
        {format(d, "yyyy-MM-dd HH:mm")}
      </div>
    </div>
  )
}

function buildPageList(
  current: number,
  total: number,
): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const items: Array<number | "ellipsis"> = [1]
  const left = Math.max(2, current - 2)
  const right = Math.min(total - 1, current + 2)
  if (left > 2) items.push("ellipsis")
  for (let i = left; i <= right; i++) items.push(i)
  if (right < total - 1) items.push("ellipsis")
  items.push(total)
  return items
}

function Pagination({
  pagination,
  page,
  onPageChange,
}: {
  pagination: { count: number; current: number; total_pages: number; next: number }
  page: number
  onPageChange: (p: number) => void
}) {
  const total = pagination.total_pages
  const pages = buildPageList(page, total)

  return (
    <div className="flex items-center justify-between text-sm gap-2 flex-wrap">
      <span className="text-muted-foreground shrink-0">
        {pagination.count} users · page {pagination.current} of {total}
      </span>
      <div className="flex items-center gap-1">
        {pages.map((p, i) => {
          if (p === "ellipsis") {
            return (
              <span
                key={`ellipsis-${i}`}
                className="w-9 h-8 flex items-center justify-center text-muted-foreground select-none"
              >
                …
              </span>
            )
          }
          const isCurrent = p === page
          return (
            <Button
              key={p}
              variant={isCurrent ? "default" : "outline"}
              size="sm"
              className="w-9 h-8 p-0"
              disabled={isCurrent}
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

export function UsersPage() {
  const { token, loading: authLoading } = useAuth()
  const groupMap = useGroups(token)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [users, setUsers] = useState<User[]>([])
  const [paginationData, setPaginationData] = useState<Pagination | null>(null)
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get("page") ?? "1")
    return isNaN(p) || p < 1 ? 1 : p
  })
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(loadVisibility)
  const [sorting, setSorting] = useState<SortingState>(() =>
    sortingFromParam(searchParams.get("sort")),
  )

  useEffect(() => {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(columnVisibility))
  }, [columnVisibility])

  // Sync page + sort to URL
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (page === 1) next.delete("page")
        else next.set("page", String(page))
        const sortParam = sortingToParam(sorting)
        const isDefault =
          sorting.length === 1 && sorting[0]!.id === "last_login" && sorting[0]!.desc
        if (sortParam && !isDefault) next.set("sort", sortParam)
        else next.delete("sort")
        return next
      },
      { replace: true },
    )
  }, [page, sorting])

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [search])

  const ordering =
    sorting.length > 0
      ? (sorting[0]!.desc ? "-" : "") +
        (SORT_FIELD_MAP[sorting[0]!.id] ?? sorting[0]!.id)
      : undefined

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listUsers(token, {
      search: debouncedSearch || undefined,
      page,
      pageSize: PAGE_SIZE,
      ordering,
    })
      .then((data) => {
        if (cancelled) return
        setUsers(data.results)
        setPaginationData(data.pagination)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, page, debouncedSearch, ordering])

  const handleSortingChange: OnChangeFn<SortingState> = useCallback(
    (updater) => {
      setSorting((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater
        setPage(1)
        return next
      })
    },
    [],
  )

  const columns: ColumnDef<User>[] = [
    {
      id: "name",
      header: ({ column }) => (
        <SortHeader
          label="Name"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      enableHiding: true,
      enableSorting: true,
      cell: ({ row }) => {
        const user = row.original
        return (
          <div className="flex items-center gap-3 min-w-40">
            <Avatar>
              <AvatarImage src={user.avatar} alt={user.name} />
              <AvatarFallback>{initials(user.name, user.username)}</AvatarFallback>
            </Avatar>
            <div>
              <Link
                to={`/users/edit/${user.pk}`}
                className="font-medium leading-tight hover:underline"
              >
                {user.username}
              </Link>
              {user.name !== user.username && (
                <div className="text-xs text-muted-foreground leading-tight mt-0.5">
                  {user.name}
                </div>
              )}
            </div>
          </div>
        )
      },
    },
    {
      id: "email",
      header: ({ column }) => (
        <SortHeader
          label="Email"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      enableHiding: true,
      enableSorting: true,
      cell: ({ row }) => {
        const user = row.original
        return user.email ? (
          <Link
            to={`/users/edit/${user.pk}`}
            className="text-sm hover:underline"
          >
            {user.email}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "last_login",
      header: ({ column }) => (
        <SortHeader
          label="Last Authentik Login"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      enableHiding: true,
      enableSorting: true,
      cell: ({ row }) => {
        const ll = row.original.last_login
        if (!ll)
          return <span className="text-muted-foreground text-sm">Never</span>
        const d = new Date(ll)
        return (
          <div className="text-sm">
            <div>{formatDistanceToNow(d, { addSuffix: true })}</div>
            <div className="text-xs text-muted-foreground">
              {format(d, "yyyy-MM-dd HH:mm")}
            </div>
          </div>
        )
      },
    },
    {
      id: "groups",
      header: () => <span className="font-bold">Groups</span>,
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => {
        const ids = row.original.groups
        if (!ids.length)
          return <span className="text-muted-foreground text-sm">—</span>
        return (
          <div className="flex flex-wrap gap-1 max-w-48">
            {ids.map((id) => (
              <Badge key={id} variant="secondary" className="text-xs">
                {groupMap.get(id) ?? id.slice(0, 8) + "…"}
              </Badge>
            ))}
          </div>
        )
      },
    },
    {
      id: "membershipExpiration",
      header: () => <span className="font-bold">Membership Expiration</span>,
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => {
        const ts = row.original.attributes.membershipExpirationTimestamp
        if (!ts)
          return <span className="text-muted-foreground text-sm">—</span>
        return <MembershipBadge ts={ts} />
      },
    },
    {
      id: "mifareCardId",
      header: () => <span className="font-bold">Mifare IDs</span>,
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => {
        const ids = row.original.attributes.mifareCardId
        if (!ids?.length)
          return <span className="text-muted-foreground text-sm">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <Badge key={id} variant="outline" className="text-xs font-mono">
                {id}
              </Badge>
            ))}
          </div>
        )
      },
    },
    {
      id: "bankAccountNumber",
      header: () => <span className="font-bold">Bank Account</span>,
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => {
        const ban = row.original.attributes.bankAccountNumber
        if (!ban)
          return <span className="text-muted-foreground text-sm">—</span>
        return <span className="font-mono text-xs">{ban}</span>
      },
    },
    {
      id: "telegramIDs",
      header: () => <span className="font-bold">Telegram IDs</span>,
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => {
        const ids = row.original.attributes.telegramIDs
        if (!ids?.length)
          return <span className="text-muted-foreground text-sm">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <Badge key={id} variant="outline" className="text-xs">
                {id}
              </Badge>
            ))}
          </div>
        )
      },
    },
    {
      id: "created_at",
      header: ({ column }) => (
        <SortHeader
          label="Created At"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      enableHiding: true,
      enableSorting: true,
      cell: ({ row }) => {
        const d = new Date(row.original.date_joined)
        return (
          <span className="text-sm text-muted-foreground">
            {format(d, "yyyy-MM-dd HH:mm")}
          </span>
        )
      },
    },
    {
      id: "actions",
      header: "",
      enableHiding: false,
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit user"
          onClick={() => navigate(`/users/edit/${row.original.pk}`)}
        >
          <PencilIcon />
        </Button>
      ),
    },
  ]

  const table = useReactTable({
    data: users,
    columns,
    manualPagination: true,
    manualSorting: true,
    pageCount: paginationData?.total_pages ?? -1,
    state: { columnVisibility, sorting },
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
  })

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    )
  }

  const skeletonCount = users.length > 0 ? users.length : PAGE_SIZE

  const paginationEl = paginationData && (
    <Pagination
      pagination={paginationData}
      page={page}
      onPageChange={setPage}
    />
  )

  return (
    <PageLayout>
      <div className="space-y-4">
        {/* Page header */}
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">Users</h1>
          <Button onClick={() => navigate("/users/edit/new")}>
            <UserPlusIcon />
            Create User
          </Button>
        </div>

        {/* Search + column toggle */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="relative max-w-sm w-full">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by username, name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontalIcon />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-bold">
                Toggle columns
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllColumns()
                .filter((col) => col.getCanHide())
                .map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(val) => col.toggleVisibility(val === true)}
                  >
                    {COLUMN_LABELS[col.id] ?? col.id}
                  </DropdownMenuCheckboxItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setColumnVisibility(DEFAULT_VISIBILITY)}
              >
                <RotateCcwIcon className="size-4" />
                Reset to defaults
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 text-destructive px-4 py-2 text-sm border border-destructive/20">
            Error: {error}
          </div>
        )}

        {paginationEl}

        {/* Table */}
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow
                  key={headerGroup.id}
                  className="bg-muted/50 hover:bg-muted/50"
                >
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="font-bold whitespace-nowrap">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: skeletonCount }).map((_, i) => (
                  <TableRow key={i}>
                    {table.getVisibleLeafColumns().map((col) => (
                      <TableCell key={col.id}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="text-center py-12 text-muted-foreground"
                  >
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {paginationEl}
      </div>
    </PageLayout>
  )
}
