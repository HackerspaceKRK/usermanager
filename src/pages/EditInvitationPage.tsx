import { useParams } from "react-router-dom"

export function EditInvitationPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className="flex items-center justify-center h-64 text-muted-foreground">
      {id === "new" ? "Create Invitation" : `Edit Invitation #${id}`} — coming soon
    </div>
  )
}
