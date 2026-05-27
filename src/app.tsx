import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { ThemeProvider } from "./theme"
import { AuthProvider } from "./auth/AuthContext"
import { UsersPage } from "./pages/UsersPage"
import { CallbackPage } from "./pages/CallbackPage"
import { LogoutPage } from "./pages/LogoutPage"
import { DashboardPage } from "./pages/DashboardPage"
import { EditUserPage } from "./pages/EditUserPage"
import { InvitationsPage } from "./pages/InvitationsPage"
import { EditInvitationPage } from "./pages/EditInvitationPage"
import { PageLayout } from "./components/PageLayout"
import { MobileScanPage } from "./pages/MobileScanPage"

function AuthedLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

const router = createBrowserRouter([
  {
    path: "/callback",
    element: <CallbackPage />,
  },
  {
    path: "/logout",
    element: <LogoutPage />,
  },
  {
    path: "/mobilescan/:scanid",
    element: <MobileScanPage />,
  },
  {
    path: "/",
    element: (
      <AuthedLayout>
        <PageLayout>
          <DashboardPage />
        </PageLayout>
      </AuthedLayout>
    ),
  },
  {
    path: "/users",
    element: (
      <AuthedLayout>
        <UsersPage />
      </AuthedLayout>
    ),
  },
  {
    path: "/users/edit/:id",
    element: (
      <AuthedLayout>
        <EditUserPage />
      </AuthedLayout>
    ),
  },
  {
    path: "/invitations",
    element: (
      <AuthedLayout>
        <PageLayout>
          <InvitationsPage />
        </PageLayout>
      </AuthedLayout>
    ),
  },
  {
    path: "/invitations/edit/:id",
    element: (
      <AuthedLayout>
        <PageLayout>
          <EditInvitationPage />
        </PageLayout>
      </AuthedLayout>
    ),
  },
])

export function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}
