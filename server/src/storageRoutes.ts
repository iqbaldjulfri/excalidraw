import { StorageConflictError, isValidId } from "./storage";

import type { DiskStorage, OwnerKind, StoredRoomScene } from "./storage";
import type { IncomingMessage, ServerResponse } from "node:http";

const MiB = 1024 * 1024;
// the app refuses images over 4 MiB before encryption; leave room for that
const MAX_FILE_BYTES = 6 * MiB;
const MAX_SHARE_LINK_BYTES = 10 * MiB;
// room snapshots travel as base64 JSON, a third bigger than the bytes
const MAX_ROOM_BYTES = 15 * MiB;

class PayloadTooLargeError extends Error {}

/**
 * Rejects oversized bodies but keeps draining them: destroying the request
 * would also close the socket before the 413 reaches the browser.
 */
const readBody = (req: IncomingMessage, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) => {
    if (Number(req.headers["content-length"]) > maxBytes) {
      req.resume();
      reject(new PayloadTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sendJSON = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

const sendBytes = (
  res: ServerResponse,
  data: Buffer,
  cacheControl = "no-store",
) => {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
};

const isRoomScene = (value: any): value is StoredRoomScene =>
  typeof value?.sceneVersion === "number" &&
  typeof value?.iv === "string" &&
  typeof value?.ciphertext === "string";

const OWNER_KINDS: Record<string, OwnerKind> = {
  shareLinks: "shareLinks",
  rooms: "rooms",
};

/**
 * Same API shape the app expects: /api/v2 mirrors excalidraw-json for share
 * links; rooms and files replace Firestore and Firebase Storage.
 */
export const handleStorageRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  storage: DiskStorage,
) => {
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = req.method;

  try {
    if (parts[0] === "v2") {
      if (method === "POST" && parts[1] === "post" && parts.length === 2) {
        const body = await readBody(req, MAX_SHARE_LINK_BYTES);
        return sendJSON(res, 200, { id: await storage.createShareLink(body) });
      }
      if (method === "GET" && parts.length === 2 && isValidId(parts[1])) {
        const scene = await storage.readShareLink(parts[1]);
        return scene ? sendBytes(res, scene) : sendJSON(res, 404, {});
      }
    }

    if (parts[0] === "rooms" && parts.length === 2 && isValidId(parts[1])) {
      const roomId = parts[1];
      if (method === "GET") {
        const room = await storage.readRoom(roomId);
        return room
          ? sendJSON(res, 200, room)
          : sendJSON(res, 404, { error: "not_found" });
      }
      if (method === "PUT") {
        const body = JSON.parse(
          (await readBody(req, MAX_ROOM_BYTES)).toString("utf8"),
        );
        if (
          !isRoomScene(body?.scene) ||
          !(
            body.expectedRevision === null ||
            Number.isInteger(body.expectedRevision)
          )
        ) {
          return sendJSON(res, 400, { error: "invalid_scene" });
        }
        const revision = await storage.writeRoom(
          roomId,
          body.scene,
          body.expectedRevision,
        );
        return sendJSON(res, 200, { revision });
      }
    }

    const kind = OWNER_KINDS[parts[1]];
    if (
      parts[0] === "files" &&
      kind &&
      parts.length === 4 &&
      isValidId(parts[2]) &&
      isValidId(parts[3])
    ) {
      if (method === "PUT") {
        await storage.saveFile(
          kind,
          parts[2],
          parts[3],
          await readBody(req, MAX_FILE_BYTES),
        );
        res.writeHead(204).end();
        return;
      }
      if (method === "GET") {
        const data = await storage.readFile(kind, parts[2], parts[3]);
        return data
          ? // ids are content hashes, so a file never changes; private because
            // it's only served to signed-in users
            sendBytes(res, data, "private, max-age=31536000, immutable")
          : sendJSON(res, 404, { error: "not_found" });
      }
    }

    return sendJSON(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      // the app shows its "too big to share" message for this error_class
      return sendJSON(res, 413, { error_class: "RequestTooLargeError" });
    }
    if (error instanceof StorageConflictError) {
      return sendJSON(res, 409, { error: "conflict" });
    }
    if (error instanceof SyntaxError) {
      return sendJSON(res, 400, { error: "invalid_json" });
    }
    throw error;
  }
};
