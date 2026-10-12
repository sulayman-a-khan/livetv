/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts up.
 *
 * Starts the playlist monitor's in-process timers. Health checking is not
 * started here: it runs exclusively through the GitHub Actions pass, which
 * drives `POST /api/admin/health-check` in bounded batches.
 */

export async function register() {
  // Only run on the server (Node.js runtime), not in Edge or during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPlaylistMonitor } = await import("@/lib/playlistMonitor");
    startPlaylistMonitor();
  }
}
