# FreeTV - Automated Production Live TV Streaming Platform

FreeTV is a Production-Grade Automated Live Streaming Web Platform built with Next.js 14+ (App Router), Tailwind CSS, MongoDB (Mongoose), HLS.js with 5-Second Smart Auto-Failover, Hidden Admin Gate M3U parser, and a GitHub Actions health-check pass with a 72-hour auto-cleaner.

---

## Key Features

1. **Cricfy / Sportsfy Inspired Modern UI**:
   - Dark mode glassmorphism UI with live badges, country flags, active stream counts, and category pills.
   - Filters for **Live Sports (Cricket, Football, Others)**, **Bangladesh**, **India**, **Pakistan**, **News**, and **Entertainment**.

2. **Smart 5-Second Auto-Failover HLS Player**:
   - Built with `hls.js`.
   - Automatically detects stream buffering or stalls. If buffering exceeds **5 seconds**, it instantly fails over to the next available backup mirror link for that channel.
   - Toast UI alert notifies the user of automated failovers.
   - Stream mirror pills allow manual stream switching with latency indicators.

3. **Database Architecture (MongoDB + Mongoose)**:
   - `Channel`: `name`, `normalizedName` (unique indexed), `logo`, `category`, `subCategory`, `country`.
   - `StreamLink`: `channelId` (ref), `url`, `priority`, `status` ('active'/'degraded'/'broken'), `failedAttempts`, `firstFailedAt`, `latency`, `lastCheckedAt`.

4. **Hidden Admin Gate & M3U Ingestion (`/admin-secret-gate`)**:
   - Secured by the `ADMIN_SECRET_KEY` env variable. There is no built-in default: with the variable unset, every admin route rejects the request. Never commit a real secret here — this repository is public.
   - M3U parser deduplicates channels by normalized name and maps multiple stream URLs as backup mirrors.
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
- Local MongoDB running at `mongodb://127.0.0.1:27017/freetv` (or a MongoDB Atlas connection URI)

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

### Step 3: Seed Sample Live Channels & Working Streams
Populate the database with sample Sports (Cricket/Football), News, and Regional channels across Bangladesh, India, and Pakistan:
```bash
npm run seed
```

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
5. Click **Run Health Check (30 Batch)** to trigger instant background health checks.
