# Local PC Control Server

Standalone Node.js server for the PC that runs your OBS / FFmpeg encoder.

- **Multi-Event Manager** – web UI at <http://localhost:5000>: create, edit, delete, drag-reorder any number of event cards.
- **HLS Stream Forwarder** – `/live/<streamId>.m3u8` proxies your local encoder (playlists rewritten, segments streamed, Range + CORS + custom headers).
- **One-Click Cloud Sync** – upserts the cards into the `sportsevents` collection used by the Next.js app and keeps `isLocalServerActive` accurate via a heartbeat.

> Status: `server.js` passes `node --check`. The forwarder, sync and heartbeat have **not** been run end-to-end yet – do the smoke test below before going live.

## 1. Install

```bash
cd local-pc-server
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Requires Node.js 18.17+.

## 2. Configure `.env`

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Same database as the Next.js app's `MONGODB_URI` |
| `PUBLIC_STREAM_BASE_URL` | Public URL of this PC, e.g. `https://origin.example.com` (required to sync forwarded cards) |
| `LOCAL_NODE_ID` | Unique name of this PC (default: hostname) |
| `CLOUD_APP_URL` + `LOCAL_SERVER_SECRET` | Heartbeat via the app's `POST /api/sports/health-check`. The secret must equal `LOCAL_SERVER_SECRET` in the Next.js env. If empty, the heartbeat writes to MongoDB directly. |
| `PUBLIC_PORT` | Port to expose publicly (default 5001) |
| `ADMIN_UI_PASSWORD` | Optional Basic-auth for the admin UI |
| `STREAM_TOKEN_SECRET` | HMAC key for the short-lived `/live/*` stream tokens. Defaults to `LOCAL_SERVER_SECRET`; if neither is set a random key is generated per boot (tokens die on restart). Set a fixed long random value. |
| `STREAM_TOKEN_TTL_SEC` | Token lifetime in seconds (default 55, max 300). Every playlist response re-stamps fresh tokens on its children, so a playing client never expires mid-match. |
| `STREAM_GUARD_MODE` | `permissive` (default): token problems are logged as `[stream-guard:permissive]`, never blocked. `strict`: expired/invalid tokens on segments, sub-playlists and keys are denied with 403; foreign browser origins are flagged. Flip on after watching the logs on a real match day. |
| `ALLOWED_ORIGINS` | Extra comma-separated browser-origin hosts allowed to mint tokens and dial token-less entry playlists (in addition to localhost, `CLOUD_APP_URL` and `*.vercel.app`). |
| `SOURCES_FILE` | Where the live-source registry is stored on this PC (default `data/sources.json`). |
| `SOURCE_VAULT_SECRET` | Key used to AES-256-GCM encrypt Xtream passwords before they are mirrored to MongoDB (`hlsources.secret`). Defaults to `LOCAL_SERVER_SECRET`; with neither set, passwords are **not** written to Mongo at all. |

### Live sources

Sources (Xtream accounts, M3U/M3U8 feeds, direct HLS, OBS relays) are managed in the admin UI under the
**Live Source** stat card and stored in `SOURCES_FILE`. Each event card selects **one** source; a selection
is never global, and a card whose source is deactivated or removed keeps its assignment and simply refuses
to serve (`503 SOURCE_NOT_AVAILABLE`) until the source is available again. Provider passwords stay on this
PC: only `passwordSet` leaves the admin API, and the viewer-facing URL is always the forwarder path.

## 3. Run

```bash
npm start
```

Two listeners are started:

| Listener | Default | Serves | Expose to the internet? |
|---|---|---|---|
| Admin | `127.0.0.1:5000` | UI + API (+ forwarder for local tests) | **Never** |
| Public | `0.0.0.0:5001` | `/live/*`, `/healthz` only | Yes (via nginx / tunnel) |

## 4. Encoder + nginx

1. Install nginx with `nginx-rtmp-module` and use `nginx.conf` from this folder (adjust paths and the `$cors_origin` map).
2. OBS: server `rtmp://127.0.0.1/live`, stream key `match1`. Or FFmpeg:
   `ffmpeg -re -i input.mp4 -c:v libx264 -preset veryfast -g 60 -c:a aac -f flv rtmp://127.0.0.1/live/match1`
3. Local HLS appears at `http://127.0.0.1:8080/hls/match1.m3u8` – this is the **Primary HLS URL** you enter in the admin UI.
4. Publish `:8080` (or only `/live/`) through your domain or a tunnel such as Cloudflare Tunnel; set `PUBLIC_STREAM_BASE_URL` to that URL.

## 5. Daily workflow

1. Open <http://localhost:5000>, click **+ New event**, fill title, sport, times, encoder URL (keep *Publish through forwarder* ticked), optional backups.
2. **Check origins** – each card shows whether the encoder answered with a valid playlist.
3. Reorder by dragging (or ↑ / ↓). Order = display rank (`priorityOrder`).
4. **Sync to Cloud** – the Next.js app serves the cards at `GET /api/sports/events` within seconds.
5. Closing the server marks your cards offline (`isLocalServerActive=false`); a crash is detected by the heartbeat timeout (90 s by default).

Sync is idempotent (upsert by `<node>:<eventId>`). In mirror mode it deletes only cards **owned by this node** that no longer exist locally; cards from other PCs or created through the admin API are never touched.

## 6. Smoke test (do this first)

```bash
curl -i http://localhost:5001/healthz
curl -i http://localhost:5000/live/<streamId>.m3u8       # playlist with /live/<streamId>/... URIs
curl -i "http://localhost:5000/live/<streamId>/<segment>.ts" -H "Range: bytes=0-99"   # expect 206
```

Then, with real credentials in the Next.js app:

```bash
curl https://YOUR-APP/api/sports/health-check
curl https://YOUR-APP/api/sports/events
```

## Security notes

- The admin API rejects foreign `Host` headers, cross-origin writes and requests without `X-Admin-UI: 1` (blocks CSRF / DNS rebinding from web pages you visit).
- The forwarder only reads below the playlist's directory on the configured origin; `..` / encoded traversal is rejected, and private encoder addresses are rewritten out of playlists.
- Never commit `.env`. Rotate any secret that has been shared in chat or committed.
