// Matrix / Telegram integration, maintained by the im-inviter bot
// (https://github.com/HackerspaceKRK/im-inviter, docs/usermanager-integration.md).
export type MatrixAccountState =
  | "joined"
  | "invited"
  | "pending"
  | "left"
  | "banned"
  | "error"
  | "unknown"

export interface MatrixAccount {
  state: MatrixAccountState
  detail: string
  updated: number
}

export interface MatrixInviteRequest {
  handle: string
  by: string
  ts: number | null
}

export interface MatrixInviteResult {
  handle: string
  by: string
  ts: number
  result: string
  rooms: number
}

export interface TelegramInviteRequest {
  id: string
  by: string
  ts: number | null
}

export interface TelegramInviteResult {
  id: string
  by: string
  ts: number
  result: string
  groups: number
}

export interface UserAttributes {
  mifareCardId?: string[]
  bankAccountNumber?: string | string[]
  telegramIDs?: string[]
  membershipExpirationTimestamp?: number
  foundUsBy?: string
  // Written by the user (Authentik settings) or an admin here; may still be a string until the bot normalizes it.
  matrixHandles?: string[] | string
  // Written by the bot only.
  matrixStatus?: string
  matrixAccounts?: Record<string, MatrixAccount>
  matrixInviteResults?: MatrixInviteResult[]
  telegramUsername?: string
  telegramStatus?: string
  // Nick and name the bot discovered per Telegram ID (display only).
  telegramAccounts?: Record<string, TelegramAccountInfo>
  // Written here, consumed and cleared by the bot.
  matrixInviteRequests?: MatrixInviteRequest[]
  telegramInviteRequests?: TelegramInviteRequest[]
  telegramInviteResults?: TelegramInviteResult[]
  [key: string]: unknown
}

/** Reads a list attribute in any stored form: array of strings/numbers or "1, 2" / "1;2" strings. */
export function listAttr(value: unknown): string[] {
  const out: string[] = []
  const add = (s: string) => {
    const t = s.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  const addSplit = (s: string) => s.split(/[\s,;]+/).forEach(add)
  if (typeof value === "string") addSplit(value)
  else if (typeof value === "number") add(String(value))
  else if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string") addSplit(v)
      else if (typeof v === "number") add(String(v))
    }
  }
  return out
}

export interface User {
  pk: number
  username: string
  name: string
  is_active: boolean
  last_login: string | null
  date_joined: string
  is_superuser: boolean
  groups: string[]
  groups_obj: PartialGroup[] | null
  email: string
  avatar: string
  attributes: UserAttributes
  uid: string
  path: string
  type: string
  uuid: string
}

export interface PartialGroup {
  pk: string
  name: string
  is_superuser: boolean
  parent: string | null
  parent_name: string | null
}

export interface Group {
  pk: string
  name: string
  is_superuser: boolean
}

export interface Pagination {
  next: number
  previous: number
  count: number
  current: number
  total_pages: number
  start_index: number
  end_index: number
}

export interface PaginatedUserList {
  pagination: Pagination
  results: User[]
}

interface PaginatedGroupList {
  pagination: Pagination
  results: Group[]
}

// All API calls go to /api/v3/ on the same origin — the Go server proxies them
// to Authentik, avoiding CORS issues.
const API_BASE = `/api/v3`

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

export async function listUsers(
  token: string,
  params: {
    search?: string
    page?: number
    pageSize?: number
    ordering?: string
  } = {},
): Promise<PaginatedUserList> {
  const query = new URLSearchParams()
  if (params.search) query.set("search", params.search)
  if (params.page) query.set("page", String(params.page))
  if (params.pageSize) query.set("page_size", String(params.pageSize))
  if (params.ordering) query.set("ordering", params.ordering)

  const res = await fetch(`${API_BASE}/core/users/?${query.toString()}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<PaginatedUserList>
}

export async function getUser(token: string, pk: number): Promise<User> {
  const res = await fetch(`${API_BASE}/core/users/${pk}/`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<User>
}

export async function updateUser(
  token: string,
  pk: number,
  patch: {
    username?: string
    email?: string
    name?: string
    attributes?: Partial<UserAttributes>
    groups?: string[]
  },
): Promise<User> {
  const res = await fetch(`${API_BASE}/core/users/${pk}/`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<User>
}

export async function createUser(
  token: string,
  data: {
    username: string
    email?: string
    name?: string
    path?: string
    attributes?: Partial<UserAttributes>
    groups?: string[]
  },
): Promise<User> {
  const res = await fetch(`${API_BASE}/core/users/`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ path: "users", ...data }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<User>
}

export async function getMe(token: string): Promise<User> {
  const res = await fetch(`${API_BASE}/core/users/me/`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { user: User } | User
  return "user" in data ? data.user : data
}

export async function listCachedUsers(
  token: string,
  params: {
    search?: string
    page?: number
    pageSize?: number
    ordering?: string
    membershipFrom?: string
    membershipTo?: string
  } = {},
): Promise<PaginatedUserList> {
  const query = new URLSearchParams()
  if (params.search) query.set("search", params.search)
  if (params.page) query.set("page", String(params.page))
  if (params.pageSize) query.set("page_size", String(params.pageSize))
  if (params.ordering) query.set("ordering", params.ordering)
  if (params.membershipFrom) query.set("membershipFrom", params.membershipFrom)
  if (params.membershipTo) query.set("membershipTo", params.membershipTo)
  const res = await fetch(`/api/local/cached-users?${query.toString()}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<PaginatedUserList>
}

export interface SummaryUser {
  pk: number
  username: string
  name: string
  avatar: string
  membershipTs: number
}

export interface IntegrationStats {
  // People vs accounts: a person with two Matrix accounts and one Telegram account is 1 person and 3 accounts.
  overall: {
    people: number
    accounts: number
    multiPeople: number
    multiAccounts: number
    // people by coverage; bothMessengers + onlyMatrix + onlyTelegram === people
    bothMessengers: number
    onlyMatrix: number
    onlyTelegram: number
  }
  matrix: {
    users: number
    accounts: number
    multiUsers: number // users with 2+ Matrix accounts
    multiAccounts: number // accounts held by those users together
    healthy: number
    problems: number
    unprocessed: number
  }
  telegram: { users: number; accounts: number; multiUsers: number; multiAccounts: number; pending: number }
}

export interface Summary {
  integrations?: IntegrationStats // absent when talking to an older server build
  totalUsers: number
  activeMembers: number
  expiredRecently: number
  expiringIn7Days: number
  expiredRecentlyUsers: SummaryUser[]
  expiringIn7DaysUsers: SummaryUser[]
}

export async function getSummary(token: string): Promise<Summary> {
  const res = await fetch("/api/local/summary", { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Summary>
}

export async function setUserPassword(token: string, pk: number, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/core/users/${pk}/set_password/`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ password }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
}

export async function listGroups(token: string): Promise<Group[]> {
  const groups: Group[] = []
  let page = 1

  while (true) {
    const query = new URLSearchParams({ page: String(page), page_size: "100" })
    const res = await fetch(`${API_BASE}/core/groups/?${query.toString()}`, {
      headers: authHeaders(token),
    })
    if (!res.ok) break
    const data = (await res.json()) as PaginatedGroupList
    groups.push(...data.results)
    if (!data.pagination.next) break
    page++
  }

  return groups
}

/** Nick and name the bot discovered for a Telegram ID (display only; empty username = the account has none). */
export interface TelegramAccountInfo {
  username: string
  name: string
  updated: number
}

export interface AccountUser {
  pk: number
  username: string
  name: string
  avatar: string
  isActive: boolean
  matrixHandles: string[]
  matrixStatus: string
  matrixAccounts: Record<string, MatrixAccount> | null
  matrixInviteRequests: MatrixInviteRequest[] | null
  matrixInviteResults: MatrixInviteResult[] | null
  telegramIDs: string[]
  telegramUsername: string
  telegramStatus: string
  // IDs that wrote to the bot (written by the bot); null = attribute absent (see telegramReachable in InvitationsPage)
  telegramReachableIDs: string[] | null
  telegramAccounts: Record<string, TelegramAccountInfo> | null
  telegramInviteRequests: TelegramInviteRequest[] | null
  telegramInviteResults: TelegramInviteResult[] | null
}

/** An active member whose membership has not expired but who has no Matrix and no Telegram account. */
export interface MissingUser {
  pk: number
  username: string
  name: string
  avatar: string
  membershipTS: number
  telegramUsername: string
}

export interface AccountUsersResponse {
  stats: IntegrationStats
  users: AccountUser[]
  missing: MissingUser[]
}

/** Users with at least one messenger account (Matrix handle, Telegram ID or a pending Telegram @username). */
export async function listAccountUsers(token: string): Promise<AccountUsersResponse> {
  const res = await fetch("/api/local/account-users", { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<AccountUsersResponse>
}

/**
 * Appends a request to one of the user's invite queues (`matrixInviteRequests` / `telegramInviteRequests`). The
 * im-inviter bot picks it up on its next run (about a minute) and records the outcome in the matching `...Results`.
 * The bot only honors accounts that are on the user's own lists, so a forged request cannot invite anyone else.
 *
 * Authentik replaces the WHOLE `attributes` object on PATCH, so we merge into freshly read attributes.
 */
async function queueInviteRequest<T extends { by: string; ts: number | null }>(
  token: string,
  pk: number,
  queueKey: "matrixInviteRequests" | "telegramInviteRequests",
  isSame: (existing: T) => boolean,
  request: T,
): Promise<void> {
  const user = await getUser(token, pk)
  const stored = user.attributes[queueKey] as unknown
  const current = (Array.isArray(stored) ? stored : []) as T[]
  if (current.some(isSame)) return // already queued
  await updateUser(token, pk, {
    attributes: { ...user.attributes, [queueKey]: [...current, request] },
  })
}

/** Manual Matrix invite: the bot invites the account to every configured room and space. */
export function requestMatrixInvite(token: string, pk: number, handle: string, by: string): Promise<void> {
  return queueInviteRequest<MatrixInviteRequest>(
    token, pk, "matrixInviteRequests",
    (r) => r.handle === handle,
    { handle, by, ts: Math.floor(Date.now() / 1000) },
  )
}

/** Manual Telegram invite: the bot sends fresh one-time group invite links to the account in a DM. */
export function requestTelegramInvite(token: string, pk: number, id: string, by: string): Promise<void> {
  return queueInviteRequest<TelegramInviteRequest>(
    token, pk, "telegramInviteRequests",
    (r) => r.id === id,
    { id, by, ts: Math.floor(Date.now() / 1000) },
  )
}
