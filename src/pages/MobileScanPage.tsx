import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { CheckCircleIcon, AlertCircleIcon, WifiIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Minimal Web NFC types
interface NDEFReadingEvent {
  serialNumber: string
}
declare class NDEFReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>
  addEventListener(type: "reading", cb: (e: NDEFReadingEvent) => void): void
}

type Phase =
  | "connecting"
  | "ready"
  | "requesting_permission"
  | "waiting_for_scan"
  | "scanned"
  | "nfc_not_supported"
  | "aborted"
  | "done"
  | "error"

const TERMINAL_PHASES = new Set<Phase>(["nfc_not_supported", "aborted", "done", "error"])

const SCANNING_PHASES = new Set<Phase>(["ready", "requesting_permission", "waiting_for_scan", "scanned"])

const PHASE_LABELS: Record<Phase, string> = {
  connecting: "Connecting to scan session…",
  ready: "Ready to scan",
  requesting_permission: "Grant NFC permission when prompted",
  waiting_for_scan: "Hold your Mifare card to the NFC reader",
  scanned: "Card scanned!",
  nfc_not_supported: "Web NFC is not supported on this device",
  aborted: "Scan was aborted",
  done: "Scan complete.",
  error: "An error occurred",
}

function wsUrl(scanId: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/scan/${scanId}`
}

// ── NFC card icon with animated rings ────────────────────────────────────────

function NfcSymbol({ className }: { className?: string }) {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      {/* left arcs */}
      <path
        d="M9.5 9 C7.2 10.2 7.2 13.8 9.5 15"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"
      />
      <path
        d="M7 7 C3.2 9.3 3.2 14.7 7 17"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"
        style={{ opacity: 0.45 }}
      />
      {/* right arcs */}
      <path
        d="M14.5 9 C16.8 10.2 16.8 13.8 14.5 15"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"
      />
      <path
        d="M17 7 C20.8 9.3 20.8 14.7 17 17"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"
        style={{ opacity: 0.45 }}
      />
    </svg>
  )
}

function NfcCardIcon({ flashing, flashKey }: { flashing: boolean; flashKey: number }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 200, height: 128 }}>
      {/* Inward pulsing rings — always visible while scanning */}
      {[0, 0.7, 1.4].map((delay, i) => (
        <div
          key={i}
          className="absolute inset-0 rounded-[20px] border-2 border-primary/45"
          style={{ animation: `nfc-pulse-inward 2.1s ease-out ${delay}s infinite` }}
        />
      ))}

      {/* One-shot success ping — remounts via key to replay */}
      {flashKey > 0 && (
        <div
          key={flashKey}
          className="absolute inset-0 rounded-[20px] border-[3px] border-green-500"
          style={{ animation: "nfc-success-ping 0.55s ease-out forwards" }}
        />
      )}

      {/* Card body */}
      <div
        className={cn(
          "absolute inset-0 rounded-[20px] border-4 flex items-center justify-center transition-colors duration-400",
          flashing
            ? "border-green-500 bg-green-500/10"
            : "border-foreground/35 bg-background/60",
        )}
      >
        <NfcSymbol
          className={cn(
            "transition-colors duration-400",
            flashing ? "text-green-500" : "text-foreground/50",
          )}
        />
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function MobileScanPage() {
  const { scanid } = useParams<{ scanid: string }>()
  const [phase, setPhase] = useState<Phase>("connecting")
  const [detail, setDetail] = useState("")
  const [isFlashing, setIsFlashing] = useState(false)
  const [flashKey, setFlashKey] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const abortCtrlRef = useRef<AbortController | null>(null)
  const scanSuccessRef = useRef(false)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function triggerFlash() {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlashKey((k) => k + 1)
    setIsFlashing(true)
    flashTimerRef.current = setTimeout(() => setIsFlashing(false), 850)
  }

  function handleDone() {
    setPhase("done")
    wsRef.current?.close()
    wsRef.current = null
  }

  async function startNfc(ws: WebSocket, fallbackToButton?: boolean): Promise<void> {
    setPhase("requesting_permission")
    ws.send(JSON.stringify({ type: "status", message: "requesting_permission" }))

    const ctrl = new AbortController()
    abortCtrlRef.current = ctrl

    try {
      const reader = new NDEFReader()
      reader.addEventListener("reading", (e) => {
        const cardId = e.serialNumber.replace(/:/g, "").toLowerCase()
        ws.send(JSON.stringify({ type: "card_id", cardId }))
        scanSuccessRef.current = true
        setPhase("scanned")
        triggerFlash()
      })
      await reader.scan({ signal: ctrl.signal })
      setPhase("waiting_for_scan")
      ws.send(JSON.stringify({ type: "status", message: "waiting_for_scan" }))
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      const errName = (err as Error).name
      if (fallbackToButton && (errName === "NotAllowedError" || errName === "SecurityError")) {
        setPhase("ready")
        ws.send(JSON.stringify({ type: "status", message: "ready" }))
        return
      }
      setPhase("aborted")
      ws.send(JSON.stringify({ type: "status", message: "aborted" }))
      setDetail((err as Error).message ?? "")
    }
  }

  useEffect(() => {
    if (!scanid) {
      setPhase("error")
      setDetail("Missing scan ID")
      return
    }

    scanSuccessRef.current = false
    const ws = new WebSocket(wsUrl(scanid))
    wsRef.current = ws

    ws.addEventListener("close", () => {
      abortCtrlRef.current?.abort()
      if (scanSuccessRef.current) {
        setPhase("done")
        return
      }
      setPhase((p) => (TERMINAL_PHASES.has(p) ? p : "error"))
      setDetail("Connection lost")
    })

    ws.addEventListener("error", () => {
      setPhase("error")
      setDetail("Could not connect to scan session")
    })

    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string) as { type: string }
      if (msg.type === "connected") {
        if (!("NDEFReader" in window)) {
          setPhase("nfc_not_supported")
          ws.send(JSON.stringify({ type: "status", message: "nfc_not_supported" }))
          return
        }
        void startNfc(ws, true)
      }
    })

    return () => {
      abortCtrlRef.current?.abort()
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      ws.close()
      wsRef.current = null
    }
  }, [scanid])

  const showNfcIcon = SCANNING_PHASES.has(phase)

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-8 p-8">

      {/* Connecting spinner */}
      {phase === "connecting" && (
        <WifiIcon className="size-16 text-muted-foreground animate-pulse" />
      )}

      {/* NFC card icon — shown for all active scanning phases */}
      {showNfcIcon && (
        <NfcCardIcon flashing={isFlashing} flashKey={flashKey} />
      )}

      {/* Done / error icons */}
      {phase === "done" && (
        <CheckCircleIcon className="size-16 text-green-500" />
      )}
      {(phase === "nfc_not_supported" || phase === "aborted" || phase === "error") && (
        <AlertCircleIcon
          className={cn(
            "size-16",
            phase === "error" || phase === "nfc_not_supported"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        />
      )}

      {/* Status text */}
      <div className="text-center space-y-2">
        <h1 className="text-xl font-semibold">{PHASE_LABELS[phase]}</h1>
        {phase === "done" && (
          <p className="text-sm text-muted-foreground">You can now close this page.</p>
        )}
        {detail && phase !== "done" && (
          <p className="text-sm text-muted-foreground">{detail}</p>
        )}
        {phase === "waiting_for_scan" && (
          <p className="text-sm text-muted-foreground">
            Tap your Mifare card or fob to the back of this phone.
          </p>
        )}
        {phase === "scanned" && (
          <p className="text-sm text-muted-foreground">
            Tap another card to scan it, or press Done.
          </p>
        )}
      </div>

      {/* Action buttons */}
      {phase === "ready" && (
        <Button
          size="lg"
          onClick={() => {
            const ws = wsRef.current
            if (ws) void startNfc(ws)
          }}
        >
          Start scan
        </Button>
      )}

      {(phase === "scanned" || phase === "waiting_for_scan") && scanSuccessRef.current && (
        <Button size="lg" variant="outline" onClick={handleDone}>
          Done
        </Button>
      )}
    </div>
  )
}
