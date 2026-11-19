const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// drive.file only reaches files this app created or the user picked. Google
// classes it as non-sensitive, so the OAuth client needs no verification review.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Kept in sessionStorage so a reload inside the token's lifetime does not
// need a popup, which browsers block outside a user gesture.
const TOKEN_STORAGE_KEY = "excalidraw-gdrive-token";

// Renew a little early so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 60 * 1000;

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void;
  error_callback?: (error: { type: string; message?: string }) => void;
  requestAccessToken: (overrides?: { prompt?: string }) => void;
};

type GoogleOAuth2 = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type: string; message?: string }) => void;
  }) => GoogleTokenClient;
  revoke: (token: string, done?: () => void) => void;
};

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

type StoredToken = { accessToken: string; expiresAt: number };

export const getGoogleClientId = (): string | null =>
  import.meta.env.VITE_APP_GOOGLE_CLIENT_ID || null;

export const isGoogleDriveEnabled = () => !!getGoogleClientId();

let scriptPromise: Promise<GoogleOAuth2> | null = null;

const loadGoogleIdentityServices = (): Promise<GoogleOAuth2> => {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve(window.google.accounts.oauth2);
  }
  if (!scriptPromise) {
    scriptPromise = new Promise<GoogleOAuth2>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.onload = () => {
        const oauth2 = window.google?.accounts?.oauth2;
        if (oauth2) {
          resolve(oauth2);
        } else {
          reject(new Error("Google Identity Services failed to initialize"));
        }
      };
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error("Couldn't load Google sign-in"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
};

const readStoredToken = (): StoredToken | null => {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const token = JSON.parse(raw) as StoredToken;
    if (
      typeof token?.accessToken !== "string" ||
      typeof token?.expiresAt !== "number"
    ) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
};

const writeStoredToken = (token: StoredToken | null) => {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // storage blocked (private mode, sandboxed iframe): token lives in memory
  }
};

let currentToken: StoredToken | null = readStoredToken();

export const getValidAccessToken = (): string | null => {
  if (currentToken && currentToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return currentToken.accessToken;
  }
  return null;
};

export const clearAccessToken = () => {
  currentToken = null;
  writeStoredToken(null);
};

/**
 * Opens Google's consent popup, so call it only from a user gesture.
 * `prompt: ""` skips the consent screen for users who already granted access.
 */
export const requestAccessToken = async (opts: {
  hasConsentedBefore: boolean;
}): Promise<string> => {
  const clientId = getGoogleClientId();
  if (!clientId) {
    throw new Error("Google Drive is not configured");
  }
  const oauth2 = await loadGoogleIdentityServices();

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ||
                response.error ||
                "Google sign-in failed",
            ),
          );
          return;
        }
        currentToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        };
        writeStoredToken(currentToken);
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(
          new Error(
            error.type === "popup_closed"
              ? "Google sign-in was cancelled"
              : error.message || "Google sign-in failed",
          ),
        );
      },
    });
    client.requestAccessToken({
      prompt: opts.hasConsentedBefore ? "" : "consent",
    });
  });
};

export const revokeAccessToken = async () => {
  const token = currentToken?.accessToken;
  clearAccessToken();
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token);
  }
};
