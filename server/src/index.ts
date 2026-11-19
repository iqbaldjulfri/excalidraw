import { createServer } from "node:http";

import { createAuthApp } from "./app";
import { loadConfig } from "./config";
import { GoogleOAuth } from "./google";
import { FileSessionStore } from "./sessions";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const config = loadConfig();
const sessions = new FileSessionStore(config.dataDir, config.encryptionKey);
const google = new GoogleOAuth({
  clientId: config.googleClientId,
  clientSecret: config.googleClientSecret,
  redirectUri: new URL("/auth/callback", config.publicUrl).toString(),
  allowedDomain: config.allowedDomain,
});

const cleanUp = () =>
  sessions
    .deleteExpired({
      now: Date.now(),
      maxAgeMs: config.sessionMaxAgeMs,
      idleMs: config.sessionIdleMs,
    })
    .catch((error) => console.error("Session cleanup failed", error));

cleanUp();
setInterval(cleanUp, CLEANUP_INTERVAL_MS).unref();

createServer(createAuthApp({ config, google, sessions })).listen(
  config.port,
  () => {
    console.info(
      `Excalidraw auth server on :${config.port} for ${config.publicUrl.origin}`,
    );
  },
);
