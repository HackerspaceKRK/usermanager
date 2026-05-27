import { AppNavbar } from "@/components/AppNavbar"

export function PageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <AppNavbar />
      <main className="flex-1 p-6">
        {children}
      </main>
    </div>
  )
}
