import { reconcileElements } from "@excalidraw/excalidraw";
import {
  isValidExcalidrawData,
  serializeAsJSON,
} from "@excalidraw/excalidraw/data/json";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { hashElementsVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from "../index";

export type DriveScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: ImportedDataState["appState"];
  files: BinaryFiles;
};

export const parseDriveScene = (
  content: string,
  localElements: readonly OrderedExcalidrawElement[] | null,
): DriveScene => {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("The Drive file is not valid JSON");
  }
  if (!isValidExcalidrawData(data as ImportedDataState)) {
    throw new Error("The Drive file is not an Excalidraw drawing");
  }
  const scene = data as ImportedDataState;
  return {
    // localElements only gives binding repair some context; it must not bump
    // remote versions, or every remote element would win the merge.
    elements: restoreElements(scene.elements, localElements),
    appState: scene.appState,
    files: scene.files ?? {},
  };
};

/**
 * Deleted elements are kept as tombstones for a day (same rule as live
 * collab), so a deletion on one device beats an older edit on another.
 */
export const serializeDriveScene = (
  elements: readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => serializeAsJSON(getSyncableElements(elements), appState, files, "local");

export const hashSyncableElements = (
  elements: readonly OrderedExcalidrawElement[],
) => hashElementsVersion(getSyncableElements(elements));

export const mergeDriveScene = (
  local: {
    elements: readonly OrderedExcalidrawElement[];
    files: BinaryFiles;
  },
  remote: DriveScene,
  localAppState: AppState,
) => {
  const elements = reconcileElements(
    local.elements,
    remote.elements as RemoteExcalidrawElement[],
    localAppState,
  );
  const missingFiles = Object.values(remote.files).filter(
    (file) => !local.files[file.id],
  );
  return { elements, missingFiles };
};

export const restoreDriveAppState = (
  remote: DriveScene,
  localAppState: AppState,
) => restoreAppState(remote.appState, localAppState);
