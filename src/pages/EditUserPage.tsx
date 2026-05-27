import { useState, useEffect } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { format, addDays } from "date-fns"
import { fromZonedTime, toZonedTime } from "date-fns-tz"
import {
  ArrowLeftIcon,
  PlusIcon,
  XIcon,
  SaveIcon,
  Loader2Icon,
} from "lucide-react"
import { useAuth } from "@/auth/AuthContext"
import { getUser, updateUser, createUser, listGroups } from "@/api/authentik"
import type { User, Group } from "@/api/authentik"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageLayout } from "@/components/PageLayout"
import { ScanButton } from "@/components/ScanButton"
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox"

const TZ = "Europe/Warsaw"

function tsToDateStr(ts: number): string {
  return format(toZonedTime(new Date(ts * 1000), TZ), "yyyy-MM-dd")
}

function dateStrToTs(s: string): number {
  return Math.floor(fromZonedTime(`${s}T23:59:00`, TZ).getTime() / 1000)
}

function extendDate(currentDateStr: string, days: number): string {
  const now = new Date()
  const current = currentDateStr ? new Date(currentDateStr + "T00:00:00") : null
  const base = current && current > now ? current : now
  return format(addDays(base, days), "yyyy-MM-dd")
}

// ── Small reusable list row ───────────────────────────────────────────────────

function ListRow({
  children,
  onRemove,
}: {
  children: React.ReactNode
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">{children}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
}

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function EditUserPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === "new"
  const pk = isNew ? null : parseInt(id ?? "", 10)

  const { token, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const chipsAnchor = useComboboxAnchor()

  // Form state
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [bankAccount, setBankAccount] = useState("")
  const [membershipDate, setMembershipDate] = useState("") // "yyyy-MM-dd" or ""
  const [telegramIds, setTelegramIds] = useState<string[]>([])
  const [mifareIds, setMifareIds] = useState<string[]>([])
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]) // group UUIDs
  const [allGroups, setAllGroups] = useState<Group[]>([])

  const [loadingUser, setLoadingUser] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Load all groups once
  useEffect(() => {
    if (!token) return
    listGroups(token).then(setAllGroups).catch(console.error)
  }, [token])

  // Load existing user
  useEffect(() => {
    if (isNew || !token || pk === null || isNaN(pk)) {
      setLoadingUser(false)
      return
    }
    setLoadingUser(true)
    getUser(token, pk)
      .then((u: User) => {
        setUsername(u.username)
        setEmail(u.email ?? "")
        setDisplayName(u.name ?? "")
        setBankAccount(u.attributes.bankAccountNumber ?? "")
        if (u.attributes.membershipExpirationTimestamp) {
          setMembershipDate(tsToDateStr(u.attributes.membershipExpirationTimestamp))
        }
        setTelegramIds(u.attributes.telegramIDs?.map(String) ?? [])
        setMifareIds(u.attributes.mifareCardId ?? [])
        setSelectedGroups(u.groups ?? [])
        setLoadingUser(false)
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : String(err))
        setLoadingUser(false)
      })
  }, [token, pk, isNew])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!token) return
    setSaving(true)
    setSaveError(null)

    const attributes = {
      bankAccountNumber: bankAccount || undefined,
      membershipExpirationTimestamp: membershipDate
        ? dateStrToTs(membershipDate)
        : undefined,
      telegramIDs: telegramIds.filter(Boolean),
      mifareCardId: mifareIds.filter(Boolean),
    }

    try {
      if (isNew) {
        await createUser(token, {
          username,
          email: email || undefined,
          name: displayName || undefined,
          attributes,
          groups: selectedGroups,
        })
      } else if (pk !== null) {
        await updateUser(token, pk, {
          username,
          email: email || undefined,
          name: displayName || undefined,
          attributes,
          groups: selectedGroups,
        })
      }
      navigate("/users")
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  if (authLoading || loadingUser) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/users">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">
            {isNew ? "Create User" : `Edit User`}
          </h1>
        </div>

        <form onSubmit={(e) => { void handleSave(e) }} className="space-y-6">
          {/* Core fields */}
          <div className="space-y-4">
            <Field label="Username" htmlFor="username">
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field label="Display name" htmlFor="displayName">
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>

            <Field label="Bank account number" htmlFor="bankAccount">
              <Input
                id="bankAccount"
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)}
              />
            </Field>

            <Field label="Groups">
              <Combobox
                items={allGroups.map((g) => g.pk)}
                filter={(pk, query) => {
                  const name = allGroups.find((g) => g.pk === pk)?.name ?? ""
                  return name.toLowerCase().includes(query.toLowerCase())
                }}
                multiple
                value={selectedGroups}
                onValueChange={setSelectedGroups}
              >
                <ComboboxChips ref={chipsAnchor}>
                  <ComboboxValue>
                    {selectedGroups.map((pk) => (
                      <ComboboxChip key={pk}>
                        {allGroups.find((g) => g.pk === pk)?.name ?? pk}
                      </ComboboxChip>
                    ))}
                  </ComboboxValue>
                  <ComboboxChipsInput placeholder="Add group…" />
                </ComboboxChips>
                <ComboboxContent anchor={chipsAnchor}>
                  <ComboboxEmpty>No groups found.</ComboboxEmpty>
                  <ComboboxList>
                    {(pk) => (
                      <ComboboxItem key={pk} value={pk}>
                        {allGroups.find((g) => g.pk === pk)?.name ?? pk}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </Field>
          </div>

          {/* Membership expiration */}
          <div className="space-y-1.5">
            <Label htmlFor="membershipDate">Membership expiration</Label>
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                id="membershipDate"
                type="date"
                value={membershipDate}
                onChange={(e) => setMembershipDate(e.target.value)}
                className="w-44"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMembershipDate(extendDate(membershipDate, 1))}
              >
                +1 day
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMembershipDate(extendDate(membershipDate, 7))}
              >
                +7 days
              </Button>
              {membershipDate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setMembershipDate("")}
                >
                  Clear
                </Button>
              )}
            </div>
            {membershipDate && (
              <p className="text-xs text-muted-foreground">
                Expires {membershipDate} at 23:59 Europe/Warsaw (
                {format(
                  fromZonedTime(`${membershipDate}T23:59:00`, TZ),
                  "yyyy-MM-dd HH:mm 'UTC'",
                )}
                )
              </p>
            )}
          </div>

          {/* Telegram IDs */}
          <div className="space-y-2">
            <Label>Telegram IDs</Label>
            <div className="space-y-2">
              {telegramIds.map((v, i) => (
                <ListRow key={i} onRemove={() => setTelegramIds((prev) => prev.filter((_, j) => j !== i))}>
                  <Input
                    type="number"
                    value={v}
                    placeholder="e.g. 123456789"
                    onChange={(e) =>
                      setTelegramIds((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                </ListRow>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTelegramIds((prev) => [...prev, ""])}
            >
              <PlusIcon className="size-4" />
              Add Telegram ID
            </Button>
          </div>

          {/* Mifare Card IDs */}
          <div className="space-y-2">
            <Label>Mifare Card IDs</Label>
            <div className="space-y-2">
              {mifareIds.map((v, i) => (
                <ListRow key={i} onRemove={() => setMifareIds((prev) => prev.filter((_, j) => j !== i))}>
                  <Input
                    value={v}
                    placeholder="e.g. 04a2b3c4"
                    className="font-mono"
                    onChange={(e) =>
                      setMifareIds((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                </ListRow>
              ))}
            </div>
            <div className="flex items-center gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMifareIds((prev) => [...prev, ""])}
              >
                <PlusIcon className="size-4" />
                Add manually
              </Button>
              <ScanButton onScan={(cardId) => setMifareIds((prev) => prev.includes(cardId) ? prev : [...prev, cardId])} />
            </div>
          </div>

          {saveError && (
            <div className="rounded-md bg-destructive/10 text-destructive px-4 py-2 text-sm border border-destructive/20">
              {saveError}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <SaveIcon className="size-4" />
              )}
              {isNew ? "Create User" : "Save Changes"}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate("/users")}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </PageLayout>
  )
}
