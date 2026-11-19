import {
  decrypt,
  encrypt,
  randomToken,
  safeEqual,
  sha256Base64Url,
} from "./crypto";
import { DRIVE_FILE_SCOPE, GrantRevokedError } from "./google";
import { isSessionExpired } from "./sessions";

import type { Config } from "./config";
import type { GoogleOAuth } from "./google";
import type { FileSessionStore, SessionData } from "./sessions";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "exc_session";
// suffixed with part of the state, so sign-ins in two tabs don't overwrite
// each other's pending login
const LOGIN_COOKIE_PREFIX = "exc_login_";
const loginCookieName = (state: string) =>
  `${LOGIN_COOKIE_PREFIX}${state.slice(0, 12)}`;
const LOGIN_TTL_MS = 10 * 60 * 1000;
// writing lastSeenAt on every asset request would mean a disk write each time
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const REVERIFY_RETRY_MS = 5 * 60 * 1000;
// hand out a fresh Drive token before the browser's copy can expire mid-request
const ACCESS_TOKEN_MIN_LIFETIME_MS = 2 * 60 * 1000;

type PendingLogin = {
  state: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
};

type AuthenticatedSession = { id: string; data: SessionData };

export type AuthAppDeps = {
  config: Config;
  google: GoogleOAuth;
  sessions: FileSessionStore;
  now?: () => number;
};

const parseCookies = (header: string | undefined) => {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim(),
      );
    } catch {
      // another app's cookie on this domain; it must not break sign-in
    }
  }
  return cookies;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        char
      ]!),
  );

const isUnsafeUrlChar = (char: string) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || char === "\\";
};

/**
 * Only paths on our own origin, so sign-in can't be used as an open redirect.
 * Browsers strip tabs and newlines and read "\\" as "/", so "/\t/evil.test"
 * would become "//evil.test": reject those before resolving.
 */
export const sanitizeReturnTo = (
  value: string | null | undefined,
  origin: string,
) => {
  if (!value?.startsWith("/") || [...value].some(isUnsafeUrlChar)) {
    return "/";
  }
  try {
    const url = new URL(value, origin);
    return url.origin === origin
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
};

const page = (
  title: string,
  message: string,
  link?: { href: string; label: string },
) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1b1b1f;background:#fff}a{color:#6965db}@media (prefers-color-scheme:dark){body{color:#e3e3e8;background:#121212}a{color:#a8a5ff}}</style></head><body><h1>${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(message)}</p>${
    link
      ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(
          link.label,
        )}</a></p>`
      : ""
  }</body></html>`;

const signInRedirectPage = (nonce: string) =>
  page("Signing in…", "Taking you to Google sign-in.", {
    href: "/auth/login",
    label: "Continue",
  }).replace(
    "</body>",
    `<script nonce="${nonce}">location.replace("/auth/login?returnTo="+encodeURIComponent(location.pathname+location.search+location.hash))</script></body>`,
  );

export const createAuthApp = (deps: AuthAppDeps) => {
  const { config, google, sessions } = deps;
  const now = () => (deps.now ?? Date.now)();
  const refreshes = new Map<string, Promise<SessionData | null>>();
  // without this, every request during a Google outage would retry and wait
  const failedReverifyAt = new Map<string, number>();

  const cookie = (
    name: string,
    value: string,
    opts: { maxAgeSec: number; path: string },
  ) =>
    [
      `${name}=${encodeURIComponent(value)}`,
      `Path=${opts.path}`,
      `Max-Age=${opts.maxAgeSec}`,
      "HttpOnly",
      "SameSite=Lax",
      config.secureCookies ? "Secure" : null,
    ]
      .filter(Boolean)
      .join("; ");

  const clearSessionCookie = () =>
    cookie(SESSION_COOKIE, "", { maxAgeSec: 0, path: "/" });

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string | string[]> = {},
  ) => {
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(body);
  };

  const sendJSON = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ) =>
    send(res, status, JSON.stringify(body), {
      "Content-Type": "application/json",
      ...headers,
    });

  const sendPage = (
    res: ServerResponse,
    status: number,
    html: string,
    headers: Record<string, string | string[]> = {},
  ) =>
    send(res, status, html, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      ...headers,
    });

  /** One refresh per session at a time, however many requests ask for it. */
  const refreshSession = (id: string, data: SessionData) => {
    let pending = refreshes.get(id);
    if (!pending) {
      pending = (async () => {
        const tokens = await google.refresh(data.refreshToken);
        return sessions.update(id, {
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.expiresAt,
          grantedScopes: tokens.scope
            ? tokens.scope.split(" ")
            : data.grantedScopes,
          verifiedAt: now(),
        });
      })().finally(() => refreshes.delete(id));
      refreshes.set(id, pending);
    }
    return pending;
  };

  const authenticate = async (
    req: IncomingMessage,
  ): Promise<AuthenticatedSession | null> => {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) {
      return null;
    }
    let data = await sessions.get(id);
    if (!data) {
      return null;
    }
    const time = now();
    if (
      isSessionExpired(data, time, config.sessionMaxAgeMs, config.sessionIdleMs)
    ) {
      await sessions.delete(id);
      return null;
    }

    const lastFailure = failedReverifyAt.get(id);
    if (
      time - data.verifiedAt > config.reverifyIntervalMs &&
      (lastFailure === undefined || time - lastFailure > REVERIFY_RETRY_MS)
    ) {
      try {
        data = (await refreshSession(id, data)) ?? data;
        failedReverifyAt.delete(id);
      } catch (error) {
        failedReverifyAt.set(id, time);
        if (error instanceof GrantRevokedError) {
          // account disabled, deleted or access revoked: end the session
          failedReverifyAt.delete(id);
          await sessions.delete(id);
          return null;
        }
      }
    }
    // Google unreachable: keep working for a while rather than lock everyone
    // out, but not forever
    if (time - data.verifiedAt > config.reverifyGraceMs) {
      return null;
    }

    if (time - data.lastSeenAt > LAST_SEEN_WRITE_INTERVAL_MS) {
      data = (await sessions.update(id, { lastSeenAt: time })) ?? data;
    }
    return { id, data };
  };

  const hasDriveAccess = (data: SessionData) =>
    data.grantedScopes.includes(DRIVE_FILE_SCOPE);

  // -------------------------------------------------------------------------

  const handleLogin = (url: URL, res: ServerResponse) => {
    const pending: PendingLogin = {
      state: randomToken(),
      codeVerifier: randomToken(48),
      returnTo: sanitizeReturnTo(
        url.searchParams.get("returnTo"),
        config.publicUrl.origin,
      ),
      expiresAt: now() + LOGIN_TTL_MS,
    };
    send(res, 302, "", {
      Location: google.buildAuthUrl({
        state: pending.state,
        codeChallenge: sha256Base64Url(pending.codeVerifier),
      }),
      "Set-Cookie": cookie(
        loginCookieName(pending.state),
        encrypt(config.encryptionKey, JSON.stringify(pending)),
        { maxAgeSec: LOGIN_TTL_MS / 1000, path: "/auth" },
      ),
    });
  };

  const handleCallback = async (
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ) => {
    const state = url.searchParams.get("state") ?? "";
    const clearLogin = cookie(loginCookieName(state), "", {
      maxAgeSec: 0,
      path: "/auth",
    });
    const retry = { href: "/auth/login", label: "Try again" };

    const encoded = parseCookies(req.headers.cookie)[loginCookieName(state)];
    const json = encoded ? decrypt(config.encryptionKey, encoded) : null;
    const pending = json ? (JSON.parse(json) as PendingLogin) : null;

    if (
      !pending ||
      pending.expiresAt < now() ||
      !safeEqual(state, pending.state)
    ) {
      sendPage(
        res,
        400,
        page("Sign-in expired", "This sign-in link is no longer valid.", retry),
        { "Set-Cookie": clearLogin },
      );
      return;
    }

    if (url.searchParams.get("error")) {
      sendPage(
        res,
        403,
        page("Sign-in cancelled", "Google sign-in didn't complete.", retry),
        { "Set-Cookie": clearLogin },
      );
      return;
    }

    let result: Awaited<ReturnType<GoogleOAuth["exchangeCode"]>>;
    try {
      result = await google.exchangeCode(
        url.searchParams.get("code") ?? "",
        pending.codeVerifier,
      );
    } catch {
      sendPage(
        res,
        502,
        page("Sign-in failed", "Couldn't complete sign-in with Google.", retry),
        { "Set-Cookie": clearLogin },
      );
      return;
    }

    const { claims, refreshToken, tokens } = result;
    // hd, not the email domain, proves Workspace membership (Google's guidance)
    if (
      claims.hd?.toLowerCase() !== config.allowedDomain ||
      claims.email_verified !== true
    ) {
      sendPage(
        res,
        403,
        page(
          "Account not allowed",
          `Sign in with your ${config.allowedDomain} Google account.`,
          retry,
        ),
        { "Set-Cookie": clearLogin },
      );
      return;
    }
    if (!refreshToken) {
      sendPage(
        res,
        502,
        page("Sign-in failed", "Google didn't grant offline access.", retry),
        { "Set-Cookie": clearLogin },
      );
      return;
    }

    const time = now();
    const sessionId = await sessions.create({
      user: {
        sub: claims.sub,
        email: claims.email,
        name: claims.name || claims.email,
        picture: claims.picture ?? null,
      },
      refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      grantedScopes: tokens.scope.split(" "),
      createdAt: time,
      lastSeenAt: time,
      verifiedAt: time,
    });

    send(res, 302, "", {
      Location: pending.returnTo,
      "Set-Cookie": [
        clearLogin,
        cookie(SESSION_COOKIE, sessionId, {
          maxAgeSec: config.sessionMaxAgeMs / 1000,
          path: "/",
        }),
      ],
    });
  };

  const handleLogout = async (req: IncomingMessage, res: ServerResponse) => {
    // blocks other sites from signing users out with a forged form post
    if (req.headers.origin !== config.publicUrl.origin) {
      sendJSON(res, 403, { error: "bad_origin" });
      return;
    }
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) {
      // not revoking at Google: that would end the user's other devices too
      await sessions.delete(id);
    }
    send(res, 204, "", { "Set-Cookie": clearSessionCookie() });
  };

  const handleCheck = async (req: IncomingMessage, res: ServerResponse) => {
    const session = await authenticate(req);
    if (session) {
      send(res, 200, "", { "X-Auth-Email": session.data.user.email });
      return;
    }
    const wantsPage =
      req.headers["x-forwarded-method"] === "GET" &&
      (req.headers.accept ?? "").includes("text/html");
    if (wantsPage) {
      // Collab and share links keep their room key in the #fragment, which
      // browsers never send to a server, so a server redirect would drop it.
      // A script on the page can read it.
      const nonce = randomToken(16);
      sendPage(res, 401, signInRedirectPage(nonce), {
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
      });
    } else {
      send(res, 401, "");
    }
  };

  const handleMe = async (req: IncomingMessage, res: ServerResponse) => {
    const session = await authenticate(req);
    if (!session) {
      sendJSON(
        res,
        401,
        { error: "signed_out" },
        {
          "Set-Cookie": clearSessionCookie(),
        },
      );
      return;
    }
    const { user } = session.data;
    sendJSON(res, 200, {
      email: user.email,
      name: user.name,
      picture: user.picture,
      driveAccess: hasDriveAccess(session.data),
    });
  };

  const handleDriveToken = async (
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ) => {
    const session = await authenticate(req);
    if (!session) {
      sendJSON(
        res,
        401,
        { error: "signed_out" },
        {
          "Set-Cookie": clearSessionCookie(),
        },
      );
      return;
    }
    let { data } = session;
    if (!hasDriveAccess(data)) {
      sendJSON(res, 403, { error: "drive_not_granted" });
      return;
    }
    // refresh=1: Drive rejected the current token, so don't hand it out again
    if (
      url.searchParams.get("refresh") === "1" ||
      data.accessTokenExpiresAt - now() < ACCESS_TOKEN_MIN_LIFETIME_MS
    ) {
      try {
        data = (await refreshSession(session.id, data)) ?? data;
      } catch (error) {
        if (error instanceof GrantRevokedError) {
          await sessions.delete(session.id);
          sendJSON(
            res,
            401,
            { error: "signed_out" },
            {
              "Set-Cookie": clearSessionCookie(),
            },
          );
          return;
        }
        sendJSON(res, 502, { error: "google_unavailable" });
        return;
      }
    }
    sendJSON(res, 200, {
      accessToken: data.accessToken,
      expiresAt: data.accessTokenExpiresAt,
    });
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /auth/login":
          return handleLogin(url, res);
        case "GET /auth/callback":
          return await handleCallback(req, url, res);
        case "POST /auth/logout":
          return await handleLogout(req, res);
        case "GET /auth/check":
          return await handleCheck(req, res);
        case "GET /auth/me":
          return await handleMe(req, res);
        case "GET /auth/drive-token":
          return await handleDriveToken(req, url, res);
        case "GET /auth/signed-out":
          return sendPage(
            res,
            200,
            page("Signed out", "You're signed out of Excalidraw.", {
              href: "/auth/login",
              label: "Sign in again",
            }),
          );
        case "GET /auth/health":
          return send(res, 200, "ok");
        default:
          return sendJSON(res, 404, { error: "not_found" });
      }
    } catch (error) {
      console.error(`${route} failed`, error);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: "internal_error" });
      }
    }
  };
};
