import { createPublicKey, createVerify } from "node:crypto";

import type { JsonWebKey } from "node:crypto";

export const GOOGLE_ENDPOINTS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  certs: "https://www.googleapis.com/oauth2/v3/certs",
};

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCOPES = ["openid", "email", "profile", DRIVE_FILE_SCOPE];

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
// tolerate small clock drift between this server and Google
const CLOCK_SKEW_SEC = 60;
const DEFAULT_KEYS_MAX_AGE_MS = 60 * 60 * 1000;
// /auth/check sits in front of every request, so a hung Google call must not
// hang the site
const REQUEST_TIMEOUT_MS = 5000;

export type IdTokenClaims = {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  picture?: string;
  iss: string;
  aud: string;
  exp: number;
};

export type TokenSet = {
  accessToken: string;
  expiresAt: number;
  /** Space-separated; users can untick individual scopes on the consent screen. */
  scope: string;
};

/** The user's grant is gone: revoked, account disabled or deleted. */
export class GrantRevokedError extends Error {
  constructor() {
    super("Google refused the refresh token");
    this.name = "GrantRevokedError";
  }
}

export class GoogleError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GoogleError";
  }
}

type FetchFn = typeof fetch;

const decodeJwtPart = <T>(part: string): T =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;

const parseMaxAge = (cacheControl: string | null) => {
  const match = cacheControl?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) * 1000 : DEFAULT_KEYS_MAX_AGE_MS;
};

export class GoogleOAuth {
  private keys: Map<string, JsonWebKey> = new Map();
  private keysExpireAt = 0;

  constructor(
    private readonly opts: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      allowedDomain: string;
      fetch?: FetchFn;
      now?: () => number;
    },
  ) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  buildAuthUrl(opts: { state: string; codeChallenge: string }) {
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: "S256",
      // offline + consent: Google only issues a refresh token on consent
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      // only a hint for the account chooser; the hd claim is what's enforced
      hd: this.opts.allowedDomain,
    });
    return `${GOOGLE_ENDPOINTS.authorize}?${params}`;
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await this.fetch(GOOGLE_ENDPOINTS.token, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        ...body,
      }),
    });
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      any
    >;
    if (!response.ok) {
      if (json.error === "invalid_grant") {
        throw new GrantRevokedError();
      }
      throw new GoogleError(
        json.error_description || json.error || "Google token request failed",
        response.status,
      );
    }
    return json;
  }

  async exchangeCode(code: string, codeVerifier: string) {
    const json = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.opts.redirectUri,
    });
    const claims = await this.verifyIdToken(String(json.id_token ?? ""));
    const tokens: TokenSet = {
      accessToken: String(json.access_token),
      expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
      scope: String(json.scope ?? ""),
    };
    return {
      claims,
      refreshToken: (json.refresh_token as string | undefined) ?? null,
      tokens,
    };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const json = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return {
      accessToken: String(json.access_token),
      expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
      scope: String(json.scope ?? ""),
    };
  }

  private async getKey(kid: string, forceReload: boolean) {
    if (forceReload || this.now() >= this.keysExpireAt) {
      const response = await this.fetch(GOOGLE_ENDPOINTS.certs, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new GoogleError("Couldn't load Google's signing keys", 502);
      }
      const { keys } = (await response.json()) as {
        keys: (JsonWebKey & { kid: string })[];
      };
      this.keys = new Map(keys.map((key) => [key.kid, key]));
      this.keysExpireAt =
        this.now() + parseMaxAge(response.headers.get("cache-control"));
    }
    return this.keys.get(kid);
  }

  /** Checks signature, issuer, audience and expiry per Google's OIDC docs. */
  async verifyIdToken(idToken: string): Promise<IdTokenClaims> {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new GoogleError("Malformed ID token", 401);
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeJwtPart<{ alg: string; kid: string }>(headerPart);
    if (header.alg !== "RS256") {
      throw new GoogleError("Unexpected ID token algorithm", 401);
    }

    // Google rotates keys; an unknown kid means our cached set is stale
    const jwk =
      (await this.getKey(header.kid, false)) ??
      (await this.getKey(header.kid, true));
    if (!jwk) {
      throw new GoogleError("Unknown ID token signing key", 401);
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    const isValid = verifier.verify(
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(signaturePart, "base64url"),
    );
    if (!isValid) {
      throw new GoogleError("Invalid ID token signature", 401);
    }

    const claims = decodeJwtPart<IdTokenClaims>(payloadPart);
    const nowSec = this.now() / 1000;
    if (!ISSUERS.has(claims.iss)) {
      throw new GoogleError("Unexpected ID token issuer", 401);
    }
    if (claims.aud !== this.opts.clientId) {
      throw new GoogleError("ID token is for another client", 401);
    }
    if (claims.exp + CLOCK_SKEW_SEC < nowSec) {
      throw new GoogleError("ID token has expired", 401);
    }
    return claims;
  }
}
