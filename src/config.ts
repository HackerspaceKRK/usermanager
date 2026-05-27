declare global {
  interface Window {
    APP_CONFIG?: {
      authentikUrl?: string;
      clientId?: string;
    };
  }
}

export const AUTHENTIK_URL: string =
  window.APP_CONFIG?.authentikUrl ??
  import.meta.env.VITE_AUTHENTIK_URL ??
  "https://auth.hskrk.pl";

export const CLIENT_ID: string | undefined =
  window.APP_CONFIG?.clientId ?? import.meta.env.VITE_CLIENT_ID;
