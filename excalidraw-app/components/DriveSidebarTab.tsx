import { useEffect, useState } from "react";
import clsx from "clsx";

import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import {
  PlusIcon,
  TrashIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { useAtomValue } from "../app-jotai";
import { currentUserAtom, signInUrl, signOut } from "../data/session";
import { toDrawingName } from "../data/googleDrive/driveApi";
import { driveStateAtom, driveSync } from "../data/googleDrive/DriveSync";

import "./DriveSidebarTab.scss";

import type { DriveDrawing } from "../data/googleDrive/driveApi";
import type { DriveState } from "../data/googleDrive/DriveSync";

export const driveIcon = (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878" />
  </svg>
);

const formatRelativeTime = (timestamp: number, now: number, lang: string) => {
  const seconds = Math.round((timestamp - now) / 1000);
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(0, "second");
};

const useNow = (intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
};

const SyncStatusLine = ({ state }: { state: DriveState }) => {
  const { t, langCode } = useI18n();
  const now = useNow(30 * 1000);

  if (state.syncStatus === "syncing") {
    return <span>{t("googleDrive.status.syncing")}</span>;
  }
  if (state.syncStatus === "error") {
    return (
      <span className="drive-tab__status--error">
        {t("googleDrive.status.error")}
      </span>
    );
  }
  if (state.lastSyncedAt) {
    return (
      <span>
        {t("googleDrive.status.synced", {
          time: formatRelativeTime(state.lastSyncedAt, now, langCode),
        })}
      </span>
    );
  }
  return <span>{t("googleDrive.status.waiting")}</span>;
};

const DrawingRow = ({
  drawing,
  isCurrent,
  disabled,
}: {
  drawing: DriveDrawing;
  isCurrent: boolean;
  disabled: boolean;
}) => {
  const { t, langCode } = useI18n();
  const now = useNow(60 * 1000);
  const name = toDrawingName(drawing.name);
  const [draftName, setDraftName] = useState<string | null>(null);

  const commitRename = () => {
    if (draftName !== null && draftName.trim() && draftName !== name) {
      driveSync.renameDrawing(drawing.id, draftName);
    }
    setDraftName(null);
  };

  return (
    <li
      className={clsx("drive-tab__row", {
        "drive-tab__row--current": isCurrent,
      })}
    >
      {draftName !== null ? (
        <input
          className="drive-tab__rename"
          value={draftName}
          autoFocus
          aria-label={t("googleDrive.actions.rename")}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            // keep canvas shortcuts from firing while typing a name
            event.stopPropagation();
            if (event.key === "Enter") {
              commitRename();
            } else if (event.key === "Escape") {
              setDraftName(null);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="drive-tab__open"
          disabled={disabled || isCurrent}
          onClick={() => driveSync.openDrawing(drawing.id)}
          title={name}
        >
          <span className="drive-tab__name">{name}</span>
          <span className="drive-tab__meta">
            {isCurrent
              ? t("googleDrive.list.current")
              : formatRelativeTime(
                  new Date(drawing.modifiedTime).getTime(),
                  now,
                  langCode,
                )}
          </span>
        </button>
      )}
      <div className="drive-tab__row-actions">
        <button
          type="button"
          className="drive-tab__icon-button"
          disabled={disabled}
          title={t("googleDrive.actions.rename")}
          aria-label={t("googleDrive.actions.rename")}
          onClick={() => setDraftName(name)}
        >
          {pencilIcon}
        </button>
        <button
          type="button"
          className="drive-tab__icon-button"
          disabled={disabled}
          title={t("googleDrive.actions.trash")}
          aria-label={t("googleDrive.actions.trash")}
          onClick={() => driveSync.trashDrawing(drawing.id)}
        >
          {TrashIcon}
        </button>
      </div>
    </li>
  );
};

const NotConnected = ({ state }: { state: DriveState }) => {
  const { t } = useI18n();

  if (state.connection === "connecting") {
    return <p className="drive-tab__text">{t("googleDrive.connecting")}</p>;
  }

  if (
    state.connection === "signedOut" ||
    state.connection === "driveNotGranted"
  ) {
    return (
      <>
        <p className="drive-tab__text">
          {state.connection === "signedOut"
            ? t("googleDrive.signedOut")
            : t("googleDrive.driveNotGranted")}
        </p>
        <FilledButton
          fullWidth
          onClick={() => window.location.assign(signInUrl())}
        >
          {t("googleDrive.actions.signInAgain")}
        </FilledButton>
      </>
    );
  }

  return (
    <>
      <p className="drive-tab__error" role="alert">
        {state.error || t("googleDrive.errors.connectFailed")}
      </p>
      <FilledButton fullWidth onClick={() => driveSync.connect()}>
        {t("googleDrive.actions.retry")}
      </FilledButton>
    </>
  );
};

const AccountFooter = () => {
  const { t } = useI18n();
  const user = useAtomValue(currentUserAtom);

  return (
    <div className="drive-tab__account">
      {user && (
        <span className="drive-tab__account-email" title={user.email}>
          {t("googleDrive.signedInAs", { email: user.email })}
        </span>
      )}
      <button
        type="button"
        className="drive-tab__link"
        onClick={async () => {
          await driveSync.prepareForSignOut();
          await signOut();
        }}
      >
        {t("googleDrive.actions.signOut")}
      </button>
    </div>
  );
};

export const DriveSidebarTab = () => {
  const { t } = useI18n();
  const state = useAtomValue(driveStateAtom);

  if (state.connection === "disabled") {
    return null;
  }

  const errorLine = state.error && (
    <p className="drive-tab__error" role="alert">
      {state.error}
    </p>
  );

  if (state.connection !== "connected") {
    return (
      <div className="drive-tab">
        <h3 className="drive-tab__title">{t("googleDrive.title")}</h3>
        <NotConnected state={state} />
        <AccountFooter />
      </div>
    );
  }

  return (
    <div className="drive-tab">
      <div className="drive-tab__current">
        {state.current ? (
          <>
            <div className="drive-tab__current-name">{state.current.name}</div>
            <div className="drive-tab__current-status">
              <SyncStatusLine state={state} />
              <button
                type="button"
                className="drive-tab__link"
                onClick={() => driveSync.unlink()}
              >
                {t("googleDrive.actions.stopSyncing")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="drive-tab__text">{t("googleDrive.notLinked")}</p>
            <FilledButton
              fullWidth
              variant="outlined"
              status={state.busy ? "loading" : null}
              onClick={() => driveSync.createDrawing({ fromCanvas: true })}
            >
              {t("googleDrive.actions.saveCanvas")}
            </FilledButton>
          </>
        )}
      </div>

      {errorLine}

      <FilledButton
        fullWidth
        icon={PlusIcon}
        status={state.busy ? "loading" : null}
        onClick={() => driveSync.createDrawing({ fromCanvas: false })}
      >
        {t("googleDrive.actions.newDrawing")}
      </FilledButton>

      {state.drawings.length ? (
        <ul className="drive-tab__list">
          {state.drawings.map((drawing) => (
            <DrawingRow
              key={drawing.id}
              drawing={drawing}
              isCurrent={state.current?.fileId === drawing.id}
              disabled={state.busy}
            />
          ))}
        </ul>
      ) : (
        <p className="drive-tab__text">{t("googleDrive.list.empty")}</p>
      )}

      <AccountFooter />
    </div>
  );
};
