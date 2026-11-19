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
  /** For the browser's Google Picker; both or neither. */
  picker: { apiKey: string; appId: string } | null;
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
  /** Share links and collab rooms unopened this long are deleted. */
  retentionMs: number;
};

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const loadPickerConfig = (env: NodeJS.ProcessEnv) => {
  const apiKey = env.GOOGLE_PICKER_API_KEY?.trim();
  const appId = env.GOOGLE_PROJECT_NUMBER?.trim();
  if (!apiKey && !appId) {
    return null;
  }
  if (!apiKey || !appId) {
    throw new Error(
      "Set both GOOGLE_PICKER_API_KEY and GOOGLE_PROJECT_NUMBER, or neither",
    );
  }
  return { apiKey, appId };
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const publicUrl = new URL(required(env, "PUBLIC_URL"));
  const sessionSecret = required(env, "SESSION_SECRET");
  const retentionDays = Number(env.RETENTION_DAYS || 180);
  if (!(retentionDays > 0)) {
    throw new Error("RETENTION_DAYS must be a positive number of days");
  }
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  return {
    port: Number(env.PORT || 3015),
    publicUrl,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    allowedDomain: required(env, "ALLOWED_DOMAIN").toLowerCase(),
    picker: loadPickerConfig(env),
    dataDir: env.DATA_DIR || "./data",
    // hashing lets any long random string serve as the secret
    encryptionKey: createHash("sha256").update(sessionSecret).digest(),
    secureCookies: publicUrl.protocol === "https:",
    sessionMaxAgeMs: 30 * DAY,
    sessionIdleMs: 7 * DAY,
    reverifyIntervalMs: HOUR,
    reverifyGraceMs: DAY,
    retentionMs: retentionDays * DAY,
  };
};
