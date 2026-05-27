package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"

	ws "github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/filesystem"
	"github.com/gofiber/fiber/v2/middleware/proxy"
)

//go:embed all:dist
var frontendFiles embed.FS

func main() {
	devMode := flag.Bool("dev", false, "Start Vite dev server and proxy to it")
	addr := flag.String("addr", ":8080", "Listen address")
	flag.Parse()

	authentikURL := os.Getenv("AUTHENTIK_URL")
	if authentikURL == "" {
		authentikURL = "https://auth.hskrk.pl"
	}
	clientID := os.Getenv("OAUTH_CLIENT_ID")

	app := fiber.New(fiber.Config{
		ReadBufferSize: 16 * 1024,
	})

	// WebSocket scan relay
	hub := newScanHub()
	app.Get("/ws/scan", ws.New(hub.handleDesktopScan))
	app.Get("/ws/scan/:scanid", func(c *fiber.Ctx) error {
		scanID := c.Params("scanid")
		hub.mu.Lock()
		_, ok := hub.sessions[scanID]
		hub.mu.Unlock()
		if !ok {
			return c.Status(fiber.StatusNotFound).SendString("scan session not found")
		}
		return c.Next()
	}, ws.New(hub.handleMobileScan))

	// Local endpoints backed by the in-memory user cache
	cache := &userCache{}
	app.Get("/api/local/cached-users", handleCachedUsers(cache, authentikURL))
	app.Get("/api/local/summary", handleSummary(cache, authentikURL))

	// Proxy /api/v3/ to Authentik
	app.All("/api/v3/*", func(c *fiber.Ctx) error {
		return proxy.Do(c, authentikURL+c.OriginalURL())
	})

	if *devMode {
		log.Println("Dev mode: starting Vite dev server…")
		cmd := exec.Command("npm", "run", "dev", "--", "--host", "0.0.0.0")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Fatalf("failed to start Vite: %v", err)
		}
		defer func() { _ = cmd.Process.Kill() }()

		app.Use(func(c *fiber.Ctx) error {
			return proxy.Do(c, "http://localhost:5173"+c.OriginalURL())
		})
	} else {
		// Serve config.js dynamically from environment variables (production only)
		app.Get("/config.js", func(c *fiber.Ctx) error {
			c.Set("Content-Type", "application/javascript")
			c.Set("Cache-Control", "no-store, no-cache, must-revalidate")
			return c.SendString(fmt.Sprintf("window.APP_CONFIG = { authentikUrl: %q, clientId: %q };\n", authentikURL, clientID))
		})

		distFS, err := fs.Sub(frontendFiles, "dist")
		if err != nil {
			log.Fatalf("failed to access embedded dist: %v", err)
		}
		app.Use(filesystem.New(filesystem.Config{
			Root:         http.FS(distFS),
			Index:        "index.html",
			NotFoundFile: "index.html",
		}))
	}

	log.Printf("Listening on %s  dev=%v  authentik=%s", *addr, *devMode, authentikURL)
	log.Fatal(app.Listen(*addr))
}
