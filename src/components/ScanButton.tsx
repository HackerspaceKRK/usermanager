import { useState, useRef, useEffect } from "react"
import { QRCodeSVG } from "qrcode.react"
import { ScanIcon, XIcon, WifiIcon, SmartphoneIcon, CheckCircleIcon, AlertCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// Minimal Web NFC types — not in @types yet
interface NDEFReadingEvent {
  serialNumber: string
}
declare class NDEFReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>
  addEventListener(type: "reading", cb: (e: NDEFReadingEvent) => void): void
  removeEventListener(type: "reading", cb: (e: NDEFReadingEvent) => void): void
}

interface WebNFCScanButtonProps {
  onScan: (cardId: string) => void
}

type DesktopState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "waiting_qr"; scanId: string; qrUrl: string }
  | { phase: "phone_connected"; status: string }
  | { phase: "scanned"; cardId: string }
  | { phase: "error"; message: string }

const STATUS_LABELS: Record<string, string> = {
  ready: "Tap 'Start scan' on your phone",
  requesting_permission: "Requesting NFC permission on phone…",
  waiting_for_scan: "Waiting for NFC tag — tap your card to the phone",
  aborted: "Scan aborted on phone",
  nfc_not_supported: "Web NFC not supported on that device",
  scanned: "Card scanned — tap another or press Done",
}

function wsUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/scan`
}

export function WebNFCScanButton({ onScan }: WebNFCScanButtonProps) {
  const hasNfc = typeof window !== "undefined" && "NDEFReader" in window

  // ── Mobile path (Web NFC) ────────────────────────────────────────────────
  const [nfcOpen, setNfcOpen] = useState(false)
  const [nfcError, setNfcError] = useState<string | null>(null)
  const nfcAbortRef = useRef<AbortController | null>(null)

  async function startMobileNfc() {
    setNfcError(null)
    setNfcOpen(true)
    const ctrl = new AbortController()
    nfcAbortRef.current = ctrl
    try {
      const reader = new NDEFReader()
      reader.addEventListener("reading", (e) => {
        const cardId = e.serialNumber.replace(/:/g, "").toLowerCase()
        onScan(cardId)
        ctrl.abort()
        setNfcOpen(false)
      })
      await reader.scan({ signal: ctrl.signal })
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setNfcError((err as Error).message ?? "NFC error")
      }
    }
  }

  function cancelNfc() {
    nfcAbortRef.current?.abort()
    setNfcOpen(false)
    setNfcError(null)
  }

  // ── Desktop path (WebSocket + QR code) ───────────────────────────────────
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [desktopState, setDesktopState] = useState<DesktopState>({ phase: "idle" })
  const wsRef = useRef<WebSocket | null>(null)
  // Persists the scan session URL across phone_connected → phone_disconnected transitions
  const sessionQrRef = useRef<{ scanId: string; qrUrl: string } | null>(null)
  // Tracks whether a card was scanned this session
  const scanCompletedRef = useRef(false)

  function closeDesktopScan() {
    wsRef.current?.close()
    wsRef.current = null
    sessionQrRef.current = null
    scanCompletedRef.current = false
    setPopoverOpen(false)
    setDesktopState({ phase: "idle" })
  }

  useEffect(() => {
    if (!popoverOpen) return

    scanCompletedRef.current = false
    setDesktopState({ phase: "connecting" })
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws

    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string
        scanid?: string
        message?: string
        cardId?: string
      }

      if (msg.type === "scanid" && msg.scanid) {
        const qrUrl = `${window.location.origin}/mobilescan/${msg.scanid}`
        sessionQrRef.current = { scanId: msg.scanid, qrUrl }
        setDesktopState({ phase: "waiting_qr", scanId: msg.scanid, qrUrl })
      } else if (msg.type === "phone_connected") {
        setDesktopState({
          phase: "phone_connected",
          status: "Phone connected — follow instructions on your phone",
        })
      } else if (msg.type === "phone_disconnected") {
        if (scanCompletedRef.current) {
          // Mobile pressed Done after a successful scan — close the popover
          closeDesktopScan()
        } else {
          const session = sessionQrRef.current
          if (session) {
            setDesktopState({ phase: "waiting_qr", scanId: session.scanId, qrUrl: session.qrUrl })
          }
        }
      } else if (msg.type === "status" && msg.message) {
        setDesktopState({ phase: "phone_connected", status: STATUS_LABELS[msg.message] ?? msg.message })
      } else if (msg.type === "card_id" && msg.cardId) {
        scanCompletedRef.current = true
        onScan(msg.cardId)
        setDesktopState({ phase: "scanned", cardId: msg.cardId })
      }
    })

    ws.addEventListener("error", () => setDesktopState({ phase: "error", message: "WebSocket connection failed" }))
    ws.addEventListener("close", () => {
      if (wsRef.current === ws) wsRef.current = null
    })

    return () => {
      ws.close()
    }
  }, [popoverOpen])

  // ── Render ────────────────────────────────────────────────────────────────
  if (hasNfc) {
    return (
      <>
        <Button type="button" variant="outline" size="sm" onClick={startMobileNfc}>
          <ScanIcon className="size-4" />
          Scan with Android Phone
        </Button>

        <Dialog open={nfcOpen} onOpenChange={(v) => { if (!v) cancelNfc() }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Tap NFC tag</DialogTitle>
            </DialogHeader>
            <div className="py-6 flex flex-col items-center gap-4">
              <ScanIcon className="size-12 text-muted-foreground animate-pulse" />
              <p className="text-sm text-muted-foreground text-center">
                Hold your Mifare card to the NFC reader on this device.
              </p>
              {nfcError && (
                <p className="text-sm text-destructive">{nfcError}</p>
              )}
              <Button variant="outline" onClick={cancelNfc}>Cancel</Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  // Desktop popover
  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(v) => {
        if (v) setPopoverOpen(true)
        // Closing is only allowed via the X button
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ScanIcon className="size-4" />
          Scan with Android Phone
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-80"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex items-start justify-between mb-3">
          <p className="text-sm font-medium">Scan via phone</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 -mt-1"
            onClick={closeDesktopScan}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        {/* Fixed-height body so the popover never resizes between phases */}
        <div className="h-64 flex flex-col items-center justify-center gap-3">
          {desktopState.phase === "connecting" && (
            <>
              <WifiIcon className="size-8 text-muted-foreground animate-pulse" />
              <p className="text-sm text-muted-foreground">Connecting…</p>
            </>
          )}

          {desktopState.phase === "waiting_qr" && (
            <>
              <p className="text-xs text-muted-foreground text-center">
                Scan this QR code with your Android phone to use its NFC reader
              </p>
              <div className="p-2 bg-white rounded-md">
                <QRCodeSVG value={desktopState.qrUrl} size={176} />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Works on Android Google Chrome only
              </p>
            </>
          )}

          {desktopState.phase === "phone_connected" && (
            <>
              <SmartphoneIcon className="size-8 text-primary" />
              <p className="text-sm text-center">{desktopState.status}</p>
              {sessionQrRef.current && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => {
                    const s = sessionQrRef.current
                    if (s) setDesktopState({ phase: "waiting_qr", scanId: s.scanId, qrUrl: s.qrUrl })
                  }}
                >
                  Show QR again
                </button>
              )}
            </>
          )}

          {desktopState.phase === "error" && (
            <>
              <AlertCircleIcon className="size-8 text-destructive" />
              <p className="text-sm text-destructive text-center">{desktopState.message}</p>
            </>
          )}

          {desktopState.phase === "scanned" && (
            <>
              <CheckCircleIcon className="size-8 text-green-500" />
              <p className="text-sm font-mono text-muted-foreground">{desktopState.cardId}</p>
              <p className="text-xs text-muted-foreground text-center">
                Tap another card on the phone, or press Done
              </p>
              <Button type="button" size="sm" onClick={closeDesktopScan}>
                Done
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
