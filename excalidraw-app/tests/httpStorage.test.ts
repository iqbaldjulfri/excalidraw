import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { syncInvalidIndices } from "@excalidraw/element";
import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { loadFromHttp, saveFilesToHttp, saveToHttp } from "../data/httpStorage";

import { SignedOutError } from "../data/session";

import type Portal from "../collab/Portal";
import type { SyncableExcalidrawElement } from "../data";

type Room = { scene: unknown; revision: number };

const createFakeServer = () => {
  const rooms = new Map<string, Room>();
  const puts: string[] = [];
  const writerTokens: string[] = [];
  let status: number | null = null;
  let beforeNextPut: (() => Promise<unknown>) | null = null;

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (status) {
      return new Response(null, { status });
    }
    const room = url.match(/^\/api\/rooms\/(.+)$/)?.[1];
    if (room && method === "GET") {
      const stored = rooms.get(room);
      return stored
        ? Response.json(stored)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (room && method === "PUT") {
      const interleaved = beforeNextPut;
      beforeNextPut = null;
      await interleaved?.();
      writerTokens.push(new Headers(init.headers).get("X-Room-Writer-Token")!);
      const body = JSON.parse(String(init.body));
      const current = rooms.get(room)?.revision ?? null;
      if (current !== body.expectedRevision) {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      rooms.set(room, { scene: body.scene, revision: (current ?? 0) + 1 });
      return Response.json({ revision: (current ?? 0) + 1 });
    }
    if (method === "PUT") {
      puts.push(url);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });

  return {
    rooms,
    puts,
    writerTokens,
    fetchMock,
    failWith: (code: number) => {
      status = code;
    },
    /** Completes before our next write is checked, like a faster collaborator. */
    interleave: (fn: () => Promise<unknown>) => {
      beforeNextPut = fn;
    },
  };
};

const element = (id: string, version: number) => ({
  ...API.createElement({ type: "rectangle", id }),
  version,
  versionNonce: version,
});

// syncInvalidIndices bumps versions in place, so note them first
const scene = (...elements: ReturnType<typeof element>[]) => {
  const pinned = elements.map((el) => el.version);
  return syncInvalidIndices(elements).map((el, i) => ({
    ...el,
    version: pinned[i],
  })) as unknown as SyncableExcalidrawElement[];
};

const versions = (elements: readonly { id: string; version: number }[]) =>
  elements.map((el) => `${el.id}@${el.version}`).sort();

describe("httpStorage", () => {
  let server: ReturnType<typeof createFakeServer>;
  let portal: Portal;

  beforeEach(async () => {
    vi.stubEnv("VITE_APP_STORAGE_URL", "/api");
    server = createFakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    portal = {
      roomId: "room1",
      roomKey: await generateEncryptionKey(),
      socket: {},
    } as unknown as Portal;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("saves a room end-to-end encrypted and loads it back", async () => {
    await saveToHttp(portal, scene(element("a", 1)), {} as AppState);

    const stored = JSON.stringify(server.rooms.get("room1"));
    expect(stored).not.toContain('"a"');

    const loaded = await loadFromHttp("room1", portal.roomKey!, null);
    expect(versions(loaded!)).toEqual(["a@1"]);
  });

  it("merges and retries when someone else saved in between", async () => {
    const other = {
      ...portal,
      socket: {},
    } as unknown as Portal;
    await saveToHttp(portal, scene(element("a", 1)), {} as AppState);

    // a collaborator's save lands between our read and our write
    server.interleave(() =>
      saveToHttp(other, scene(element("b", 1)), {} as AppState),
    );
    await saveToHttp(
      portal,
      scene(element("a", 2), element("c", 1)),
      {} as AppState,
    );

    const loaded = await loadFromHttp("room1", portal.roomKey!, null);
    // nothing lost to the race; b and c share an index, so the merge
    // re-indexes one and bumps its version, as live collab does
    expect(loaded!.map((el) => el.id).sort()).toEqual(["a", "b", "c"]);
    expect(loaded!.find((el) => el.id === "a")!.version).toBe(2);
    const roomPuts = server.fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/rooms/room1" && init?.method === "PUT",
    );
    // first save, their save, our conflicted write, our merged retry
    expect(roomPuts).toHaveLength(4);
    const statuses = await Promise.all(
      server.fetchMock.mock.results.map(
        async (result) => (await result.value).status,
      ),
    );
    expect(statuses).toContain(409);
  });

  it("proves it holds the room key with a token that never contains it", async () => {
    await saveToHttp(portal, scene(element("a", 1)), {} as AppState);
    await saveToHttp(portal, scene(element("a", 2)), {} as AppState);

    const [first, second] = server.writerTokens;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(first).not.toContain(portal.roomKey);
  });

  it("reports an ended session so the user knows to sign in again", async () => {
    server.failWith(401);

    await expect(loadFromHttp("room1", portal.roomKey!, null)).rejects.toThrow(
      SignedOutError,
    );
    await expect(
      saveFilesToHttp({
        prefix: "/files/shareLinks/link1",
        files: [{ id: "img" as FileId, buffer: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(SignedOutError);
  });

  it("fails a share link's image upload when no image reached the server", async () => {
    server.failWith(503);

    await expect(
      saveFilesToHttp({
        prefix: "/files/shareLinks/link1",
        files: [{ id: "img" as FileId, buffer: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow();
  });

  it("uploads images under the room or share link they belong to", async () => {
    await saveFilesToHttp({
      prefix: "/files/rooms/room1",
      files: [{ id: "img1" as FileId, buffer: new Uint8Array([1]) }],
    });
    await saveFilesToHttp({
      prefix: "files/shareLinks/link1",
      files: [{ id: "img2" as FileId, buffer: new Uint8Array([2]) }],
    });

    expect(server.puts).toEqual([
      "/api/files/rooms/room1/img1",
      "/api/files/shareLinks/link1/img2",
    ]);
  });
});
