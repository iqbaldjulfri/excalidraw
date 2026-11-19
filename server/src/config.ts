import { createHash } from "node:crypto";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type Config = {
  port: number;
  /** Origin users reach the app at, e.g. https://draw.example.com */
  publicUrl: URL;
  googleClientId: string;
  googleClientSecret: string;
  /** Google Workspace domain whose accounts may sign in (the `hd` claim). */
  allowedDomain: string;
  dataDir: string;
  /** AES-256 key for session files and the login cookie. */
  encryptionKey: Buffer;
  secureCookies: boolean;
  sessionMaxAgeMs: number;
  sessionIdleMs: number;
  /** How often a session is re-checked with Google, to end it after offboarding. */
  reverifyIntervalMs: number;
  /** How long to keep a session alive when Google can't be reached. */
  reverifyGraceMs: number;
};

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const publicUrl = new URL(required(env, "PUBLIC_URL"));
  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  return {
    port: Number(env.PORT || 3015),
    publicUrl,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    allowedDomain: required(env, "ALLOWED_DOMAIN").toLowerCase(),
    dataDir: env.DATA_DIR || "./data",
    // hashing lets any long random string serve as the secret
    encryptionKey: createHash("sha256").update(sessionSecret).digest(),
    secureCookies: publicUrl.protocol === "https:",
    sessionMaxAgeMs: 30 * DAY,
    sessionIdleMs: 7 * DAY,
    reverifyIntervalMs: HOUR,
    reverifyGraceMs: DAY,
  };
};
