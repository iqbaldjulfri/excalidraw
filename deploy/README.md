# Running Excalidraw on your own server

This folder runs the whole app on one Linux server with Docker. Only accounts in your Google Workspace domain can open it, and every drawing, share link, collab room and image stays on that server or in each user's Google Drive. The one exception is the shape library: browsing and publishing libraries use Excalidraw's public library site.

| Service | Does |
| --- | --- |
| `cloudflared` | Connects out to Cloudflare, which serves HTTPS and forwards requests through the tunnel |
| `caddy` | Routing; asks `auth` before serving anything |
| `app` | The Excalidraw app, built with Excalidraw+ and AI features hidden |
| `auth` | Google sign-in, Drive tokens and storage (see [`server/README.md`](../server/README.md)) |
| `room` | `excalidraw-room`, which relays live collaboration between browsers. Built from source by [`room.Dockerfile`](room.Dockerfile), because the published image runs only on amd64 |

## You need

- A Linux server with Docker and Docker Compose, amd64 or arm64 (such as EC2 Graviton). It needs outbound internet access but no inbound ports: close 80 and 443 in its firewall or security group.
- A domain on Cloudflare and a Cloudflare Tunnel for it, set up as below.
- The Google Cloud setup from [`server/README.md`](../server/README.md#google-cloud-setup-workspace-admin), done by a Workspace admin. Use `https://<your domain>/auth/callback` as the redirect URI.

## Cloudflare Tunnel setup

1. In the Cloudflare dashboard, go to **Networking > Tunnels** and create a tunnel.
2. Open the tunnel, select **Add a replica**, and copy the install command without running it. The token is the `eyJ...` string in it. Put it in `.env` as `TUNNEL_TOKEN`.
3. Under **Routes**, add a **Published application**: your hostname (such as `draw.example.com`) with service URL `http://caddy:80`. Cloudflare creates the DNS record.

`DOMAIN` in `.env` must match that hostname.

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

Changing `SESSION_SECRET` signs everyone out. Changing `DOMAIN` needs a matching tunnel route and a matching redirect URI in Google Cloud.

The collab server is pinned to an upstream commit by `ROOM_COMMIT` in [`room.Dockerfile`](room.Dockerfile). Change that line to update it.
