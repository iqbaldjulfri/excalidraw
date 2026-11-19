/**
 * The self-hosted server's storage, standing in for Firestore and Firebase
 * Storage with the same function signatures (see ./firebase.ts). Like
 * Firebase, the server only ever sees data encrypted in the browser.
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  encryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// another collaborator saving at the same moment makes a save retry; more
// than a few in a row means something else is wrong
const MAX_SAVE_ATTEMPTS = 5;

type StoredRoomScene = {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
};

export const isHttpStorageEnabled = () =>
  !!import.meta.env.VITE_APP_STORAGE_URL;

const storageUrl = (path: string) =>
  `${import.meta.env.VITE_APP_STORAGE_URL}${path}`;

/** Firebase-style prefixes ("files/rooms/x", "/files/shareLinks/x") to API paths. */
const filesUrl = (prefix: string, fileId: string) =>
  storageUrl(`/${prefix.replace(/^\//, "")}/${encodeURIComponent(fileId)}`);

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  // chunked: spreading a whole scene into fromCharCode overflows the stack
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const encryptScene = async (
  key: string,
  elements: readonly SyncableExcalidrawElement[],
): Promise<StoredRoomScene> => {
  const { encryptedBuffer, iv } = await encryptData(
    key,
    new TextEncoder().encode(JSON.stringify(elements)),
  );
  return {
    sceneVersion: getSceneVersion(elements),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encryptedBuffer)),
  };
};

const decryptScene = async (
  scene: StoredRoomScene,
  key: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    fromBase64(scene.iv),
    fromBase64(scene.ciphertext),
    key,
  );
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(decrypted)));
};

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

const fetchRoom = async (
  roomId: string,
): Promise<{ scene: StoredRoomScene; revision: number } | null> => {
  const response = await fetch(storageUrl(`/rooms/${roomId}`), {
    credentials: "same-origin",
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Couldn't load the collaboration room (${response.status})`,
    );
  }
  return response.json();
};

export const isSavedToHttp = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return SceneVersionCache.get(portal.socket) === getSceneVersion(elements);
  }
  // no room: nothing could be saved anyway, so don't block unload
  return true;
};

export const saveToHttp = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToHttp(portal, elements)) {
    return null;
  }

  // read, merge, then write only if nobody saved in between: the server
  // answers 409 when the revision moved, and we merge again
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const stored = await fetchRoom(roomId);
    const nextElements = stored
      ? getSyncableElements(
          reconcileElements(
            elements,
            getSyncableElements(
              restoreElements(await decryptScene(stored.scene, roomKey), null),
            ) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        )
      : elements;
    const scene = await encryptScene(roomKey, nextElements);

    const response = await fetch(storageUrl(`/rooms/${roomId}`), {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene,
        expectedRevision: stored?.revision ?? null,
      }),
    });
    if (response.status === 409) {
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Couldn't save the collaboration room (${response.status})`,
      );
    }

    // decrypt what was stored: `elements` may have changed in memory since
    const storedElements = getSyncableElements(
      restoreElements(await decryptScene(scene, roomKey), null),
    );
    SceneVersionCache.set(socket, storedElements);
    return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
  }
  throw new Error("Couldn't save the collaboration room: too many conflicts");
};

export const loadFromHttp = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const stored = await fetchRoom(roomId);
  if (!stored) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptScene(stored.scene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );
  if (socket) {
    SceneVersionCache.set(socket, elements);
  }
  return elements;
};

export const saveFilesToHttp = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(filesUrl(prefix, id), {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/octet-stream" },
          body: buffer as Uint8Array<ArrayBuffer>,
        });
        if (!response.ok) {
          throw new Error(`Upload failed (${response.status})`);
        }
        savedFiles.push(id);
      } catch {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromHttp = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(filesUrl(prefix, id), {
          credentials: "same-origin",
        });
        if (!response.ok) {
          erroredFiles.set(id, true);
          return;
        }
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(await response.arrayBuffer()),
          { decryptionKey },
        );
        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
