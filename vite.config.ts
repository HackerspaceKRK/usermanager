import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const authentikUrl = env.VITE_AUTHENTIK_URL || "https://auth.hskrk.pl";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      allowedHosts: true,
      proxy: {
        // Proxy Authentik API calls to avoid CORS when running pure Vite dev
        "/api/v3": {
          target: authentikUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
