import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/adminAuth";
import { loadSourceById } from "@/lib/playlistSources";
import { syncPlaylistSource, type PlaylistSyncEvent } from "@/lib/playlistSync";

export const dynamic = "force-dynamic";

/**
 * Vercel kills the function at this wall-clock limit. Declared here because the
 * playlist download alone may take 20s (`FETCH_TIMEOUT_MS` in lib/playlistSync),
 * which is longer than the platform default — without it a "Check now" could be
 * cut off before the playlist is even parsed. A run that still reaches the limit
 * is resumable: every write is keyed on (source, URL), so checking again
 * continues from what landed instead of duplicating it.
 */
export const maxDuration = 60;

/**
 * POST /api/admin/playlist-sources/[id]/sync
 * Runs one source's check immediately and streams progress back as Server-Sent
 * Events, the same way the M3U ingest console reports a long import. A playlist
 * can carry hundreds of streams, so a plain request/response would sit behind a
 * spinner for minutes and risk being cut off.
 *
 * Body: `{ secretKey, force? }` — `force` skips the "playlist is byte-identical"
 * short-circuit and re-checks everything.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorizeAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status }
    );
  }
  const body = auth.body;

  let source;
  try {
    source = await loadSourceById(params.id);
  } catch (error: any) {
    const status = typeof error?.status === "number" ? error.status : 500;
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load playlist source" },
      { status }
    );
  }

  if (!source) {
    return NextResponse.json({ success: false, error: "Unknown playlist source" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PlaylistSyncEvent | Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The admin closed the dashboard mid-run; the sync keeps its state in
          // MongoDB either way, so the next check resumes from what was written.
        }
      };

      try {
        await syncPlaylistSource(String(source._id), {
          force: Boolean(body.force),
          onEvent: (evt) => send(evt),
        });
      } catch (error: any) {
        console.error("POST /api/admin/playlist-sources/[id]/sync error:", error);
        send({ phase: "error", error: error?.message || "Playlist sync failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
