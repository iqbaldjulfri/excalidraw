import { SignedOutError, isAuthEnabled } from "../session";

/** The user unticked Drive on Google's consent screen. */
export class DriveNotGrantedError extends Error {
  constructor() {
    super("Drive access not granted");
    this.name = "DriveNotGrantedError";
  }
}

// the server refreshes tokens with under 2 minutes left; ask a bit before that
const EXPIRY_MARGIN_MS = 60 * 1000;

type DriveToken = { accessToken: string; expiresAt: number };

let cachedToken: DriveToken | null = null;
let pendingToken: Promise<DriveToken> | null = null;

export const isGoogleDriveEnabled = isAuthEnabled;

const fetchDriveToken = async (forceRefresh: boolean): Promise<DriveToken> => {
  const response = await fetch(
    forceRefresh ? "/auth/drive-token?refresh=1" : "/auth/drive-token",
    { credentials: "same-origin" },
  );
  if (response.status === 401) {
    throw new SignedOutError();
  }
  if (response.status === 403) {
    throw new DriveNotGrantedError();
  }
  if (!response.ok) {
    throw new Error(`Couldn't get a Google Drive token (${response.status})`);
  }
  return response.json();
};

/**
 * Tokens come from the auth server, which holds the refresh token.
 * `forceRefresh` is for a token Drive just rejected, e.g. after the user
 * revoked access at Google: the server would otherwise return it again.
 */
export const getDriveAccessToken = async (
  opts: { forceRefresh?: boolean } = {},
): Promise<string> => {
  if (
    !opts.forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return cachedToken.accessToken;
  }
  if (!pendingToken) {
    pendingToken = fetchDriveToken(!!opts.forceRefresh)
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        pendingToken = null;
      });
  }
  return (await pendingToken).accessToken;
};
