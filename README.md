# FreeTV - Automated Production Live TV Streaming Platform

FreeTV is a Production-Grade Automated Live Streaming Web Platform built with Next.js 14+ (App Router), Tailwind CSS, MongoDB (Mongoose), HLS.js with 5-Second Smart Auto-Failover, Hidden Admin Gate M3U parser, and a GitHub Actions health-check pass with a 72-hour auto-cleaner.

---

## Key Features

1. **Cricfy / Sportsfy Inspired Modern UI**:
   - Dark mode glassmorphism UI with live badges, category badge flags, active stream counts, and category pills.
   - Category rails for **Sports**, **Bangla**, **Indian**, **Pakistani**, and **Documentary** (defined once in `lib/categories.ts`).

2. **Smart 5-Second Auto-Failover HLS Player**:
   - Built with `hls.js`.
   - Automatically detects stream buffering or stalls. If buffering exceeds **5 seconds**, it instantly fails over to the next available backup mirror link for that channel.
   - Toast UI alert notifies the user of automated failovers.
   - Stream mirror pills allow manual stream switching with latency indicators.

3. **Database Architecture (MongoDB + Mongoose)**:
   - `Channel`: `name`, `normalizedName` (unique indexed; holds the `canonicalChannelKey` identity key), `logo`, `category` (one of the five in `lib/categories.ts`), `isPinned`, `priorityOrder`, `tags`, `isManuallyEdited`.
   - `StreamLink`: `channelId` (ref), `url`, `priority`, `status` ('active'/'degraded'/'broken'), `failedAttempts`, `firstFailedAt`, `lastCheckedAt`, `latency`, plus the health bookkeeping `lastCountedFailureDay`, `browserBlocker`, `deliveryMisses`, `lastDeliveryMissAt`, `deliveryHidden`, `manual`, `adminDisabled`. The `headers` and `lastCheck` fields are server-side only and are never published to the public API.

4. **Hidden Admin Gate & M3U Ingestion (`/admin-secret-gate`)**:
   - Secured by the `ADMIN_SECRET_KEY` env variable. There is no built-in default: with the variable unset, every admin route rejects the request. Never commit a real secret here — this repository is public.
   - M3U parser deduplicates channels by their `canonicalChannelKey` identity key and maps multiple stream URLs as backup mirrors.
   - Dashboard with live channel stats and manual health check execution button.

5. **Automated Health Checks & 72-Hour Auto-Cleaner (GitHub Actions)**:
   - `.github/workflows/soluplay-health-check.yml`: a scheduled pass (every 4 hours when the repo variable `SOLUPLAY_HEALTH_CHECK_SCHEDULE_ENABLED` is `true`, plus manual dispatch) drives `POST /api/admin/health-check` in bounded batches of 12 via `scripts/health-check-runner.mjs`. There is no local background worker.
   - Hide rule: a link is hidden after **3 day-gated failed daily checks**; Auto-Cleaner rule: a link is permanently purged from `StreamLink` only after **72 continuous hours** down, and never when it is manual or admin-disabled.
   - Frontend API strictly filters out dead channels so zero broken streams are served to public users.

6. **Future Ad Monetization (`AdManager`)**:
   - Modular configuration (`NEXT_PUBLIC_ENABLE_ADS=false`).
   - 24-hour frequency capping enforced via `localStorage` timestamp tracking.

---

## Step-by-Step Instructions to Run on Localhost

### Prerequisites
- Node.js 18+ installed
- Local MongoDB at `mongodb://127.0.0.1:27017/freetv` (or a MongoDB Atlas connection URI) — optional; with `MONGODB_URI` unset the app uses the local JSON store instead.

### Step 1: Clone & Configure Environment
Copy the committed template and fill in your own values (`.env.local` is gitignored, never committed):
```bash
cp .env.example .env.local
```
`.env.example` holds placeholders only — no secret value is stored in this repository.
The variables it documents:
```bash
MONGODB_URI=mongodb://127.0.0.1:27017/freetv   # or a MongoDB Atlas URI
# Generate your own: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ADMIN_SECRET_KEY=
CRON_SECRET=
YOUTUBE_API_KEY=
NEXT_PUBLIC_ENABLE_ADS=false
```
With `ADMIN_SECRET_KEY` empty, every `/api/admin/*` route answers 401 and the admin gate stays locked.

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Get a Local Channel Catalogue
MongoDB is optional locally: with `MONGODB_URI` unset the app falls back to a local JSON store at `data/store.json`. Fill it by ingesting an M3U playlist through `/admin-secret-gate` — or capture the live catalogue read-only into a temporary snapshot:

```bash
npm run snapshot:production   # writes data/prod-snapshot.json (git-ignored, public fields only)
npm run dev:snapshot          # runs `next dev` against that snapshot instead of data/store.json
```

`dev:snapshot` never contacts MongoDB, never writes `data/store.json`, and writes only to `data/store.snapshot.json`. Both snapshot files are git-ignored and are never picked up by a production build.

### Step 4: Start Next.js Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Hidden Admin Gate & M3U Ingestion

1. Navigate to `http://localhost:3000/admin-secret-gate`.
2. Enter the Admin Secret Key — the value you set as `ADMIN_SECRET_KEY`. It is not stored in this repository.
3. Paste an M3U Playlist URL or raw M3U text content.
4. Click **Ingest M3U Stream Links** to automatically deduplicate channels and attach backup mirrors.
5. Click **Run Health Check (All Pinned)** to trigger instant background health checks.
