import { createSign, generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAuthApp, sanitizeReturnTo, SESSION_COOKIE } from "./app";
import { DRIVE_FILE_SCOPE, GOOGLE_ENDPOINTS, GoogleOAuth } from "./google";
import { FileSessionStore } from "./sessions";
import { DiskStorage } from "./storage";
import { DailyUploadQuota } from "./storageRoutes";

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
    picker: { apiKey: "browser-key", appId: "1234567890" },
    dataDir,
    encryptionKey: Buffer.alloc(32, 7),
    secureCookies: true,
    sessionMaxAgeMs: 30 * 24 * HOUR,
    sessionIdleMs: 7 * 24 * HOUR,
    reverifyIntervalMs: HOUR,
    reverifyGraceMs: 24 * HOUR,
    retentionMs: 180 * 24 * HOUR,
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
  const storage = new DiskStorage(dataDir, now);
  const server = createServer(
    createAuthApp({ config, google, sessions, storage, now }),
  );
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
    storage,
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
      picker: { apiKey: "browser-key", appId: "1234567890" },
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
    // the fragment holds the room key: it's stashed in the tab, not sent here
    expect(html).toContain("sessionStorage.setItem");
    expect(html).toContain('returnTo="+encodeURIComponent(p)');
    expect(html).not.toContain(
      "encodeURIComponent(location.pathname+location.search+location.hash)",
    );
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

  it("only removes session temp files old enough not to be mid-write", async () => {
    await ctx.signIn();
    const dir = path.join(ctx.dataDir, "sessions");
    const store = new FileSessionStore(ctx.dataDir, Buffer.alloc(32, 7));
    await writeFile(path.join(dir, "young.tmp"), "x");
    await writeFile(path.join(dir, "old.tmp"), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    await utimes(path.join(dir, "old.tmp"), twoHoursAgo, twoHoursAgo);

    await store.deleteExpired({
      now: Date.now(),
      maxAgeMs: 30 * 24 * HOUR,
      idleMs: 7 * 24 * HOUR,
    });

    const names = await readdir(dir);
    expect(names).toContain("young.tmp");
    expect(names).not.toContain("old.tmp");
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

describe("storage API", () => {
  const signedIn = async () => {
    const { session } = await ctx.signIn();
    return (init: RequestInit = {}) => ({
      ...init,
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(session!)}`,
        origin: "https://draw.acme.test",
        ...(init.headers as Record<string, string>),
      },
    });
  };

  it("refuses signed-out requests", async () => {
    expect((await ctx.request("/api/v2/abc")).status).toBe(401);
    expect(
      (await ctx.request("/api/v2/post/", { method: "POST", body: "x" }))
        .status,
    ).toBe(401);
  });

  it("stores a share link and returns the same bytes", async () => {
    const auth = await signedIn();
    const bytes = new Uint8Array([1, 2, 3, 250]);

    const created = await ctx.request(
      "/api/v2/post/",
      auth({ method: "POST", body: bytes }),
    );
    const { id } = await created.json();
    const loaded = await ctx.request(`/api/v2/${id}`, auth());

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(bytes);
  });

  it("answers an oversized share link with the error the app knows", async () => {
    const auth = await signedIn();

    const response = await ctx.request(
      "/api/v2/post/",
      auth({ method: "POST", body: new Uint8Array(11 * 1024 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error_class: "RequestTooLargeError",
    });
  });

  it("rejects a room save that didn't start from the latest revision", async () => {
    const auth = await signedIn();
    const scene = { sceneVersion: 1, iv: "aXY=", ciphertext: "Y3Q=" };
    const put = (expectedRevision: number | null) =>
      ctx.request(
        "/api/rooms/room1",
        auth({
          method: "PUT",
          headers: { "x-room-writer-token": "writer-a" },
          body: JSON.stringify({ scene, expectedRevision }),
        }),
      );

    expect(await (await put(null)).json()).toEqual({ revision: 1 });
    expect((await put(null)).status).toBe(409);
    expect(await (await put(1)).json()).toEqual({ revision: 2 });
    expect((await put(1)).status).toBe(409);
    expect(
      await (await ctx.request("/api/rooms/room1", auth())).json(),
    ).toEqual({ scene, revision: 2 });
  });

  it("serializes concurrent saves of the same revision", async () => {
    const auth = await signedIn();
    const scene = { sceneVersion: 1, iv: "aXY=", ciphertext: "Y3Q=" };

    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx
          .request(
            "/api/rooms/room2",
            auth({
              method: "PUT",
              headers: { "x-room-writer-token": "writer-a" },
              body: JSON.stringify({ scene, expectedRevision: null }),
            }),
          )
          .then((response) => response.status),
      ),
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(4);
  });

  it("only lets holders of the room key save over a room", async () => {
    const auth = await signedIn();
    const scene = { sceneVersion: 1, iv: "aXY=", ciphertext: "Y3Q=" };
    const put = (token: string | null, expectedRevision: number | null) =>
      ctx.request(
        "/api/rooms/room3",
        auth({
          method: "PUT",
          headers: token ? { "x-room-writer-token": token } : {},
          body: JSON.stringify({ scene, expectedRevision }),
        }),
      );

    expect((await put("key-holder", null)).status).toBe(200);
    expect((await put("someone-else", 1)).status).toBe(403);
    expect((await put(null, 1)).status).toBe(400);
    expect((await put("key-holder", 1)).status).toBe(200);
    // the pinned token isn't handed out to readers
    expect(
      await (await ctx.request("/api/rooms/room3", auth())).json(),
    ).not.toHaveProperty("writerHash");
  });

  it("keeps stored drawings readable only by the server's user", async () => {
    const auth = await signedIn();
    const { id } = await (
      await ctx.request("/api/v2/post/", auth({ method: "POST", body: "a" }))
    ).json();
    const dir = path.join(ctx.dataDir, "storage", "shareLinks", id);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, "scene"))).mode & 0o777).toBe(0o600);
  });

  it("removes temp files left by crashed writes once they're an hour old", async () => {
    const auth = await signedIn();
    const { id } = await (
      await ctx.request("/api/v2/post/", auth({ method: "POST", body: "a" }))
    ).json();
    const dir = path.join(ctx.dataDir, "storage", "shareLinks", id);
    await writeFile(path.join(dir, "scene.old.tmp"), "x");
    await writeFile(path.join(dir, "scene.new.tmp"), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    await utimes(path.join(dir, "scene.old.tmp"), twoHoursAgo, twoHoursAgo);

    await ctx.storage.deleteUnused(180 * 24 * HOUR);

    expect((await readdir(dir)).sort()).toEqual([
      ".last-access",
      "scene",
      "scene.new.tmp",
    ]);
  });

  it("keeps the first upload of an image", async () => {
    const auth = await signedIn();
    const url = "/api/files/rooms/room1/file1";

    await ctx.request(url, auth({ method: "PUT", body: new Uint8Array([1]) }));
    await ctx.request(url, auth({ method: "PUT", body: new Uint8Array([9]) }));
    const loaded = await ctx.request(url, auth());

    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(
      new Uint8Array([1]),
    );
    expect(loaded.headers.get("cache-control")).toContain("private");
  });

  it("doesn't let ids reach outside the storage folder", async () => {
    const auth = await signedIn();

    for (const path of [
      "/api/files/rooms/..%2F..%2Fsessions/x",
      "/api/files/rooms/room1/..%2Fscene",
      "/api/rooms/..",
      "/api/files/other/room1/file1",
    ]) {
      expect((await ctx.request(path, auth())).status).toBe(404);
    }
  });

  it("refuses writes from other sites", async () => {
    const auth = await signedIn();

    const response = await ctx.request(
      "/api/v2/post/",
      auth({
        method: "POST",
        body: "x",
        headers: { origin: "https://evil.test" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("deletes share links and rooms not opened for the retention period, with their images", async () => {
    const auth = await signedIn();
    const unused = await (
      await ctx.request("/api/v2/post/", auth({ method: "POST", body: "a" }))
    ).json();
    const used = await (
      await ctx.request("/api/v2/post/", auth({ method: "POST", body: "b" }))
    ).json();
    await ctx.request(
      `/api/files/shareLinks/${unused.id}/img`,
      auth({ method: "PUT", body: "i" }),
    );

    ctx.advance(100 * 24 * HOUR);
    await ctx.storage.readShareLink(used.id);
    ctx.advance(81 * 24 * HOUR);
    const removed = await ctx.storage.deleteUnused(180 * 24 * HOUR);

    expect(removed).toBe(1);
    expect(await ctx.storage.readShareLink(unused.id)).toBeNull();
    expect(
      await ctx.storage.readFile("shareLinks", unused.id, "img"),
    ).toBeNull();
    expect(await ctx.storage.readShareLink(used.id)).not.toBeNull();
  });
});

describe("DailyUploadQuota", () => {
  it("caps each user's uploads per day and resets the next day", () => {
    let time = Date.UTC(2026, 10, 19, 10);
    const quota = new DailyUploadQuota(100, () => time);

    quota.consume("alice", 60);
    expect(() => quota.consume("alice", 50)).toThrow();
    quota.consume("bob", 100);

    time += 24 * HOUR;
    expect(() => quota.consume("alice", 100)).not.toThrow();
  });
});
