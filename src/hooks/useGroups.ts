import { useState, useEffect } from "react"
import { listGroups } from "../api/authentik"

export function useGroups(token: string | null): Map<string, string> {
  const [groupMap, setGroupMap] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!token) return
    listGroups(token)
      .then((groups) => {
        setGroupMap(new Map(groups.map((g) => [g.pk, g.name])))
      })
      .catch(() => {
        // silently ignore group fetch failures
      })
  }, [token])

  return groupMap
}
