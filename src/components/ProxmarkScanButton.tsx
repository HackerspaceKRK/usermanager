import { useState, useRef, useEffect } from "react"
import { UsbIcon, XIcon, AlertCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// Minimal Web Serial API types (not yet in lib.dom.d.ts everywhere)
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
}

interface Serial {
  requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPort>
}

declare global {
  interface Navigator {
    readonly serial?: Serial
  }
}

// ── Proxmark3 protocol constants ─────────────────────────────────────────────
const PM3_ACK = 0x00ff
const PM3_HF14A_READER = 0x0385

// ── Packet builder ────────────────────────────────────────────────────────────
// Implements sendCommandMix(HF_ISO14443A_READER, [1, 0]) from the Python library.
// Produces a 34-byte packet: PM3a header + 24-byte args block + a3 footer.
function buildHF14AReaderPacket(): Uint8Array {
  const pkt = new Uint8Array(34)
  const v = new DataView(pkt.buffer)
  pkt[0] = 0x50; pkt[1] = 0x4d; pkt[2] = 0x33; pkt[3] = 0x61 // 'PM3a'
  v.setUint16(4, 24, true)               // data length (ng=false → no 0x8000)
  v.setUint16(6, PM3_HF14A_READER, true) // cmd
  v.setBigUint64(8, 1n, true)            // arg0 = ISO14A_CONNECT
  // arg1, arg2 = 0 (already zeroed)
  pkt[32] = 0x61; pkt[33] = 0x33        // 'a3'
  return pkt
}

// ── Response parser ───────────────────────────────────────────────────────────
interface Pm3Response {
  cmd: number
  arg0: bigint
  data: Uint8Array
}

function parsePacket(bytes: Uint8Array): Pm3Response {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // NG format: 'PM3b' header
  if (bytes[0] === 0x50 && bytes[1] === 0x4d && bytes[2] === 0x33 && bytes[3] === 0x62) {
    const lenField = v.getUint16(4, true)
    const isNg = (lenField & 0x8000) !== 0
    return {
      cmd: v.getUint16(8, true),
      arg0: v.getBigUint64(10, true),
      data: bytes.slice(isNg ? 10 : 34, bytes.length - 2),
    }
  }
  // OLD format: cmd at offset 0, arg0 at offset 8, data from offset 32
  return {
    cmd: v.getUint16(0, true),
    arg0: v.getBigUint64(8, true),
    data: bytes.slice(32),
  }
}

// ── Serial connection wrapper ─────────────────────────────────────────────────
class Pm3Connection {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private port: SerialPort
  private buf = new Uint8Array(0)

  constructor(port: SerialPort) {
    this.port = port
    this.reader = port.readable!.getReader()
    this.writer = port.writable!.getWriter()
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read()
      if (done || !value) throw new Error("Serial port closed")
      const next = new Uint8Array(this.buf.length + value.length)
      next.set(this.buf)
      next.set(value, this.buf.length)
      this.buf = next
    }
    const out = this.buf.slice(0, n)
    this.buf = this.buf.slice(n)
    return out
  }

  async readResponse(): Promise<Pm3Response> {
    const pre = await this.readBytes(10)
    // NG format: 'PM3b' header
    if (pre[0] === 0x50 && pre[1] === 0x4d && pre[2] === 0x33 && pre[3] === 0x62) {
      const dataLen = new DataView(pre.buffer, pre.byteOffset).getUint16(4, true) & 0x7fff
      const rest = await this.readBytes(dataLen + 2)
      const full = new Uint8Array(10 + dataLen + 2)
      full.set(pre); full.set(rest, 10)
      return parsePacket(full)
    }
    // OLD format: 10 header bytes + 534 body bytes = 544 total
    const rest = await this.readBytes(534)
    const full = new Uint8Array(544)
    full.set(pre); full.set(rest, 10)
    return parsePacket(full)
  }

  // Read responses until ACK arrives, discarding WTX and other interspersed packets.
  async waitForAck(): Promise<Pm3Response> {
    for (;;) {
      const resp = await this.readResponse()
      if (resp.cmd === PM3_ACK) return resp
    }
  }

  async send(data: Uint8Array): Promise<void> {
    await this.writer.write(data)
  }

  async close(): Promise<void> {
    try { await this.reader.cancel() } catch { /* ignore */ }
    try { await this.writer.close() } catch { /* ignore */ }
    try { await this.port.close() } catch { /* ignore */ }
  }
}

// ── Animation components (same visual as MobileScanPage) ─────────────────────

function NfcSymbol({ className }: { className?: string }) {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path d="M9.5 9 C7.2 10.2 7.2 13.8 9.5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M7 7 C3.2 9.3 3.2 14.7 7 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" style={{ opacity: 0.45 }} />
      <path d="M14.5 9 C16.8 10.2 16.8 13.8 14.5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M17 7 C20.8 9.3 20.8 14.7 17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" style={{ opacity: 0.45 }} />
    </svg>
  )
}

function ProxmarkCardIcon({ flashing, flashKey }: { flashing: boolean; flashKey: number }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 160, height: 100 }}>
      {[0, 0.7, 1.4].map((delay, i) => (
        <div
          key={i}
          className="absolute inset-0 rounded-[16px] border-2 border-primary/45"
          style={{ animation: `nfc-pulse-inward 2.1s ease-out ${delay}s infinite` }}
        />
      ))}
      {flashKey > 0 && (
        <div
          key={flashKey}
          className="absolute inset-0 rounded-[16px] border-[3px] border-green-500"
          style={{ animation: "nfc-success-ping 0.55s ease-out forwards" }}
        />
      )}
      <div
        className={cn(
          "absolute inset-0 rounded-[16px] border-4 flex items-center justify-center transition-colors duration-400",
          flashing ? "border-green-500 bg-green-500/10" : "border-foreground/35 bg-background/60",
        )}
      >
        <NfcSymbol className={cn("transition-colors duration-400", flashing ? "text-green-500" : "text-foreground/50")} />
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────
interface ProxmarkScanButtonProps {
  onScan: (cardId: string) => void
}

type ProxmarkState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "scanning" }
  | { phase: "error"; message: string }

export function ProxmarkScanButton({ onScan }: ProxmarkScanButtonProps) {
  const hasSerial = typeof navigator !== "undefined" && "serial" in navigator

  const [popoverOpen, setPopoverOpen] = useState(false)
  const [state, setState] = useState<ProxmarkState>({ phase: "idle" })
  const [scannedCount, setScannedCount] = useState(0)
  const [isFlashing, setIsFlashing] = useState(false)
  const [flashKey, setFlashKey] = useState(0)

  const connRef = useRef<Pm3Connection | null>(null)
  const stoppedRef = useRef(true)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      stoppedRef.current = true
      connRef.current?.close()
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [])

  if (!hasSerial) return null

  function triggerFlash() {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlashKey((k) => k + 1)
    setIsFlashing(true)
    flashTimerRef.current = setTimeout(() => setIsFlashing(false), 850)
  }

  async function handleOpen() {
    if (connRef.current) return
    stoppedRef.current = false
    setScannedCount(0)
    setPopoverOpen(true)
    setState({ phase: "requesting" })

    let conn: Pm3Connection
    try {
      // requestPort() must be the first await — must stay within user gesture context
      const port = await navigator.serial!.requestPort()
      await port.open({ baudRate: 115200 })
      conn = new Pm3Connection(port)
      connRef.current = conn
    } catch (e) {
      const name = (e as DOMException).name
      if (name === "NotAllowedError" || name === "SecurityError" || name === "AbortError") {
        setPopoverOpen(false)
        setState({ phase: "idle" })
      } else {
        setState({ phase: "error", message: (e as Error).message ?? "Failed to open port" })
      }
      return
    }

    setState({ phase: "scanning" })
    const cmd = buildHF14AReaderPacket()

    // Scan loop — continues until Done/X is clicked or an error occurs.
    // reader.cancel() (called from handleClose) causes the pending read() to
    // resolve with {done:true}, propagating as "Serial port closed" below —
    // stoppedRef suppresses that as an error display.
    ;(async () => {
      while (!stoppedRef.current) {
        try {
          await conn.send(cmd)
          const resp = await conn.waitForAck()

          if (resp.arg0 !== 0n) {
            // iso14a_card_select_t: uid[0..9] then uidlen at offset 10
            const uidLen = resp.data[10]
            const uid = resp.data.slice(0, uidLen)
            const cardId = Array.from(uid)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
            triggerFlash()
            setScannedCount((c) => c + 1)
            onScan(cardId)
            // Pause before re-scanning so the same card isn't read twice in a row
            await new Promise<void>((r) => setTimeout(r, 500))
          } else {
            // No card present — brief pause then retry
            await new Promise<void>((r) => setTimeout(r, 100))
          }
        } catch {
          if (!stoppedRef.current) {
            setState({ phase: "error", message: "Lost connection to Proxmark" })
          }
          return
        }
      }
    })()
  }

  function handleClose() {
    stoppedRef.current = true
    connRef.current?.close()
    connRef.current = null
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setPopoverOpen(false)
    setState({ phase: "idle" })
    setScannedCount(0)
    setIsFlashing(false)
  }

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(v) => {
        if (v) handleOpen()
        // Closing is only allowed via the Done/X button
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <UsbIcon className="size-4" />
          Scan with Proxmark
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-80"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex items-start justify-between mb-3">
          <p className="text-sm font-medium">Proxmark scan</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 -mt-1"
            onClick={handleClose}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="h-64 flex flex-col items-center justify-center gap-3">
          {state.phase === "requesting" && (
            <>
              <UsbIcon className="size-8 text-muted-foreground animate-pulse" />
              <p className="text-sm text-muted-foreground">Waiting for port selection…</p>
            </>
          )}

          {state.phase === "scanning" && (
            <>
              <ProxmarkCardIcon flashing={isFlashing} flashKey={flashKey} />
              <p className="text-sm text-center text-muted-foreground">
                {scannedCount > 0
                  ? `${scannedCount} card${scannedCount !== 1 ? "s" : ""} scanned — tap another or press Done`
                  : "Tap a Mifare card to the Proxmark reader"}
              </p>
              <Button type="button" size="sm" variant={scannedCount > 0 ? "default" : "outline"} onClick={handleClose}>
                Done
              </Button>
            </>
          )}

          {state.phase === "error" && (
            <>
              <AlertCircleIcon className="size-8 text-destructive" />
              <p className="text-sm text-destructive text-center">{state.message}</p>
              <Button type="button" variant="outline" size="sm" onClick={handleClose}>
                Close
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
