import { useEffect } from "react";
import { AUTHENTIK_URL, CLIENT_ID } from "../config";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

export function CallbackPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const storedState = sessionStorage.getItem("um_oauth_state");
    const verifier = sessionStorage.getItem("um_pkce_verifier");

    if (!code || !state || state !== storedState || !verifier || !CLIENT_ID) {
      window.location.href = "/";
      return;
    }

    fetch(`${AUTHENTIK_URL}/application/o/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${window.location.origin}/callback`,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    })
      .then((r) => r.json() as Promise<TokenResponse>)
      .then((data) => {
        if (data.access_token) {
          const expiresIn = data.expires_in ?? 3600;
          localStorage.setItem("um_access_token", data.access_token);
          localStorage.setItem(
            "um_token_expiry",
            String(Date.now() + expiresIn * 1000),
          );
          if (data.refresh_token) {
            localStorage.setItem("um_refresh_token", data.refresh_token);
          }
          sessionStorage.removeItem("um_pkce_verifier");
          sessionStorage.removeItem("um_oauth_state");
        }
        window.location.href = "/";
      })
      .catch(() => {
        window.location.href = "/";
      });
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="text-center space-y-2">
        <div className="text-lg font-medium">Authenticating…</div>
        <div className="text-sm text-muted-foreground">
          Exchanging authorization code
        </div>
      </div>
    </div>
  );
}
