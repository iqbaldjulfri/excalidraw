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

import { randomToken, safeEqual, sha256Hex } from "./crypto";

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

/** The writer token doesn't match the one the room was created with. */
export class RoomWriteForbiddenError extends Error {
  constructor() {
    super("Only holders of the room key can save this room");
    this.name = "RoomWriteForbiddenError";
  }
}

type StoredRoom = {
  scene: StoredRoomScene;
  revision: number;
  /** Hash of a token derived from the room key; pinned by the first save. */
  writerHash?: string;
};

const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

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

  // owner-only modes: the data is encrypted, but room ids, sizes and access
  // times still say who works with whom
  private async writeAtomic(file: string, data: Uint8Array | string) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomToken(6)}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  }

  private async touch(kind: OwnerKind, ownerId: string) {
    const marker = path.join(this.ownerDir(kind, ownerId), ACCESS_MARKER);
    const time = new Date(this.now());
    try {
      await utimes(marker, time, time);
    } catch {
      await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
      await writeFile(marker, "", { mode: 0o600 });
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

  private async readStoredRoom(roomId: string): Promise<StoredRoom | null> {
    const raw = await this.readOptional(
      path.join(this.ownerDir("rooms", roomId), SCENE_FILE),
    );
    if (!raw) {
      return null;
    }
    await this.touch("rooms", roomId);
    return JSON.parse(raw.toString("utf8"));
  }

  /** Revisions let concurrent savers detect each other, like a transaction. */
  async readRoom(
    roomId: string,
  ): Promise<{ scene: StoredRoomScene; revision: number } | null> {
    const room = await this.readStoredRoom(roomId);
    return room ? { scene: room.scene, revision: room.revision } : null;
  }

  /**
   * Saves only if the stored revision still equals `expectedRevision`
   * (null: the room must not exist yet). Returns the new revision.
   *
   * `writerToken` is derived from the room key in the browser. Without it,
   * anyone who learned a room id could overwrite the snapshot with data
   * nobody can decrypt, breaking the room for everyone in it.
   */
  writeRoom(
    roomId: string,
    scene: StoredRoomScene,
    expectedRevision: number | null,
    writerToken: string,
  ): Promise<number> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    const run = async () => {
      const current = await this.readStoredRoom(roomId);
      const writerHash = sha256Hex(writerToken);
      if (current?.writerHash && !safeEqual(writerHash, current.writerHash)) {
        throw new RoomWriteForbiddenError();
      }
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new StorageConflictError();
      }
      const revision = (current?.revision ?? 0) + 1;
      const stored: StoredRoom = { scene, revision, writerHash };
      await this.writeAtomic(
        path.join(this.ownerDir("rooms", roomId), SCENE_FILE),
        JSON.stringify(stored),
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

  /**
   * Deletes share links and rooms, with their images, unused for `maxIdleMs`,
   * and temp files left by writes that crashed.
   */
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
          () =>
            stat(dir).then(
              (stats) => stats.mtimeMs,
              () => null,
            ),
        );
        if (lastAccess === null) {
          continue;
        }
        if (this.now() - lastAccess > maxIdleMs) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        } else {
          await this.deleteStaleTempFiles(dir);
          await this.deleteStaleTempFiles(path.join(dir, "files"));
        }
      }
    }
    return removed;
  }

  private async deleteStaleTempFiles(dir: string) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((name) => name.endsWith(".tmp"))) {
      const file = path.join(dir, name);
      const modified = await stat(file).then(
        (stats) => stats.mtimeMs,
        () => null,
      );
      // younger ones may belong to a write still in progress
      if (modified !== null && Date.now() - modified > TEMP_FILE_MAX_AGE_MS) {
        await rm(file, { force: true });
      }
    }
  }
}
