# Running Excalidraw on your own server

This folder runs the whole app on one Linux server with Docker. Only accounts in your Google Workspace domain can open it, and every drawing, share link, collab room and image stays on that server or in each user's Google Drive.

| Service | Does |
| --- | --- |
| `caddy` | HTTPS (certificates from Let's Encrypt) and routing; asks `auth` before serving anything |
| `app` | The Excalidraw app, built with Excalidraw+ and AI features hidden |
| `auth` | Google sign-in, Drive tokens and storage (see [`server/README.md`](../server/README.md)) |
| `room` | `excalidraw-room`, which relays live collaboration between browsers |

## You need

- A Linux server with Docker and Docker Compose, with ports 80 and 443 open to your users.
- A domain name, such as `draw.example.com`, whose DNS points at the server. Caddy needs it to get a certificate.
- The Google Cloud setup from [`server/README.md`](../server/README.md#google-cloud-setup-workspace-admin), done by a Workspace admin. Use `https://<your domain>/auth/callback` as the redirect URI.

## Start it

```bash
cd deploy
cp .env.example .env
```

Fill in `.env`, then build and start everything:

```bash
docker compose up -d --build
```

The first build takes a few minutes. Open `https://<your domain>`: you should be sent to Google sign-in, and back to an empty canvas.

## Check it works

- Sign in with an account outside your domain: it should be refused.
- Open the sidebar's Drive tab: it should say "Signed in as" your account.
- Click **Live collaboration** and open the room link in a second browser signed in as a coworker: both should see each other's cursors.
- Use **Save to… → Export to Link** with an image on the canvas, then open the link as a coworker: the image should load.

## Data and backups

Everything the server stores is in the `auth_data` Docker volume: sessions plus encrypted share links, collab room snapshots and images. Drive drawings live in each user's Drive. Nothing is backed up, so losing the server's disk loses every share link and saved room. Users' Drive drawings are unaffected. To copy the volume elsewhere:

```bash
docker run --rm -v deploy_auth_data:/data -v "$PWD":/backup alpine tar czf /backup/auth_data.tgz -C /data .
```

Share links and rooms nobody opened for `RETENTION_DAYS` (default 180) are deleted automatically.

## Update

```bash
git pull
docker compose up -d --build
```

Changing `SESSION_SECRET` signs everyone out. Changing `DOMAIN` needs a matching redirect URI in Google Cloud.
