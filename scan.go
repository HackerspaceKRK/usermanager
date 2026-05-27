package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"sync"

	"github.com/gofiber/contrib/websocket"
)

type scanMsg struct {
	Type    string `json:"type"`
	ScanID  string `json:"scanid,omitempty"`
	Message string `json:"message,omitempty"`
	CardID  string `json:"cardId,omitempty"`
}

type scanSession struct {
	mu      sync.Mutex
	desktop *websocket.Conn
	mobile  *websocket.Conn
}

type scanHub struct {
	mu       sync.Mutex
	sessions map[string]*scanSession
}

func newScanHub() *scanHub {
	return &scanHub{sessions: make(map[string]*scanSession)}
}

func (h *scanHub) handleDesktopScan(conn *websocket.Conn) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		_ = conn.Close()
		return
	}
	scanID := hex.EncodeToString(buf)

	sess := &scanSession{desktop: conn}
	h.mu.Lock()
	h.sessions[scanID] = sess
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.sessions, scanID)
		h.mu.Unlock()
		sess.mu.Lock()
		if sess.mobile != nil {
			_ = sess.mobile.Close()
		}
		sess.mu.Unlock()
		_ = conn.Close()
	}()

	if err := conn.WriteJSON(scanMsg{Type: "scanid", ScanID: scanID}); err != nil {
		return
	}

	// Pump desktop reads — desktop sends nothing meaningful but we need to drain
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (h *scanHub) handleMobileScan(conn *websocket.Conn) {
	scanID := conn.Params("scanid")

	h.mu.Lock()
	sess, ok := h.sessions[scanID]
	h.mu.Unlock()
	if !ok {
		log.Printf("mobile WS: session %q not found", scanID)
		return
	}

	sess.mu.Lock()
	sess.mobile = conn
	desktop := sess.desktop
	sess.mu.Unlock()

	defer func() {
		sess.mu.Lock()
		sess.mobile = nil
		sess.mu.Unlock()
		_ = conn.Close()
		if desktop != nil {
			_ = desktop.WriteJSON(scanMsg{Type: "phone_disconnected"})
		}
	}()

	if err := conn.WriteJSON(scanMsg{Type: "connected"}); err != nil {
		return
	}
	if desktop != nil {
		if err := desktop.WriteJSON(scanMsg{Type: "phone_connected"}); err != nil {
			return
		}
	}

	// Relay mobile → desktop
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg scanMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if desktop != nil {
			if err := desktop.WriteJSON(msg); err != nil {
				return
			}
		}
	}
}
