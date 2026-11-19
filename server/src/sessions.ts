import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { decrypt, encrypt, randomToken, sha256Hex } from "./crypto";

export type SessionUser = {
  /** Google's stable account id. */
  sub: string;
  email: string;
  name: string;
  picture: string | null;
};

export type SessionData = {
  user: SessionUser;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  grantedScopes: string[];
  createdAt: number;
  lastSeenAt: number;
  /** Last time Google accepted this session's refresh token. */
  verifiedAt: number;
};

/**
 * One encrypted file per session. Files are named by a hash of the session
 * id, so a copy of the data folder can't be turned into working cookies.
 */
export class FileSessionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, SessionData>();

  constructor(dataDir: string, private readonly key: Buffer) {
    this.dir = path.join(dataDir, "sessions");
  }

  private filePath(sessionId: string) {
    return path.join(this.dir, `${sha256Hex(sessionId)}.session`);
  }

  private async write(sessionId: string, data: SessionData) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.filePath(sessionId);
    const temp = `${target}.${randomToken(6)}.tmp`;
    await writeFile(temp, encrypt(this.key, JSON.stringify(data)), {
      mode: 0o600,
    });
    // rename is atomic, so a crash never leaves a half-written session
    await rename(temp, target);
    this.cache.set(sessionId, data);
  }

  async create(data: SessionData) {
    const sessionId = randomToken(32);
    await this.write(sessionId, data);
    return sessionId;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const cached = this.cache.get(sessionId);
    if (cached) {
      return cached;
    }
    let encoded: string;
    try {
      encoded = await readFile(this.filePath(sessionId), "utf8");
    } catch {
      return null;
    }
    const json = decrypt(this.key, encoded);
    if (!json) {
      return null;
    }
    const data = JSON.parse(json) as SessionData;
    this.cache.set(sessionId, data);
    return data;
  }

  async update(sessionId: string, patch: Partial<SessionData>) {
    const current = await this.get(sessionId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...patch };
    await this.write(sessionId, next);
    return next;
  }

  async delete(sessionId: string) {
    this.cache.delete(sessionId);
    await rm(this.filePath(sessionId), { force: true });
  }

  /** Removes sessions past either limit. File names are hashes, so decrypt each. */
  async deleteExpired(opts: { now: number; maxAgeMs: number; idleMs: number }) {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith(".tmp")) {
        await rm(file, { force: true });
        continue;
      }
      const json = decrypt(
        this.key,
        await readFile(file, "utf8").catch(() => ""),
      );
      const data = json ? (JSON.parse(json) as SessionData) : null;
      if (
        !data ||
        isSessionExpired(data, opts.now, opts.maxAgeMs, opts.idleMs)
      ) {
        await rm(file, { force: true });
        removed++;
      }
    }
    this.cache.clear();
    return removed;
  }
}

export const isSessionExpired = (
  data: SessionData,
  now: number,
  maxAgeMs: number,
  idleMs: number,
) => now - data.createdAt > maxAgeMs || now - data.lastSeenAt > idleMs;
