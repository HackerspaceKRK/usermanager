import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { AUTHENTIK_URL, CLIENT_ID } from "../config"
import { generateVerifier, deriveChallenge } from "./pkce"

type AuthContextType = {
  token: string | null
  loading: boolean
  logout: () => void
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  loading: true,
  logout: () => {},
})

// Refresh 60 seconds before expiry to avoid races.
const REFRESH_BEFORE_EXPIRY_MS = 60_000

async function tryRefreshToken(): Promise<{ token: string; expiresIn: number } | null> {
  const refreshToken = localStorage.getItem("um_refresh_token")
  if (!refreshToken || !CLIENT_ID) return null

  try {
    const res = await fetch(`${AUTHENTIK_URL}/application/o/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token) return null

    const expiresIn = data.expires_in ?? 3600
    localStorage.setItem("um_access_token", data.access_token)
    localStorage.setItem("um_token_expiry", String(Date.now() + expiresIn * 1000))
    if (data.refresh_token) {
      localStorage.setItem("um_refresh_token", data.refresh_token)
    }
    return { token: data.access_token, expiresIn }
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRefresh = useCallback((expiresInMs: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    const delay = Math.max(0, expiresInMs - REFRESH_BEFORE_EXPIRY_MS)
    refreshTimerRef.current = setTimeout(() => {
      void (async () => {
        const result = await tryRefreshToken()
        if (result) {
          setToken(result.token)
          scheduleRefresh(result.expiresIn * 1000)
        } else {
          // Refresh failed mid-session — clear storage and reload to restart auth flow
          localStorage.removeItem("um_access_token")
          localStorage.removeItem("um_token_expiry")
          localStorage.removeItem("um_refresh_token")
          window.location.reload()
        }
      })()
    }, delay)
  }, [refreshTimerRef, setToken])

  const redirectToLogin = useCallback(async () => {
    if (!CLIENT_ID) return
    const verifier = generateVerifier()
    const challenge = await deriveChallenge(verifier)
    const state = crypto.randomUUID()
    sessionStorage.setItem("um_pkce_verifier", verifier)
    sessionStorage.setItem("um_oauth_state", state)
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${window.location.origin}/callback`,
      scope: "openid profile email offline_access goauthentik.io/api",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    window.location.href = `${AUTHENTIK_URL}/application/o/authorize/?${params.toString()}`
  }, [])

  useEffect(() => {
    const cleanup = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }

    if (!CLIENT_ID) {
      console.error("OAUTH CLIENT_ID is not configured")
      setLoading(false)
      return cleanup
    }

    const storedToken = localStorage.getItem("um_access_token")
    const tokenExpiry = localStorage.getItem("um_token_expiry")

    if (storedToken && tokenExpiry && Date.now() < Number(tokenExpiry)) {
      setToken(storedToken)
      setLoading(false)
      scheduleRefresh(Number(tokenExpiry) - Date.now())
      return cleanup
    }

    localStorage.removeItem("um_access_token")
    localStorage.removeItem("um_token_expiry")

    void (async () => {
      // Try refresh token before doing full PKCE redirect
      const result = await tryRefreshToken()
      if (result) {
        setToken(result.token)
        setLoading(false)
        scheduleRefresh(result.expiresIn * 1000)
        return
      }
      await redirectToLogin()
    })()

    return cleanup
  }, [scheduleRefresh, redirectToLogin])

  // When the user returns to the tab after the computer was asleep, setTimeout
  // timers may not have fired. Re-check on visibility change and refresh eagerly.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return
      const tokenExpiry = localStorage.getItem("um_token_expiry")
      if (!tokenExpiry) return
      const remaining = Number(tokenExpiry) - Date.now()
      if (remaining > REFRESH_BEFORE_EXPIRY_MS) return
      void (async () => {
        const result = await tryRefreshToken()
        if (result) {
          setToken(result.token)
          scheduleRefresh(result.expiresIn * 1000)
        } else {
          localStorage.removeItem("um_access_token")
          localStorage.removeItem("um_token_expiry")
          localStorage.removeItem("um_refresh_token")
          window.location.reload()
        }
      })()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [scheduleRefresh])

  const logout = () => {
    localStorage.removeItem("um_access_token")
    localStorage.removeItem("um_token_expiry")
    localStorage.removeItem("um_refresh_token")
    setToken(null)
    window.location.href = "/logout"
  }

  if (!CLIENT_ID && !loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-destructive text-center p-8">
          <h2 className="text-xl font-bold mb-2">Configuration Error</h2>
          <p className="text-sm">
            VITE_CLIENT_ID is not set. Check your <code>.env.local</code> file.
          </p>
        </div>
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ token, loading, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
