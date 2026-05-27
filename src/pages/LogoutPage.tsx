import { useEffect } from "react"

export function LogoutPage() {
  useEffect(() => {
    localStorage.removeItem("um_access_token")
    localStorage.removeItem("um_token_expiry")
  }, [])

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center p-8">
        <h2 className="text-xl font-bold mb-2">You have been logged out</h2>
        <p className="text-sm text-muted-foreground">
          <a href="/" className="underline underline-offset-4 hover:text-foreground">
            Log in again
          </a>
        </p>
      </div>
    </div>
  )
}
