import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import { t } from "@excalidraw/excalidraw/i18n";
import { debounce } from "@excalidraw/common";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { appJotaiStore, atom } from "../../app-jotai";

import { SignedOutError, currentUserAtom } from "../session";

import {
  DriveNotGrantedError,
  getDriveAccessToken,
  isGoogleDriveEnabled,
} from "./auth";
import { DriveClient, isDriveNotFoundError, toDrawingName } from "./driveApi";
import {
  hashSyncableElements,
  mergeDriveScene,
  parseDriveScene,
  restoreDriveAppState,
  serializeDriveScene,
} from "./mergeScene";

import { pickDrawingFile, pickFolder } from "./picker";

import type { DriveDrawing } from "./driveApi";
import type { PickedItem } from "./picker";

// localStorage, not sessionStorage: tabs share one canvas in localStorage, so
// they must also share which Drive drawing that canvas belongs to.
const LINK_STORAGE_KEY = "excalidraw-gdrive-link";
const SAVE_FOLDER_STORAGE_KEY = "excalidraw-gdrive-save-folder";
const DEFAULT_FOLDER_NAME = "Excalidraw";

const SYNC_DEBOUNCE_MS = 2000;

export type DriveLink = {
  fileId: string;
  name: string;
  /** Drive file version our canvas last matched, to detect remote edits. */
  version: string;
};

export type DriveConnection =
  | "disabled"
  | "connecting"
  | "connected"
  /** The app's login session ended; a new sign-in is needed. */
  | "signedOut"
  /** The user unticked Drive on Google's consent screen. */
  | "driveNotGranted"
  | "error";

export type DriveSyncStatus = "idle" | "syncing" | "synced" | "error";

export type DriveState = {
  connection: DriveConnection;
  drawings: DriveDrawing[];
  current: DriveLink | null;
  syncStatus: DriveSyncStatus;
  lastSyncedAt: number | null;
  error: string | null;
  /** Where new drawings are created. */
  saveFolder: DriveFolder | null;
  /** Opening, creating or deleting a drawing; blocks other list actions. */
  busy: boolean;
};

export type DriveFolder = { id: string; name: string };

type Pickers = {
  pickDrawingFile: () => Promise<PickedItem | null>;
  pickFolder: () => Promise<PickedItem | null>;
};

const readSaveFolder = (): DriveFolder | null => {
  try {
    const raw = localStorage.getItem(SAVE_FOLDER_STORAGE_KEY);
    const folder = raw ? (JSON.parse(raw) as DriveFolder) : null;
    return folder?.id ? folder : null;
  } catch {
    return null;
  }
};

const writeSaveFolder = (folder: DriveFolder | null) => {
  try {
    if (folder) {
      localStorage.setItem(SAVE_FOLDER_STORAGE_KEY, JSON.stringify(folder));
    } else {
      localStorage.removeItem(SAVE_FOLDER_STORAGE_KEY);
    }
  } catch {
    // storage blocked: new drawings go to the default folder next time
  }
};

const readLink = (): DriveLink | null => {
  try {
    const raw = localStorage.getItem(LINK_STORAGE_KEY);
    const link = raw ? (JSON.parse(raw) as DriveLink) : null;
    return link?.fileId ? link : null;
  } catch {
    return null;
  }
};

const writeLink = (link: DriveLink | null) => {
  try {
    if (link) {
      localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(link));
    } else {
      localStorage.removeItem(LINK_STORAGE_KEY);
    }
  } catch {
    // storage blocked: the link lasts for this page load only
  }
};

export const driveStateAtom = atom<DriveState>({
  connection: "disabled",
  drawings: [],
  current: null,
  syncStatus: "idle",
  lastSyncedAt: null,
  error: null,
  saveFolder: null,
  busy: false,
});

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class DriveSync {
  private api: ExcalidrawImperativeAPI | null = null;
  private readonly client: DriveClient;
  private syncChain: Promise<void> = Promise.resolve();
  /** Hash of the elements Drive holds, so unchanged canvases skip uploads. */
  private lastSyncedHash: number | null = null;
  /** Element ids of the last synced scene, to notice a replaced canvas. */
  private lastSyncedIds: Set<string> | null = null;

  private readonly pickers: Pickers;

  constructor(
    private readonly opts: {
      client?: DriveClient;
      confirmReplaceCanvas?: () => Promise<boolean>;
      pickers?: Pickers;
    } = {},
  ) {
    this.client = opts.client ?? new DriveClient(getDriveAccessToken);
    this.pickers = opts.pickers ?? googlePickers;
  }

  getState() {
    return appJotaiStore.get(driveStateAtom);
  }

  private setState(update: Partial<DriveState>) {
    appJotaiStore.set(driveStateAtom, { ...this.getState(), ...update });
  }

  private setCurrent(link: DriveLink | null) {
    writeLink(link);
    this.setState({ current: link });
  }

  private resetSyncTracking() {
    this.lastSyncedHash = null;
    this.lastSyncedIds = null;
  }

  /**
   * Call once the initial scene is known. The first sync waits for the first
   * onChange, which Excalidraw only emits after it has applied that scene.
   */
  async init(api: ExcalidrawImperativeAPI, opts: { isExternalScene: boolean }) {
    this.api = api;
    if (!isGoogleDriveEnabled()) {
      this.setState({ connection: "disabled" });
      return;
    }
    if (opts.isExternalScene) {
      writeLink(null);
    }
    this.setState({ current: readLink() });
    await this.connect({ syncNow: false });
  }

  /** Signing in to the app grants Drive, so this needs no user gesture. */
  async connect(opts: { syncNow: boolean } = { syncNow: true }) {
    this.setState({ connection: "connecting", error: null });
    try {
      const saveFolder = readSaveFolder() ?? (await this.defaultFolder());
      const drawings = await this.client.listDrawings();
      this.setState({ connection: "connected", drawings, saveFolder });
    } catch (error) {
      this.handleError(error, { whileConnecting: true });
      return;
    }
    if (opts.syncNow && this.getState().current) {
      await this.syncNow();
    }
  }

  private async defaultFolder(): Promise<DriveFolder> {
    return { id: await this.client.ensureFolder(), name: DEFAULT_FOLDER_NAME };
  }

  /**
   * Call before signing out. Tabs and the next user of this browser share
   * localStorage, so nothing may keep pointing at this user's Drive.
   */
  async prepareForSignOut() {
    await this.syncNow();
    this.unlink();
    writeSaveFolder(null);
    this.setState({
      connection: "signedOut",
      drawings: [],
      saveFolder: null,
      syncStatus: "idle",
      lastSyncedAt: null,
      error: null,
    });
  }

  async refreshDrawings() {
    if (this.getState().connection !== "connected") {
      return;
    }
    try {
      this.setState({ drawings: await this.client.listDrawings() });
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleError(
    error: unknown,
    opts: { whileConnecting?: boolean } = {},
  ) {
    if (error instanceof SignedOutError) {
      this.scheduleSync.cancel();
      this.setState({
        connection: "signedOut",
        syncStatus: "idle",
        error: null,
      });
      return;
    }
    if (error instanceof DriveNotGrantedError) {
      this.setState({ connection: "driveNotGranted", error: null });
      return;
    }
    this.setState({
      ...(opts.whileConnecting ? { connection: "error" as const } : null),
      syncStatus: "error",
      error: getErrorMessage(error),
    });
  }

  // ---------------------------------------------------------------------------
  // syncing the canvas

  /** Call on every canvas change; syncs once the user pauses. */
  onSceneChange(elements: readonly OrderedExcalidrawElement[]) {
    const { connection, current } = this.getState();
    if (
      connection === "connected" &&
      current &&
      // onChange also fires for cursor moves and selection; skip those
      hashSyncableElements(elements) !== this.lastSyncedHash
    ) {
      this.scheduleSync();
    }
  }

  private scheduleSync = debounce(() => {
    this.syncNow();
  }, SYNC_DEBOUNCE_MS);

  /** Runs syncs one at a time, so two never upload over each other. */
  syncNow(): Promise<void> {
    this.scheduleSync.cancel();
    this.syncChain = this.syncChain.then(() => this.sync());
    return this.syncChain;
  }

  private async sync() {
    const api = this.api;
    const { connection, current } = this.getState();
    if (
      !api ||
      connection !== "connected" ||
      !current ||
      // a focus event can land before the initial scene is applied
      api.getAppState().isLoading
    ) {
      return;
    }

    let elements = api.getSceneElementsIncludingDeleted();

    if (this.isCanvasReplaced(elements)) {
      this.unlink();
      api.setToast({
        message: t("googleDrive.toasts.canvasReplaced", { name: current.name }),
        closable: true,
        duration: 8000,
      });
      return;
    }

    this.setState({ syncStatus: "syncing", error: null });
    try {
      const metadata = await this.client.getDrawingMetadata(current.fileId);
      let driveHash = this.lastSyncedHash;
      let version = current.version;

      if (metadata.version !== current.version || driveHash === null) {
        const remote = parseDriveScene(
          await this.client.downloadDrawing(current.fileId),
          elements,
        );
        driveHash = hashSyncableElements(remote.elements);
        version = metadata.version;

        const merged = mergeDriveScene(
          { elements, files: api.getFiles() },
          remote,
          api.getAppState(),
        );
        if (merged.missingFiles.length) {
          api.addFiles(merged.missingFiles);
        }
        if (
          hashSyncableElements(merged.elements) !==
          hashSyncableElements(elements)
        ) {
          // NEVER: remote edits shouldn't land on this user's undo stack
          api.updateScene({
            elements: merged.elements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        elements = merged.elements;
      }

      const localHash = hashSyncableElements(elements);
      if (localHash !== driveHash) {
        const saved = await this.client.updateDrawingContent(
          current.fileId,
          serializeDriveScene(elements, api.getAppState(), api.getFiles()),
        );
        version = saved.version;
        this.updateListedDrawing(saved);
      }

      this.lastSyncedHash = localHash;
      this.lastSyncedIds = new Set(elements.map((element) => element.id));
      if (this.getState().current?.fileId === current.fileId) {
        this.setCurrent({ ...current, version });
      }
      this.setState({ syncStatus: "synced", lastSyncedAt: Date.now() });
    } catch (error) {
      if (isDriveNotFoundError(error)) {
        this.unlink();
        this.setState({
          syncStatus: "error",
          error: t("googleDrive.errors.fileMissing", { name: current.name }),
        });
        this.refreshDrawings();
        return;
      }
      this.handleError(error);
    }
  }

  /**
   * Opening a file from disk or a shared link swaps in elements with new ids.
   * Clearing the canvas marks elements deleted instead, so ids overlap and
   * the clear syncs as normal.
   */
  private isCanvasReplaced(
    elements: readonly { id: string; isDeleted: boolean }[],
  ) {
    if (!this.lastSyncedIds?.size) {
      return false;
    }
    const liveElements = elements.filter((element) => !element.isDeleted);
    return (
      liveElements.length > 0 &&
      !elements.some((element) => this.lastSyncedIds!.has(element.id))
    );
  }

  private updateListedDrawing(drawing: DriveDrawing) {
    const others = this.getState().drawings.filter(
      (item) => item.id !== drawing.id,
    );
    this.setState({ drawings: [drawing, ...others] });
  }

  // ---------------------------------------------------------------------------
  // managing drawings

  unlink() {
    this.scheduleSync.cancel();
    this.resetSyncTracking();
    this.setCurrent(null);
  }

  /** The canvas now holds a scene from elsewhere (shared link, collab room). */
  onExternalSceneLoaded() {
    if (this.getState().current) {
      this.unlink();
    }
  }

  /** Another tab may have switched drawings; tabs share the canvas. */
  reloadLinkFromStorage() {
    const stored = readLink();
    if (stored?.fileId !== this.getState().current?.fileId) {
      this.scheduleSync.cancel();
      this.resetSyncTracking();
      this.setState({ current: stored });
    }
  }

  /**
   * Saves pending work before the canvas is swapped out. Returns false when
   * that work would be lost, so the caller must not replace the canvas.
   */
  private async prepareToReplaceCanvas(): Promise<boolean> {
    const api = this.api;
    if (!api) {
      return false;
    }
    if (this.getState().current) {
      await this.syncNow();
      return this.getState().syncStatus !== "error";
    }
    const hasUnsavedContent = api
      .getSceneElements()
      .some((element) => !element.isDeleted);
    if (!hasUnsavedContent) {
      return true;
    }
    return (this.opts.confirmReplaceCanvas ?? confirmReplaceCanvas)();
  }

  private async runBusy(task: () => Promise<void>) {
    if (this.getState().busy) {
      return;
    }
    this.setState({ busy: true, error: null });
    try {
      await task();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.setState({ busy: false });
    }
  }

  openDrawing(fileId: string) {
    return this.runBusy(async () => {
      const api = this.api;
      if (!api || this.getState().current?.fileId === fileId) {
        return;
      }
      if (!(await this.prepareToReplaceCanvas())) {
        return;
      }
      const metadata = await this.client.getDrawingMetadata(fileId);
      const remote = parseDriveScene(
        await this.client.downloadDrawing(fileId),
        null,
      );
      const name = toDrawingName(metadata.name);

      this.resetSyncTracking();
      api.updateScene({
        elements: remote.elements,
        appState: {
          ...restoreDriveAppState(remote, api.getAppState()),
          name,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.addFiles(Object.values(remote.files));
      api.history.clear();
      const liveElements = remote.elements.filter((el) => !el.isDeleted);
      if (liveElements.length) {
        api.setViewport({
          target: liveElements,
          fit: "scale-down",
          animation: false,
        });
      }

      this.lastSyncedHash = hashSyncableElements(remote.elements);
      this.lastSyncedIds = new Set(remote.elements.map((el) => el.id));
      this.setCurrent({ fileId, name, version: metadata.version });
      this.setState({ syncStatus: "synced", lastSyncedAt: Date.now() });
    });
  }

  /** `fromCanvas` uploads the current canvas; otherwise starts a blank one. */
  createDrawing(opts: { fromCanvas: boolean }) {
    return this.runBusy(async () => {
      const api = this.api;
      const { saveFolder } = this.getState();
      if (!api || !saveFolder) {
        return;
      }
      if (!opts.fromCanvas) {
        if (!(await this.prepareToReplaceCanvas())) {
          return;
        }
        this.unlink();
        // resetScene restores default appState, which would close the sidebar
        // the user just clicked in
        const { openSidebar } = api.getAppState();
        api.resetScene();
        api.updateScene({
          appState: { openSidebar },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else {
        this.unlink();
      }
      const elements = api.getSceneElementsIncludingDeleted();
      const name = this.uniqueDrawingName(api.getName());
      if (name !== api.getName()) {
        api.updateScene({
          appState: { name },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      const content = serializeDriveScene(
        elements,
        api.getAppState(),
        api.getFiles(),
      );
      let created: DriveDrawing;
      try {
        created = await this.client.createDrawing({
          folderId: saveFolder.id,
          name,
          content,
        });
      } catch (error) {
        if (!isDriveNotFoundError(error)) {
          throw error;
        }
        // the chosen folder was deleted in Drive: fall back to the default
        const fallback = await this.defaultFolder();
        writeSaveFolder(null);
        this.setState({ saveFolder: fallback });
        created = await this.client.createDrawing({
          folderId: fallback.id,
          name,
          content,
        });
      }
      this.lastSyncedHash = hashSyncableElements(elements);
      this.lastSyncedIds = new Set(elements.map((element) => element.id));
      this.setCurrent({
        fileId: created.id,
        name: toDrawingName(created.name),
        version: created.version,
      });
      this.updateListedDrawing(created);
      this.setState({ syncStatus: "synced", lastSyncedAt: Date.now() });
    });
  }

  /** Opens a drawing the user picks anywhere in their Drive. */
  async openFromDrive() {
    const picked = await this.runPicker(this.pickers.pickDrawingFile);
    if (!picked) {
      return;
    }
    await this.openDrawing(picked.id);
    if (this.getState().current?.fileId !== picked.id) {
      // opening failed or was cancelled; don't list a file we couldn't read
      return;
    }
    try {
      this.updateListedDrawing(await this.client.tagAsDrawing(picked.id));
    } catch (error) {
      this.handleError(error);
    }
  }

  async chooseSaveFolder() {
    const picked = await this.runPicker(this.pickers.pickFolder);
    if (picked) {
      writeSaveFolder(picked);
      this.setState({ saveFolder: picked });
    }
  }

  private async runPicker(pick: () => Promise<PickedItem | null>) {
    try {
      return await pick();
    } catch (error) {
      this.handleError(error);
      return null;
    }
  }

  /** The default name only changes once a minute, so it collides easily. */
  private uniqueDrawingName(name: string) {
    const taken = new Set(
      this.getState().drawings.map((drawing) => toDrawingName(drawing.name)),
    );
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix++) {
      candidate = `${name} (${suffix})`;
    }
    return candidate;
  }

  renameDrawing(fileId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      return Promise.resolve();
    }
    return this.runBusy(async () => {
      const renamed = await this.client.renameDrawing(fileId, trimmed);
      this.setState({
        drawings: this.getState().drawings.map((drawing) =>
          drawing.id === fileId ? renamed : drawing,
        ),
      });
      const { current } = this.getState();
      if (current?.fileId === fileId) {
        this.setCurrent({
          ...current,
          name: toDrawingName(renamed.name),
          // renaming bumps the version but leaves the content as we know it
          version: renamed.version,
        });
        this.api?.updateScene({
          appState: { name: toDrawingName(renamed.name) },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    });
  }

  trashDrawing(fileId: string) {
    return this.runBusy(async () => {
      await this.client.trashDrawing(fileId);
      if (this.getState().current?.fileId === fileId) {
        this.unlink();
      }
      this.setState({
        drawings: this.getState().drawings.filter(
          (drawing) => drawing.id !== fileId,
        ),
      });
    });
  }
}

const confirmReplaceCanvas = () =>
  openConfirmModal({
    title: t("googleDrive.replaceCanvas.title"),
    description: t("googleDrive.replaceCanvas.description"),
    actionLabel: t("googleDrive.replaceCanvas.button"),
    color: "danger",
  });

const pickerOptions = async () => {
  const config = appJotaiStore.get(currentUserAtom)?.picker;
  if (!config) {
    throw new Error(t("googleDrive.errors.pickerUnavailable"));
  }
  return {
    config,
    accessToken: await getDriveAccessToken(),
  };
};

const googlePickers: Pickers = {
  pickDrawingFile: async () =>
    pickDrawingFile({
      ...(await pickerOptions()),
      title: t("googleDrive.picker.openTitle"),
    }),
  pickFolder: async () =>
    pickFolder({
      ...(await pickerOptions()),
      title: t("googleDrive.picker.folderTitle"),
    }),
};

export const driveSync = new DriveSync();
