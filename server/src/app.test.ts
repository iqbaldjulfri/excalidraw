import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAuthApp, sanitizeReturnTo, SESSION_COOKIE } from "./app";
import { DRIVE_FILE_SCOPE, GOOGLE_ENDPOINTS, GoogleOAuth } from "./google";
import { FileSessionStore } from "./sessions";

import type { Config } from "./config";
import type { AddressInfo } from "node:net";

const HOUR = 60 * 60 * 1000;
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const DOMAIN = "acme.test";
const GRANTED_SCOPES = `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE_SCOPE}`;

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...signingKey.publicKey.export({ format: "jwk" }),
  kid: "k1",
  alg: "RS256",
  use: "sig",
};

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const signIdToken = (
  claims: Record<string, unknown>,
  key = signingKey.privateKey,
) => {
  const unsigned = `${b64url({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64url(
    claims,
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key);
  return `${unsigned}.${signature.toString("base64url")}`;
};

type FakeGoogle = {
  idTokenClaims: Record<string, unknown>;
  idTokenKey: typeof signingKey.privateKey;
  scope: string;
  refreshResult: "ok" | "invalid_grant" | "down";
  refreshCalls: number;
  lastAuthCodeBody: URLSearchParams | null;
};

const setUp = async () => {
  let time = Date.UTC(2026, 10, 19, 12);
  const dataDir = await mkdtemp(path.join(tmpdir(), "excalidraw-auth-"));
  const fake: FakeGoogle = {
    idTokenClaims: {},
    idTokenKey: signingKey.privateKey,
    scope: GRANTED_SCOPES,
    refreshResult: "ok",
    refreshCalls: 0,
    lastAuthCodeBody: null,
  };

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_ENDPOINTS.certs) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "cache-control": "public, max-age=3600" },
      });
    }
    if (url === GOOGLE_ENDPOINTS.token) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "authorization_code") {
        fake.lastAuthCodeBody = body;
        return Response.json({
          access_token: "access-1",
          expires_in: 3599,
          refresh_token: "refresh-1",
          scope: fake.scope,
          id_token: signIdToken(
            {
              iss: "https://accounts.google.com",
              aud: CLIENT_ID,
              sub: "user-1",
              email: `alice@${DOMAIN}`,
              email_verified: true,
              hd: DOMAIN,
              name: "Alice",
              exp: Math.floor(time / 1000) + 3600,
              ...fake.idTokenClaims,
            },
            fake.idTokenKey,
          ),
        });
      }
      fake.refreshCalls++;
      if (fake.refreshResult === "invalid_grant") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (fake.refreshResult === "down") {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        access_token: `access-${fake.refreshCalls + 1}`,
        expires_in: 3599,
        scope: fake.scope,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const publicUrl = new URL("https://draw.acme.test");
  const config: Config = {
    port: 0,
    publicUrl,
    googleClientId: CLIENT_ID,
    googleClientSecret: "secret",
    allowedDomain: DOMAIN,
    dataDir,
    encryptionKey: Buffer.alloc(32, 7),
    secureCookies: true,
    sessionMaxAgeMs: 30 * 24 * HOUR,
    sessionIdleMs: 7 * 24 * HOUR,
    reverifyIntervalMs: HOUR,
    reverifyGraceMs: 24 * HOUR,
  };
  const now = () => time;
  const sessions = new FileSessionStore(dataDir, config.encryptionKey);
  const google = new GoogleOAuth({
    clientId: CLIENT_ID,
    clientSecret: "secret",
    redirectUri: `${publicUrl.origin}/auth/callback`,
    allowedDomain: DOMAIN,
    fetch: fakeFetch,
    now,
  });
  const server = createServer(createAuthApp({ config, google, sessions, now }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = (pathname: string, init: RequestInit = {}) =>
    fetch(`${base}${pathname}`, { redirect: "manual", ...init });

  const cookieFrom = (response: Response, name: string) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [key, value] = pair.split("=");
      if (key === name) {
        return decodeURIComponent(value);
      }
    }
    return null;
  };

  /** Runs the whole Google round trip and returns the session cookie. */
  const signIn = async (returnTo = "/", extraCookies = "") => {
    const login = await request(
      `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    const googleUrl = new URL(login.headers.get("location")!);
    // the raw Set-Cookie pair, as a browser would send it back
    const loginCookie = login.headers
      .getSetCookie()
      .find((header) => header.startsWith("exc_login_"))!
      .split(";")[0];
    const callback = await request(
      `/auth/callback?code=abc&state=${googleUrl.searchParams.get("state")}`,
      {
        headers: {
          cookie: extraCookies
            ? `${extraCookies}; ${loginCookie}`
            : loginCookie,
        },
      },
    );
    return {
      callback,
      googleUrl,
      session: cookieFrom(callback, SESSION_COOKIE),
    };
  };

  const withSession = (
    session: string,
    headers: Record<string, string> = {},
  ) => ({
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
      ...headers,
    },
  });

  return {
    fake,
    dataDir,
    request,
    signIn,
    withSession,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
};

let ctx: Awaited<ReturnType<typeof setUp>>;

beforeEach(async () => {
  ctx = await setUp();
});

afterEach(async () => {
  await ctx.close();
});

describe("sign-in", () => {
  it("sends users to Google with PKCE, offline access and the domain hint", async () => {
    const { googleUrl } = await ctx.signIn();

    expect(googleUrl.origin + googleUrl.pathname).toBe(
      GOOGLE_ENDPOINTS.authorize,
    );
    expect(googleUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(googleUrl.searchParams.get("access_type")).toBe("offline");
    expect(googleUrl.searchParams.get("hd")).toBe(DOMAIN);
    expect(googleUrl.searchParams.get("scope")).toContain(DRIVE_FILE_SCOPE);
    expect(ctx.fake.lastAuthCodeBody?.get("code_verifier")).toBeTruthy();
  });

  it("creates a session for a verified account in the company domain", async () => {
    const { callback, session } = await ctx.signIn("/#room=abc");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/#room=abc");
    expect(callback.headers.getSetCookie().join("\n")).toMatch(
      /exc_session=.*HttpOnly; SameSite=Lax; Secure/,
    );

    const me = await ctx.request("/auth/me", ctx.withSession(session!));
    expect(await me.json()).toEqual({
      email: `alice@${DOMAIN}`,
      name: "Alice",
      picture: null,
      driveAccess: true,
    });
  });

  it.each([
    ["a personal Gmail account", { hd: undefined, email: "alice@gmail.com" }],
    ["another Workspace domain", { hd: "other.test" }],
    ["an unverified email", { email_verified: false }],
    ["a token for another client", { aud: "someone-else" }],
  ])("rejects %s", async (_label, claims) => {
    ctx.fake.idTokenClaims = claims;

    const { callback, session } = await ctx.signIn();

    expect(callback.status).not.toBe(302);
    expect(session).toBeNull();
  });

  it("rejects an ID token not signed by Google", async () => {
    ctx.fake.idTokenKey = otherKey.privateKey;

    const { callback, session } = await ctx.signIn();

    expect(callback.status).toBe(502);
    expect(session).toBeNull();
  });

  it("lets two tabs sign in at the same time", async () => {
    const first = await ctx.request("/auth/login");
    const second = await ctx.request("/auth/login");
    const cookies = [first, second]
      .map((response) => response.headers.getSetCookie()[0].split(";")[0])
      .join("; ");
    const firstState = new URL(first.headers.get("location")!).searchParams.get(
      "state",
    );

    const callback = await ctx.request(
      `/auth/callback?code=abc&state=${firstState}`,
      { headers: { cookie: cookies } },
    );

    expect(callback.status).toBe(302);
  });

  it("rejects a callback whose state doesn't match the login cookie", async () => {
    const login = await ctx.request("/auth/login");
    const cookie = login.headers.getSetCookie()[0].split(";")[0];

    const callback = await ctx.request("/auth/callback?code=abc&state=forged", {
      headers: { cookie },
    });

    expect(callback.status).toBe(400);
  });

  it("never redirects off-site after sign-in", () => {
    const origin = "https://draw.acme.test";
    expect(sanitizeReturnTo("/drawings?x=1#room=a,b", origin)).toBe(
      "/drawings?x=1#room=a,b",
    );
    expect(sanitizeReturnTo("//evil.test", origin)).toBe("/");
    expect(sanitizeReturnTo("/\\evil.test", origin)).toBe("/");
    // browsers strip the tab and read this as //evil.test
    expect(sanitizeReturnTo("/\t/evil.test", origin)).toBe("/");
    expect(sanitizeReturnTo("/\n/evil.test", origin)).toBe("/");
    expect(sanitizeReturnTo("https://evil.test", origin)).toBe("/");
    expect(sanitizeReturnTo(null, origin)).toBe("/");
  });
});

describe("/auth/check (reverse proxy gate)", () => {
  it("sends signed-out page loads to sign-in from a script, which can still see the #fragment", async () => {
    const response = await ctx.request("/auth/check", {
      headers: {
        accept: "text/html",
        "x-forwarded-method": "GET",
        "x-forwarded-uri": "/",
      },
    });
    const html = await response.text();
    const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];

    expect(response.status).toBe(401);
    expect(html).toContain("location.hash");
    expect(nonce).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toContain(
      `script-src 'nonce-${nonce}'`,
    );
  });

  it("keeps the #fragment through Google and back", async () => {
    const { callback } = await ctx.signIn("/#room=abc,KEY");

    expect(callback.headers.get("location")).toBe("/#room=abc,KEY");
  });

  it("answers 401 to signed-out API and websocket requests", async () => {
    const response = await ctx.request("/auth/check", {
      headers: {
        "x-forwarded-method": "GET",
        "x-forwarded-uri": "/socket.io/",
      },
    });

    expect(response.status).toBe(401);
  });

  it("lets signed-in users through and names them for the upstream", async () => {
    const { session } = await ctx.signIn();

    const response = await ctx.request(
      "/auth/check",
      ctx.withSession(session!),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-auth-email")).toBe(`alice@${DOMAIN}`);
  });

  it("ends the session within an hour of the account being disabled", async () => {
    const { session } = await ctx.signIn();
    ctx.fake.refreshResult = "invalid_grant";

    ctx.advance(30 * 60 * 1000);
    expect(
      (await ctx.request("/auth/check", ctx.withSession(session!))).status,
    ).toBe(200);

    ctx.advance(31 * 60 * 1000);
    expect(
      (await ctx.request("/auth/check", ctx.withSession(session!))).status,
    ).toBe(401);
    expect(await readdir(path.join(ctx.dataDir, "sessions"))).toEqual([]);
  });

  it("doesn't retry Google on every request while it's down", async () => {
    const { session } = await ctx.signIn();
    ctx.fake.refreshResult = "down";
    ctx.advance(2 * HOUR);

    await ctx.request("/auth/check", ctx.withSession(session!));
    await ctx.request("/auth/check", ctx.withSession(session!));
    expect(ctx.fake.refreshCalls).toBe(1);

    ctx.advance(6 * 60 * 1000);
    await ctx.request("/auth/check", ctx.withSession(session!));
    expect(ctx.fake.refreshCalls).toBe(2);
  });

  it("ignores another app's malformed cookie", async () => {
    const { session } = await ctx.signIn("/", "tracker=100%");

    const response = await ctx.request("/auth/check", {
      headers: {
        cookie: `tracker=100%; ${SESSION_COOKIE}=${encodeURIComponent(
          session!,
        )}`,
      },
    });

    expect(session).toBeTruthy();
    expect(response.status).toBe(200);
  });

  it("keeps sessions working through a short Google outage, but not indefinitely", async () => {
    const { session } = await ctx.signIn();
    ctx.fake.refreshResult = "down";

    ctx.advance(2 * HOUR);
    expect(
      (await ctx.request("/auth/check", ctx.withSession(session!))).status,
    ).toBe(200);

    ctx.advance(23 * HOUR);
    expect(
      (await ctx.request("/auth/check", ctx.withSession(session!))).status,
    ).toBe(401);
  });

  it("expires sessions idle for more than a week", async () => {
    const { session } = await ctx.signIn();

    ctx.advance(8 * 24 * HOUR);

    expect(
      (await ctx.request("/auth/check", ctx.withSession(session!))).status,
    ).toBe(401);
  });
});

describe("/auth/drive-token", () => {
  it("returns the current token, and a refreshed one when it's about to expire", async () => {
    const { session } = await ctx.signIn();

    const first = await (
      await ctx.request("/auth/drive-token", ctx.withSession(session!))
    ).json();
    expect(first.accessToken).toBe("access-1");

    ctx.advance(59 * 60 * 1000);
    const second = await (
      await ctx.request("/auth/drive-token", ctx.withSession(session!))
    ).json();
    expect(second.accessToken).toBe("access-2");
  });

  it("refreshes on request when Drive rejected a token that hasn't expired", async () => {
    const { session } = await ctx.signIn();

    const response = await ctx.request(
      "/auth/drive-token?refresh=1",
      ctx.withSession(session!),
    );

    expect((await response.json()).accessToken).toBe("access-2");
    expect(ctx.fake.refreshCalls).toBe(1);
  });

  it("refreshes once when many requests ask at the same moment", async () => {
    const { session } = await ctx.signIn();
    ctx.advance(59 * 60 * 1000);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.request("/auth/drive-token", ctx.withSession(session!)),
      ),
    );

    expect(ctx.fake.refreshCalls).toBe(1);
  });

  it("refuses when the user unticked Drive access on the consent screen", async () => {
    ctx.fake.scope = "openid https://www.googleapis.com/auth/userinfo.email";
    const { session } = await ctx.signIn();

    const response = await ctx.request(
      "/auth/drive-token",
      ctx.withSession(session!),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "drive_not_granted" });
  });
});

describe("sign-out and storage", () => {
  it("only signs out on requests from the app's own origin", async () => {
    const { session } = await ctx.signIn();

    const forged = await ctx.request("/auth/logout", {
      method: "POST",
      ...ctx.withSession(session!, { origin: "https://evil.test" }),
    });
    expect(forged.status).toBe(403);

    const real = await ctx.request("/auth/logout", {
      method: "POST",
      ...ctx.withSession(session!, { origin: "https://draw.acme.test" }),
    });
    expect(real.status).toBe(204);
    expect(
      (await ctx.request("/auth/me", ctx.withSession(session!))).status,
    ).toBe(401);
  });

  it("never writes a session back after it was deleted", async () => {
    const { session } = await ctx.signIn();
    const store = new FileSessionStore(ctx.dataDir, Buffer.alloc(32, 7));

    const update = store.update(session!, { lastSeenAt: 1 });
    const deletion = store.delete(session!);
    await Promise.all([update, deletion]);

    expect(await readdir(path.join(ctx.dataDir, "sessions"))).toEqual([]);
  });

  it("keeps no readable tokens or cookie values on disk", async () => {
    const { session } = await ctx.signIn();
    const dir = path.join(ctx.dataDir, "sessions");
    const [file] = await readdir(dir);
    const contents = await readFile(path.join(dir, file), "utf8");

    expect(file).not.toContain(session!);
    expect(contents).not.toContain("refresh-1");
    expect(contents).not.toContain(DOMAIN);
  });
});
