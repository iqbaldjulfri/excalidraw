import { MIME_TYPES } from "@excalidraw/common";

const GAPI_SCRIPT_SRC = "https://apis.google.com/js/api.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// files people uploaded themselves rarely carry our MIME type
const DRAWING_MIME_TYPES = [
  MIME_TYPES.excalidraw,
  "application/json",
  "application/octet-stream",
  "text/plain",
].join(",");

export type PickerConfig = { apiKey: string; appId: string };
export type PickedItem = { id: string; name: string };

type PickerDocument = { id: string; name: string };
type PickerResponse = { action: string; docs?: PickerDocument[] };

type DocsView = {
  setMimeTypes: (mimeTypes: string) => DocsView;
  setIncludeFolders: (include: boolean) => DocsView;
  setSelectFolderEnabled: (enabled: boolean) => DocsView;
  setMode: (mode: unknown) => DocsView;
};

type PickerBuilder = {
  addView: (view: DocsView) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  setCallback: (callback: (response: PickerResponse) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

type PickerNamespace = {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: unknown) => DocsView;
  ViewId: { DOCS: unknown; FOLDERS: unknown };
  DocsViewMode: { LIST: unknown };
  Action: { PICKED: string; CANCEL: string };
};

declare global {
  interface Window {
    gapi?: { load: (api: string, callback: () => void) => void };
    google?: { picker?: PickerNamespace };
  }
}

let pickerPromise: Promise<PickerNamespace> | null = null;

const loadPicker = (): Promise<PickerNamespace> => {
  if (!pickerPromise) {
    pickerPromise = new Promise<PickerNamespace>((resolve, reject) => {
      const onGapi = () =>
        window.gapi!.load("picker", () => {
          const picker = window.google?.picker;
          if (picker) {
            resolve(picker);
          } else {
            reject(new Error("Google Picker failed to initialize"));
          }
        });
      if (window.gapi) {
        onGapi();
        return;
      }
      const script = document.createElement("script");
      script.src = GAPI_SCRIPT_SRC;
      script.async = true;
      script.onload = onGapi;
      script.onerror = () => {
        pickerPromise = null;
        script.remove();
        reject(new Error("Couldn't load the Google Drive picker"));
      };
      document.head.appendChild(script);
    });
  }
  return pickerPromise;
};

const showPicker = async (opts: {
  config: PickerConfig;
  accessToken: string;
  title: string;
  buildView: (picker: PickerNamespace) => DocsView;
}): Promise<PickedItem | null> => {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(opts.buildView(picker))
      .setOAuthToken(opts.accessToken)
      .setDeveloperKey(opts.config.apiKey)
      // must be the project number of the OAuth client, or picked files
      // aren't granted to the drive.file scope
      .setAppId(opts.config.appId)
      .setTitle(opts.title)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED && response.docs?.[0]) {
          const [doc] = response.docs;
          resolve({ id: doc.id, name: doc.name });
        } else if (response.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
};

export const pickDrawingFile = (opts: {
  config: PickerConfig;
  accessToken: string;
  title: string;
}) =>
  showPicker({
    ...opts,
    buildView: (picker) =>
      new picker.DocsView(picker.ViewId.DOCS)
        .setMimeTypes(DRAWING_MIME_TYPES)
        .setIncludeFolders(true)
        .setMode(picker.DocsViewMode.LIST),
  });

export const pickFolder = (opts: {
  config: PickerConfig;
  accessToken: string;
  title: string;
}) =>
  showPicker({
    ...opts,
    buildView: (picker) =>
      new picker.DocsView(picker.ViewId.FOLDERS)
        .setMimeTypes(FOLDER_MIME_TYPE)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMode(picker.DocsViewMode.LIST),
  });
