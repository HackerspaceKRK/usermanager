export interface UserAttributes {
  mifareCardId?: string[]
  bankAccountNumber?: string
  telegramIDs?: string[]
  membershipExpirationTimestamp?: number
  [key: string]: unknown
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
  return res.json() as Promise<User>
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
