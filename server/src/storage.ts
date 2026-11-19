import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { randomToken } from "./crypto";

/**
 * Everything is stored end-to-end encrypted by the browser; this server never
 * sees a key. Files are grouped by owner (a share link or a collab room) so an
 * owner and its images expire together.
 */
export type OwnerKind = "shareLinks" | "rooms";

export type StoredRoomScene = {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
};

export class StorageConflictError extends Error {
  constructor() {
    super("The room was saved by someone else first");
    this.name = "StorageConflictError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const isValidId = (id: string) => ID_PATTERN.test(id);

// touched on every read and write; its mtime is the owner's last use
const ACCESS_MARKER = ".last-access";
const SCENE_FILE = "scene";

export class DiskStorage {
  private readonly root: string;
  private readonly roomLocks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, private readonly now = () => Date.now()) {
    this.root = path.join(dataDir, "storage");
  }

  private ownerDir(kind: OwnerKind, ownerId: string) {
    if (!isValidId(ownerId)) {
      throw new Error("Invalid id");
    }
    return path.join(this.root, kind, ownerId);
  }

  private async writeAtomic(file: string, data: Uint8Array | string) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomToken(6)}.tmp`;
    await writeFile(temp, data);
    await rename(temp, file);
  }

  private async touch(kind: OwnerKind, ownerId: string) {
    const marker = path.join(this.ownerDir(kind, ownerId), ACCESS_MARKER);
    const time = new Date(this.now());
    try {
      await utimes(marker, time, time);
    } catch {
      await mkdir(path.dirname(marker), { recursive: true });
      await writeFile(marker, "");
      await utimes(marker, time, time);
    }
  }

  private async readOptional(file: string) {
    try {
      return await readFile(file);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  // --- share links -------------------------------------------------------

  async createShareLink(scene: Uint8Array): Promise<string> {
    const id = randomToken(16);
    await this.writeAtomic(
      path.join(this.ownerDir("shareLinks", id), SCENE_FILE),
      scene,
    );
    await this.touch("shareLinks", id);
    return id;
  }

  async readShareLink(id: string) {
    const scene = await this.readOptional(
      path.join(this.ownerDir("shareLinks", id), SCENE_FILE),
    );
    if (scene) {
      await this.touch("shareLinks", id);
    }
    return scene;
  }

  // --- collab rooms --------------------------------------------------------

  /** Revisions let concurrent savers detect each other, like a transaction. */
  async readRoom(
    roomId: string,
  ): Promise<{ scene: StoredRoomScene; revision: number } | null> {
    const raw = await this.readOptional(
      path.join(this.ownerDir("rooms", roomId), SCENE_FILE),
    );
    if (!raw) {
      return null;
    }
    await this.touch("rooms", roomId);
    return JSON.parse(raw.toString("utf8"));
  }

  /**
   * Saves only if the stored revision still equals `expectedRevision`
   * (null: the room must not exist yet). Returns the new revision.
   */
  writeRoom(
    roomId: string,
    scene: StoredRoomScene,
    expectedRevision: number | null,
  ): Promise<number> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    const run = async () => {
      const current = await this.readRoom(roomId);
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new StorageConflictError();
      }
      const revision = (current?.revision ?? 0) + 1;
      await this.writeAtomic(
        path.join(this.ownerDir("rooms", roomId), SCENE_FILE),
        JSON.stringify({ scene, revision }),
      );
      await this.touch("rooms", roomId);
      return revision;
    };
    // one write per room at a time, so the revision check can't race
    const result = previous.then(run, run);
    const chain = result.catch(() => {});
    this.roomLocks.set(roomId, chain);
    chain.then(() => {
      if (this.roomLocks.get(roomId) === chain) {
        this.roomLocks.delete(roomId);
      }
    });
    return result;
  }

  // --- images --------------------------------------------------------------

  private filePath(kind: OwnerKind, ownerId: string, fileId: string) {
    if (!isValidId(fileId)) {
      throw new Error("Invalid id");
    }
    return path.join(this.ownerDir(kind, ownerId), "files", fileId);
  }

  /**
   * Images are content-addressed by the browser and never change, so the
   * first upload wins; later uploads with the same id are ignored rather than
   * letting anyone replace an image in someone else's room.
   */
  async saveFile(
    kind: OwnerKind,
    ownerId: string,
    fileId: string,
    data: Uint8Array,
  ) {
    const file = this.filePath(kind, ownerId, fileId);
    const exists = await stat(file).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await this.writeAtomic(file, data);
    }
    await this.touch(kind, ownerId);
  }

  async readFile(kind: OwnerKind, ownerId: string, fileId: string) {
    const data = await this.readOptional(this.filePath(kind, ownerId, fileId));
    if (data) {
      await this.touch(kind, ownerId);
    }
    return data;
  }

  // --- expiry ----------------------------------------------------------------

  /** Deletes share links and rooms, with their images, unused for `maxIdleMs`. */
  async deleteUnused(maxIdleMs: number) {
    let removed = 0;
    for (const kind of ["shareLinks", "rooms"] as const) {
      let owners: string[];
      try {
        owners = await readdir(path.join(this.root, kind));
      } catch {
        continue;
      }
      for (const ownerId of owners) {
        const dir = path.join(this.root, kind, ownerId);
        const lastAccess = await stat(path.join(dir, ACCESS_MARKER)).then(
          (stats) => stats.mtimeMs,
          // no marker: a write crashed half-way; fall back to the folder
          () => stat(dir).then((stats) => stats.mtimeMs),
        );
        if (this.now() - lastAccess > maxIdleMs) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }
}
