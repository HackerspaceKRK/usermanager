package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

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

func (h *scanHub) handleDesktopScan(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("scan WS upgrade: %v", err)
		return
	}

	// Generate random scan ID
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

	// Tell the desktop its scan ID
	if err := conn.WriteJSON(scanMsg{Type: "scanid", ScanID: scanID}); err != nil {
		return
	}

	// Pump: forward any message from mobile to desktop; desktop sends nothing meaningful
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			return
		}
	}
}

func (h *scanHub) handleMobileScan(w http.ResponseWriter, r *http.Request) {
	scanID := strings.TrimPrefix(r.URL.Path, "/ws/scan/")
	if scanID == "" {
		http.NotFound(w, r)
		return
	}

	h.mu.Lock()
	sess, ok := h.sessions[scanID]
	h.mu.Unlock()
	if !ok {
		http.Error(w, "scan session not found", http.StatusNotFound)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("mobile WS upgrade: %v", err)
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

	// Acknowledge to mobile
	if err := conn.WriteJSON(scanMsg{Type: "connected"}); err != nil {
		return
	}
	// Notify desktop
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
