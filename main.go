package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
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

	authentikTarget, err := url.Parse(authentikURL)
	if err != nil {
		log.Fatalf("invalid AUTHENTIK_URL: %v", err)
	}

	// Proxy for Authentik API calls — fixes CORS by making them same-origin
	authentikProxy := httputil.NewSingleHostReverseProxy(authentikTarget)
	base := authentikProxy.Director
	authentikProxy.Director = func(req *http.Request) {
		base(req)
		req.Host = authentikTarget.Host
	}

	mux := http.NewServeMux()

	// WebSocket scan relay
	hub := newScanHub()
	mux.HandleFunc("/ws/scan", hub.handleDesktopScan)
	mux.HandleFunc("/ws/scan/", hub.handleMobileScan)

	// Proxy /api/v3/ to Authentik
	mux.Handle("/api/v3/", authentikProxy)

	if *devMode {
		log.Println("Dev mode: starting Vite dev server…")
		cmd := exec.Command("npm", "run", "dev", "--", "--host", "0.0.0.0")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Fatalf("failed to start Vite: %v", err)
		}
		defer func() { _ = cmd.Process.Kill() }()

		viteTarget, _ := url.Parse("http://localhost:5173")
		viteProxy := httputil.NewSingleHostReverseProxy(viteTarget)
		mux.Handle("/", viteProxy)
	} else {
		// Serve config.js dynamically from environment variables (production only)
		mux.HandleFunc("/config.js", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/javascript")
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			fmt.Fprintf(w, "window.APP_CONFIG = { authentikUrl: %q, clientId: %q };\n", authentikURL, clientID)
		})

		distFS, err := fs.Sub(frontendFiles, "dist")
		if err != nil {
			log.Fatalf("failed to access embedded dist: %v", err)
		}
		fileServer := http.FileServer(http.FS(distFS))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			// SPA routing: serve index.html for paths that don't map to real files
			trimmed := strings.TrimPrefix(r.URL.Path, "/")
			if trimmed != "" && trimmed != "index.html" {
				if _, err := fs.Stat(distFS, trimmed); err != nil {
					r2 := r.Clone(r.Context())
					r2.URL.Path = "/"
					fileServer.ServeHTTP(w, r2)
					return
				}
			}
			fileServer.ServeHTTP(w, r)
		})
	}

	log.Printf("Listening on %s  dev=%v  authentik=%s", *addr, *devMode, authentikURL)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
