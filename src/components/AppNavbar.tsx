import { Link, useLocation } from "react-router-dom"
import { useState, useEffect } from "react"
import { ModeToggle } from "@/components/ModeToggle"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/auth/AuthContext"
import { useMe } from "@/hooks/useMe"
import { UserIcon, MenuIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function NavLink({
  to,
  children,
  onClick,
}: {
  to: string
  children: React.ReactNode
  onClick?: () => void
}) {
  const { pathname } = useLocation()
  const active = pathname === to || (to !== "/" && pathname.startsWith(to))
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        "block px-3 py-1.5 text-sm rounded-md transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "hover:bg-accent hover:text-accent-foreground text-muted-foreground",
      )}
    >
      {children}
    </Link>
  )
}

export function AppNavbar() {
  const { token, logout } = useAuth()
  const me = useMe(token)
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => setOpen(false), [pathname])

  return (
    <header className="border-b">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        {/* Left: logo + desktop nav */}
        <div className="flex items-center gap-1 min-w-0">
          <Link to="/" className="text-base font-semibold px-2 mr-1 shrink-0">
            User Manager
          </Link>
          <nav className="hidden md:flex items-center gap-0.5">
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/users">Users</NavLink>
            <NavLink to="/invitations">Invitations</NavLink>
          </nav>
        </div>

        {/* Right: user + mode toggle + logout (desktop) / hamburger (mobile) */}
        <div className="flex items-center gap-2 shrink-0">
          {me && (
            <div className="hidden sm:flex items-center gap-2 text-sm">
              <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                <UserIcon className="size-4 text-muted-foreground" />
              </div>
              <span className="font-medium hidden lg:inline">{me.name || me.username}</span>
            </div>
          )}
          <ModeToggle />
          <Button
            variant="outline"
            size="sm"
            onClick={logout}
            className="hidden md:flex"
          >
            Log out
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {open ? <XIcon className="size-4" /> : <MenuIcon className="size-4" />}
          </Button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t px-4 py-3 space-y-1">
          <NavLink to="/" onClick={() => setOpen(false)}>Dashboard</NavLink>
          <NavLink to="/users" onClick={() => setOpen(false)}>Users</NavLink>
          <NavLink to="/invitations" onClick={() => setOpen(false)}>Invitations</NavLink>
          {me && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border-t mt-2 pt-3">
              <UserIcon className="size-4 shrink-0" />
              <span className="font-medium truncate">{me.name || me.username}</span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => { setOpen(false); logout() }}
          >
            Log out
          </Button>
        </div>
      )}
    </header>
  )
}
