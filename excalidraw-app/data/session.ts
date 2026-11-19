import { useEffect } from "react";

import { atom, appJotaiStore, useAtomValue } from "../app-jotai";

export type CurrentUser = {
  email: string;
  name: string;
  picture: string | null;
  driveAccess: boolean;
};

/** The auth server's session is gone; only a new sign-in fixes it. */
export class SignedOutError extends Error {
  constructor() {
    super("Signed out");
    this.name = "SignedOutError";
  }
}

export const isAuthEnabled = () =>
  import.meta.env.VITE_APP_AUTH_ENABLED === "true";

export const currentUserAtom = atom<CurrentUser | null>(null);

export const signInUrl = () =>
  `/auth/login?${new URLSearchParams({
    returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  })}`;

export const fetchCurrentUser = async (): Promise<CurrentUser> => {
  const response = await fetch("/auth/me", { credentials: "same-origin" });
  if (response.status === 401) {
    throw new SignedOutError();
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the signed-in user (${response.status})`);
  }
  return response.json();
};

export const signOut = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.assign("/auth/signed-out");
};

/**
 * Loads the signed-in user. In production the reverse proxy already blocks
 * signed-out visitors; this covers the dev server, which has no proxy.
 */
export const useCurrentUser = () => {
  useEffect(() => {
    if (!isAuthEnabled()) {
      return;
    }
    fetchCurrentUser().then(
      (user) => appJotaiStore.set(currentUserAtom, user),
      (error) => {
        if (error instanceof SignedOutError) {
          window.location.assign(signInUrl());
        } else {
          console.error(error);
        }
      },
    );
  }, []);
  return useAtomValue(currentUserAtom);
};
