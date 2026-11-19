# Excalidraw auth server

Signs people in with Google, admits only accounts from one Google Workspace domain, and gives the app short-lived Google Drive tokens. It holds each user's refresh token, so the browser never sees one and never needs a Google popup.

## How requests flow

The reverse proxy serves everything from one domain and asks this server about each request before passing it on:

| Path            | Goes to                         | Gated by `/auth/check` |
| --------------- | ------------------------------- | ---------------------- |
| `/auth/*`       | this server                     | no                     |
| `/socket.io/*`  | `excalidraw-room` (live collab) | yes                    |
| everything else | the built app (static files)    | yes                    |

`GET /auth/check` answers `200` with an `X-Auth-Email` header for a signed-in user. For a signed-out page load (`GET` with `Accept: text/html`) it answers `401` with a small page whose script sends the browser to sign-in. A script is used because collab and share links keep their key in the URL `#fragment`, which never reaches a server. For anything else it answers a bare `401`. The proxy must pass these responses through to the browser. It reads the original method and path from `X-Forwarded-Method` and `X-Forwarded-Uri`.

Sessions last up to 30 days, or 7 days without use. Every hour the server re-checks each active session with Google, so a disabled or deleted account loses access within about an hour. If Google can't be reached, sessions keep working for up to 24 hours from their last successful check.

## Google Cloud setup (Workspace admin)

Do this in a Google Cloud project owned by your Workspace organization.

1. **Enable the APIs.** APIs & Services → Library → enable **Google Drive API** and **Google Picker API**.
2. **Make the app internal.** Google Auth Platform → Audience → user type **Internal**. Only accounts in your organization can then sign in, and Google doesn't review the app.
3. **Branding.** Set the app name and a support email. Add your domain under authorized domains.
4. **Data access.** Add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/drive.file`.
5. **Create the client.** Clients → Create client → **Web application**. Add the authorized redirect URI `https://<your-domain>/auth/callback`, and `http://localhost:3001/auth/callback` for local development. Copy the client ID and secret into the environment below.
6. **Create the picker key** (for "Open from Drive" and "Choose save folder"). APIs & Services → Credentials → Create credentials → **API key**. Restrict it to **Websites** `https://<your-domain>/*` (and `http://localhost:3001/*` for development) and to the **Google Picker API**. This key is sent to browsers by design, so those restrictions are what protect it. Also note the **project number** from IAM & Admin → Settings; it must be the project that owns the OAuth client.
7. **If your organization restricts third-party apps' access to Drive**, open the Admin console → Security → API controls → App access control and mark this client as **Trusted**.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes | Origin users open, e.g. `https://draw.example.com` |
| `GOOGLE_CLIENT_ID` | yes | From step 5 |
| `GOOGLE_CLIENT_SECRET` | yes | From step 5 |
| `ALLOWED_DOMAIN` | yes | Workspace domain, e.g. `example.com`, matched against Google's `hd` claim |
| `GOOGLE_PICKER_API_KEY` | no | From step 6. Without it the picker buttons are hidden |
| `GOOGLE_PROJECT_NUMBER` | no | From step 6. Set both picker variables or neither |
| `SESSION_SECRET` | yes | Random string of 32+ characters: `openssl rand -base64 48` |
| `DATA_DIR` | no | Where encrypted session files go. Default `./data` |
| `PORT` | no | Default `3015` |

Changing `SESSION_SECRET` signs everyone out.

Build the app with `VITE_APP_AUTH_ENABLED=true` so it shows the signed-in user and fetches Drive tokens from this server.

## Local development

```bash
cp server/.env.example server/.env   # then fill in the Google client
yarn --cwd server dev
```

In a second terminal:

```bash
VITE_APP_AUTH_ENABLED=true yarn start
```

The dev server proxies `/auth` to this server, so open `http://localhost:3001`.
