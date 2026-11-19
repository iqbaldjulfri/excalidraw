import { MIME_TYPES } from "@excalidraw/common";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FOLDER_NAME = "Excalidraw";

// appProperties are private to this OAuth client, so they tag our files
// without relying on names the user can change.
const ROLE_KEY = "excalidrawRole";
const ROLE_FOLDER = "drawings-folder";
const ROLE_DRAWING = "drawing";

const DRAWING_FIELDS = "id,name,modifiedTime,version";

export type DriveDrawing = {
  id: string;
  name: string;
  modifiedTime: string;
  /** Drive bumps this on every change to the file, including our own writes. */
  version: string;
};

export class DriveApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DriveApiError";
  }
}

export const isDriveAuthError = (error: unknown) =>
  error instanceof DriveApiError && error.status === 401;

export const isDriveNotFoundError = (error: unknown) =>
  error instanceof DriveApiError && error.status === 404;

export const toDriveFileName = (name: string) =>
  name.endsWith(".excalidraw") ? name : `${name}.excalidraw`;

export const toDrawingName = (fileName: string) =>
  fileName.replace(/\.excalidraw$/, "");

export class DriveClient {
  constructor(
    private readonly getAccessToken: (opts: {
      forceRefresh: boolean;
    }) => Promise<string>,
  ) {}

  private async send(url: string, init: RequestInit, forceRefresh: boolean) {
    const token = await this.getAccessToken({ forceRefresh });
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }

  private async request(url: string, init: RequestInit = {}) {
    let response = await this.send(url, init, false);
    if (response.status === 401) {
      response = await this.send(url, init, true);
    }
    if (!response.ok) {
      let message = `Google Drive request failed (${response.status})`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch {
        // non-JSON error body: keep the status-based message
      }
      throw new DriveApiError(message, response.status);
    }
    return response;
  }

  private async requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.request(url, init);
    return response.json() as Promise<T>;
  }

  async ensureFolder(): Promise<string> {
    const query = [
      `mimeType='${FOLDER_MIME_TYPE}'`,
      `appProperties has { key='${ROLE_KEY}' and value='${ROLE_FOLDER}' }`,
      "trashed=false",
    ].join(" and ");
    const { files } = await this.requestJSON<{ files: { id: string }[] }>(
      `${DRIVE_API}/files?${new URLSearchParams({
        q: query,
        fields: "files(id)",
        pageSize: "1",
      })}`,
    );
    if (files.length) {
      return files[0].id;
    }
    const folder = await this.requestJSON<{ id: string }>(
      `${DRIVE_API}/files?fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: FOLDER_MIME_TYPE,
          appProperties: { [ROLE_KEY]: ROLE_FOLDER },
        }),
      },
    );
    return folder.id;
  }

  /** Every drawing the app created or opened, in whichever folder it lives. */
  async listDrawings(): Promise<DriveDrawing[]> {
    const query = [
      `appProperties has { key='${ROLE_KEY}' and value='${ROLE_DRAWING}' }`,
      "trashed=false",
    ].join(" and ");
    const drawings: DriveDrawing[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${DRAWING_FIELDS})`,
        orderBy: "modifiedTime desc",
        pageSize: "100",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const page = await this.requestJSON<{
        files: DriveDrawing[];
        nextPageToken?: string;
      }>(`${DRIVE_API}/files?${params}`);
      drawings.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return drawings;
  }

  async createDrawing(opts: {
    folderId: string;
    name: string;
    content: string;
  }): Promise<DriveDrawing> {
    const boundary = `excalidraw-${Math.random().toString(36).slice(2)}`;
    const metadata = {
      name: toDriveFileName(opts.name),
      mimeType: MIME_TYPES.excalidraw,
      parents: [opts.folderId],
      appProperties: { [ROLE_KEY]: ROLE_DRAWING },
    };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${MIME_TYPES.excalidraw}`,
      "",
      opts.content,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${DRAWING_FIELDS}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
  }

  getDrawingMetadata(fileId: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
    );
  }

  async downloadDrawing(fileId: string): Promise<string> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    return response.text();
  }

  updateDrawingContent(fileId: string, content: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(
        fileId,
      )}?uploadType=media&fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": MIME_TYPES.excalidraw },
        body: content,
      },
    );
  }

  renameDrawing(fileId: string, name: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: toDriveFileName(name) }),
      },
    );
  }

  /** Marks a file the user picked, so it shows in the drawings list. */
  tagAsDrawing(fileId: string): Promise<DriveDrawing> {
    return this.requestJSON<DriveDrawing>(
      `${DRIVE_API}/files/${encodeURIComponent(
        fileId,
      )}?fields=${DRAWING_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties: { [ROLE_KEY]: ROLE_DRAWING } }),
      },
    );
  }

  async trashDrawing(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }
}
