import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { syncInvalidIndices } from "@excalidraw/element";
import { vi } from "vitest";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { DriveApiError } from "../data/googleDrive/driveApi";
import { DriveSync, driveStateAtom } from "../data/googleDrive/DriveSync";
import {
  mergeDriveScene,
  parseDriveScene,
  serializeDriveScene,
} from "../data/googleDrive/mergeScene";

import type { DriveClient, DriveDrawing } from "../data/googleDrive/driveApi";

vi.mock("../data/googleDrive/auth", () => ({
  isGoogleDriveEnabled: () => true,
  getValidAccessToken: () => "token",
  clearAccessToken: () => {},
  requestAccessToken: async () => "token",
  revokeAccessToken: async () => {},
}));

type ElementSpec = { id: string; version: number; isDeleted: boolean };

const rect = (id: string, version: number, isDeleted = false): ElementSpec => ({
  id,
  version,
  isDeleted,
});

// syncInvalidIndices bumps versions, so pin them after indices are assigned
const scene = (...specs: ElementSpec[]) =>
  syncInvalidIndices(
    specs.map((spec) =>
      API.createElement({
        type: "rectangle",
        id: spec.id,
        isDeleted: spec.isDeleted,
      }),
    ),
  ).map((element, i) => ({
    ...element,
    version: specs[i].version,
    versionNonce: specs[i].version * 1000 + specs[i].id.charCodeAt(0),
    updated: Date.now(),
  })) as OrderedExcalidrawElement[];

const ids = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.map((element) => `${element.id}@${element.version}`).sort();

const drawingMeta = (version: string): DriveDrawing => ({
  id: "file-1",
  name: "Plan.excalidraw",
  modifiedTime: new Date().toISOString(),
  version,
});

const createFakeClient = (remote: { content: string; version: string }) => {
  const client = {
    ensureFolder: vi.fn(async () => "folder-1"),
    listDrawings: vi.fn(async () => [drawingMeta(remote.version)]),
    getDrawingMetadata: vi.fn(async () => drawingMeta(remote.version)),
    downloadDrawing: vi.fn(async () => remote.content),
    updateDrawingContent: vi.fn(async (_id: string, content: string) => {
      remote.content = content;
      remote.version = String(Number(remote.version) + 1);
      return drawingMeta(remote.version);
    }),
    createDrawing: vi.fn(),
    renameDrawing: vi.fn(),
    trashDrawing: vi.fn(),
  };
  return client;
};

const createFakeApi = (initial: OrderedExcalidrawElement[]) => {
  let elements = initial;
  const files: BinaryFiles = {};
  const appState = { ...getDefaultAppState(), isLoading: false } as AppState;
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getAppState: () => appState,
    getFiles: () => files,
    getName: () => "Untitled",
    updateScene: vi.fn(
      (data: { elements?: readonly OrderedExcalidrawElement[] }) => {
        if (data.elements) {
          elements = [...data.elements];
        }
      },
    ),
    addFiles: vi.fn(),
    setToast: vi.fn(),
    setViewport: vi.fn(),
    resetScene: vi.fn(() => {
      elements = [];
    }),
    history: { clear: vi.fn() },
  };
  return {
    api,
    setElements: (next: OrderedExcalidrawElement[]) => {
      elements = next;
    },
  };
};

const LINK_KEY = "excalidraw-gdrive-link";

const setUpSync = async (opts: {
  local: OrderedExcalidrawElement[];
  remote: OrderedExcalidrawElement[];
  linkedVersion: string;
  remoteVersion: string;
  confirmReplaceCanvas?: () => Promise<boolean>;
}) => {
  localStorage.setItem(
    LINK_KEY,
    JSON.stringify({
      fileId: "file-1",
      name: "Plan",
      version: opts.linkedVersion,
    }),
  );
  const remote = {
    content: serializeDriveScene(opts.remote, {}, {}),
    version: opts.remoteVersion,
  };
  const client = createFakeClient(remote);
  const fakeApi = createFakeApi(opts.local);
  const sync = new DriveSync({
    client: client as unknown as DriveClient,
    confirmReplaceCanvas: opts.confirmReplaceCanvas,
  });
  await sync.init(fakeApi.api as unknown as ExcalidrawImperativeAPI, {
    isExternalScene: false,
  });
  return { sync, client, remote, ...fakeApi };
};

describe("mergeDriveScene", () => {
  it("keeps the newer version of each element and elements only one side has", () => {
    const local = scene(rect("a", 4), rect("b", 2), rect("c", 1));
    const remote = scene(rect("a", 3), rect("b", 5), rect("d", 1));

    const merged = mergeDriveScene(
      { elements: local, files: {} },
      parseDriveScene(serializeDriveScene(remote, {}, {}), null),
      getDefaultAppState() as AppState,
    );

    // c and d share an index, so reconcile re-indexes one and bumps its version
    expect(merged.elements.map((element) => element.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    const versions = new Map(
      merged.elements.map((element) => [element.id, element.version]),
    );
    expect(versions.get("a")).toBe(4);
    expect(versions.get("b")).toBe(5);
  });

  it("applies a newer remote deletion", () => {
    const local = scene(rect("a", 2));
    const remote = scene(rect("a", 3, true));

    const merged = mergeDriveScene(
      { elements: local, files: {} },
      parseDriveScene(serializeDriveScene(remote, {}, {}), null),
      getDefaultAppState() as AppState,
    );

    expect(merged.elements).toHaveLength(1);
    expect(merged.elements[0].isDeleted).toBe(true);
  });

  it("rejects files that aren't Excalidraw drawings", () => {
    expect(() => parseDriveScene("not json", null)).toThrow();
    expect(() =>
      parseDriveScene(JSON.stringify({ type: "x" }), null),
    ).toThrow();
  });
});

describe("DriveSync", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uploads local changes when Drive hasn't changed", async () => {
    const { sync, client, remote } = await setUpSync({
      local: scene(rect("a", 2)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.syncNow();

    expect(client.updateDrawingContent).toHaveBeenCalledTimes(1);
    expect(ids(parseDriveScene(remote.content, null).elements)).toEqual([
      "a@2",
    ]);
    expect(appJotaiStore.get(driveStateAtom).current?.version).toBe("8");
    expect(appJotaiStore.get(driveStateAtom).syncStatus).toBe("synced");
  });

  it("merges remote edits into the canvas before uploading", async () => {
    const { sync, api, remote } = await setUpSync({
      local: scene(rect("a", 4), rect("b", 1)),
      remote: scene(rect("a", 3), rect("b", 6)),
      linkedVersion: "7",
      remoteVersion: "9",
    });

    await sync.syncNow();

    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["a@4", "b@6"]);
    expect(ids(parseDriveScene(remote.content, null).elements)).toEqual([
      "a@4",
      "b@6",
    ]);
  });

  it("skips the upload when nothing changed since the last sync", async () => {
    const { sync, client } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });

    await sync.syncNow();
    await sync.syncNow();

    expect(client.updateDrawingContent).not.toHaveBeenCalled();
  });

  it("stops syncing when the canvas is replaced by an unrelated scene", async () => {
    const { sync, client, api, setElements } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });
    await sync.syncNow();

    setElements(scene(rect("z", 1)));
    await sync.syncNow();

    expect(client.updateDrawingContent).not.toHaveBeenCalled();
    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
    expect(localStorage.getItem(LINK_KEY)).toBeNull();
    expect(api.setToast).toHaveBeenCalled();
  });

  it("asks to reconnect when the Google token is rejected", async () => {
    const { sync, client } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("a", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
    });
    client.getDrawingMetadata.mockRejectedValueOnce(
      new DriveApiError("Invalid Credentials", 401),
    );

    await sync.syncNow();

    expect(appJotaiStore.get(driveStateAtom).connection).toBe(
      "reconnectRequired",
    );
    expect(appJotaiStore.get(driveStateAtom).current?.fileId).toBe("file-1");
  });

  it("doesn't replace an unsaved canvas when the user cancels", async () => {
    const { sync, client, api } = await setUpSync({
      local: scene(rect("a", 1)),
      remote: scene(rect("b", 1)),
      linkedVersion: "7",
      remoteVersion: "7",
      confirmReplaceCanvas: async () => false,
    });
    sync.unlink();

    await sync.openDrawing("file-1");

    expect(client.downloadDrawing).not.toHaveBeenCalled();
    expect(ids(api.getSceneElementsIncludingDeleted())).toEqual(["a@1"]);
  });

  it("forgets the linked drawing when the app opens an external scene", async () => {
    localStorage.setItem(
      LINK_KEY,
      JSON.stringify({ fileId: "file-1", name: "Plan", version: "1" }),
    );
    const sync = new DriveSync({
      client: createFakeClient({
        content: serializeDriveScene([], {}, {}),
        version: "1",
      }) as unknown as DriveClient,
    });

    await sync.init(
      createFakeApi([]).api as unknown as ExcalidrawImperativeAPI,
      { isExternalScene: true },
    );

    expect(appJotaiStore.get(driveStateAtom).current).toBeNull();
  });
});
