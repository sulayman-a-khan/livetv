/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts up.
 * Used to auto-start the background health checker.
 */

export async function register() {
  // Only run on the server (Node.js runtime), not in Edge or during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoHealthChecker } = await import("@/lib/autoHealthChecker");
    startAutoHealthChecker();
  }
}
