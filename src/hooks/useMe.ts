import { useState, useEffect } from "react"
import type { User } from "../api/authentik"
import { getMe } from "../api/authentik"

export function useMe(token: string | null): User | null {
  const [me, setMe] = useState<User | null>(null)

  useEffect(() => {
    if (!token) return
    getMe(token).then(setMe).catch(console.error)
  }, [token])

  return me
}
