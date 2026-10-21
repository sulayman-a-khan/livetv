import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { parseM3uContent } from "@/lib/m3uParser";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { probeStreamUrl } from "@/lib/streamProbe";
import { probeEstablishesPlayability } from "@/lib/streamHealth";
import { canonicalChannelKey } from "@/lib/channelIdentity";
import { runMaintenance } from "@/lib/maintenanceRunner";
import { authorizeAdminRequest } from "@/lib/adminAuth";
import { checkPublicUrlSafety } from "@/lib/ssrfGuard";
import { safeFetch, UnsafeUrlError } from "@/lib/safeFetch";

export const dynamic = "force-dynamic";

/**
 * Vercel kills the function at this wall-clock limit. The import's own budget
 * below stays well under it, so a run always reaches its maintenance step
 * instead of being cut off with the catalogue half-imported.
 */
export const maxDuration = 60;

/**
 * How long the import may spend probing before it stops and reports. The
 * playlist download is capped separately, so the two budgets together stay
 * inside the wall-clock limit with room left for the maintenance sweep.
 */
const PROBE_BUDGET_MS = 30_000;

/** How long the playlist download may take before it is given up on. */
const PLAYLIST_FETCH_TIMEOUT_MS = 15_000;

/** The largest playlist this route will download. */
const MAX_PLAYLIST_BYTES = 10 * 1024 * 1024;

/**
 * Reads a response body, giving up as soon as it grows past the cap. The
 * declared `content-length` is checked by the caller first, so an oversized
 * download is refused before a single byte is read.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Streams ingestion progress back to the admin panel as Server-Sent Events so
 * the UI can show a live per-stream progress readout instead of a single
 * blocking spinner. Each `data:` frame is one JSON progress event.
 */
export async function POST(req: NextRequest) {
  // The credential is settled before the body is read: a request that presents
  // a wrong one is rejected without the server buffering the playlist it sent.
  // The cap is generous here because this route accepts a pasted playlist.
  const auth = await authorizeAdminRequest(req, { maxBodyBytes: 4 * 1024 * 1024 });
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status }
    );
  }
  const body = auth.body;

  const m3uTextInput: string = body.m3uText || "";
  const m3uUrl: string = body.m3uUrl || "";

  if (!m3uTextInput && !m3uUrl) {
    return NextResponse.json(
      { success: false, error: "Missing m3uText or m3uUrl in request body" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        let m3uText = m3uTextInput;

        if (m3uUrl) {
          // Refuse a playlist URL that names this machine, a private network or
          // the metadata endpoint before the server fetches it (lib/ssrfGuard.ts).
          const urlSafety = checkPublicUrlSafety(m3uUrl);
          if (!urlSafety.ok) {
            // No explicit controller.close() here: this path runs synchronously
            // at the top of start(), before the HTTP layer attaches a reader, and
            // the finally block below already closes the stream exactly once. A
            // second close() would error the stream and discard this very frame.
            send({ phase: "error", error: urlSafety.reason || "Playlist URL is not safe to fetch" });
            return;
          }
          send({ phase: "fetch", message: `Downloading playlist from ${m3uUrl}...` });
          const started = Date.now();
          let response: Response;
          try {
            // Redirects are walked by hand (lib/safeFetch.ts) so each hop is
            // checked: a playlist host may redirect into the server's own
            // network, and that hop must never be fetched.
            response = await safeFetch(m3uUrl, {
              headers: { "User-Agent": "SoluPlay/1.0" },
              signal: AbortSignal.timeout(PLAYLIST_FETCH_TIMEOUT_MS),
            });
          } catch (fetchError: any) {
            send({
              phase: "error",
              error:
                fetchError instanceof UnsafeUrlError
                  ? fetchError.message
                  : `Could not download the playlist: ${
                      fetchError?.name === "TimeoutError"
                        ? `the download did not finish within ${PLAYLIST_FETCH_TIMEOUT_MS / 1000}s`
                        : fetchError?.message || "the request failed"
                    }`,
            });
            controller.close();
            return;
          }
          if (!response.ok) {
            send({
              phase: "error",
              error: `Failed to fetch M3U URL: ${response.status} ${response.statusText}`,
            });
            controller.close();
            return;
          }

          // The declared size is checked before the body is read, and the read
          // itself stops at the cap, so one oversized playlist cannot fill the
          // function's memory.
          const declaredBytes = Number(response.headers.get("content-length") || "");
          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PLAYLIST_BYTES) {
            send({
              phase: "error",
              error: `The playlist is ${Math.round(declaredBytes / 1024 / 1024)} MB — larger than the ${
                MAX_PLAYLIST_BYTES / 1024 / 1024
              } MB limit.`,
            });
            controller.close();
            return;
          }
          const downloaded = await readCappedText(response, MAX_PLAYLIST_BYTES);
          if (downloaded === null) {
            send({
              phase: "error",
              error: `The playlist is larger than the ${MAX_PLAYLIST_BYTES / 1024 / 1024} MB limit.`,
            });
            controller.close();
            return;
          }
          m3uText = downloaded;
          const kb = Math.round(m3uText.length / 1024);
          send({
            phase: "fetch",
            message: `Downloaded ${kb} KB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          });
        }

        if (!m3uText || typeof m3uText !== "string") {
          send({ phase: "error", error: "Playlist is empty or not valid text." });
          controller.close();
          return;
        }

        send({ phase: "parse", message: "Parsing M3U entries..." });
        const parsedChannels = parseM3uContent(m3uText);
        const total = parsedChannels.length;
        send({
          phase: "parse",
          total,
          message: `Parsed ${total} stream ${total === 1 ? "entry" : "entries"}.`,
        });

        const conn = await connectToDatabase();
        send({
          phase: "mode",
          message: conn ? "Connected to MongoDB — probing streams..." : "In-memory mode — probing streams...",
        });

        let channelsCreated = 0;
        let channelsUpdated = 0;
        let activeLinksAdded = 0;
        let brokenLinksAdded = 0;
        let linksSkipped = 0;
        let index = 0;
        /** Entries left untouched because the run ran out of time. */
        let notProcessed = 0;
        /** Entries that raised an error of their own. */
        let failedItems = 0;
        /** How many entries the loop has taken in, successful or not. */
        let taken = 0;
        const deadline = Date.now() + PROBE_BUDGET_MS;

        const emitProbe = (name: string, status: string) => {
          index++;
          send({
            phase: "probe",
            index,
            total,
            name,
            status,
            percent: total > 0 ? Math.round((index / total) * 100) : 100,
          });
        };

        const outOfTime = () => Date.now() > deadline;

        /** Reports the budget stop and records how many entries are left. */
        const reportBudget = () => {
          notProcessed = Math.max(0, total - taken);
          send({
            phase: "budget",
            message: `Time budget reached — stopped after ${taken} of ${total} entries. Run the import again to continue.`,
          });
        };

        let importError: any = null;

        try {
          if (conn) {
            // MongoDB Mode
            for (const item of parsedChannels) {
              if (outOfTime()) {
                reportBudget();
                break;
              }
              taken++;
              try {
                // Identity is resolved through the canonical key, so "Bangla/TV" and
                // "bangla_tv" land on the same channel instead of creating two.
                // Everything discovered is imported, and nothing is pinned here:
                // an imported channel stays admin-only until the admin pins it.
                const canonicalKey = canonicalChannelKey(item.name);
                let channel = await Channel.findOne({ normalizedName: canonicalKey });
                if (!channel) {
                  channel = await Channel.create({
                    name: item.name,
                    normalizedName: canonicalKey,
                    logo: item.logo,
                    category: item.category,
                    isPinned: false,
                  });
                  channelsCreated++;
                } else if (!channel.logo && item.logo) {
                  channel.logo = item.logo;
                  await channel.save();
                  channelsUpdated++;
                }

                const existingLink = await StreamLink.findOne({
                  channelId: channel._id,
                  url: item.streamUrl,
                });

                if (!existingLink) {
                  const probe = await probeStreamUrl(item.streamUrl, 8000);
                  const working = probeEstablishesPlayability(probe);
                  const status = working ? "active" : "broken";
                  const existingCount = await StreamLink.countDocuments({ channelId: channel._id });

                  await StreamLink.create({
                    channelId: channel._id,
                    url: item.streamUrl,
                    priority: existingCount + 1,
                    status,
                    latency: probe.latency,
                    failedAttempts: working ? 0 : 1,
                    firstFailedAt: working ? null : new Date(),
                    browserBlocker: probe.browserBlocker,
                  });

                  if (working) activeLinksAdded++;
                  else brokenLinksAdded++;
                  emitProbe(item.name, status);
                } else {
                  linksSkipped++;
                  emitProbe(item.name, "skipped");
                }
              } catch (itemError: any) {
                // One bad entry must not end the import: it is counted and the
                // next entry is tried.
                failedItems++;
                console.error(`[ingest-m3u] "${item.name}" could not be imported:`, itemError);
                emitProbe(item.name, "error");
              }
            }
          } else {
            // In-Memory Mode
            const memoryChannels = inMemoryDb.getChannels();
            const memoryStreams = inMemoryDb.getStreams();

            for (const item of parsedChannels) {
              if (outOfTime()) {
                reportBudget();
                break;
              }
              taken++;
              try {
                const canonicalKey = canonicalChannelKey(item.name);
                let channel = memoryChannels.find(
                  (c) => c.normalizedName === canonicalKey || canonicalChannelKey(c.name) === canonicalKey
                );
                if (!channel) {
                  channel = {
                    _id: `ch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    name: item.name,
                    normalizedName: canonicalKey,
                    logo: item.logo,
                    category: item.category,
                    isPinned: false,
                    tags: [],
                    isManuallyEdited: false,
                    priorityOrder: 99,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  };
                  inMemoryDb.addChannel(channel);
                  channelsCreated++;
                } else if (!channel.logo && item.logo) {
                  channel.logo = item.logo;
                  channelsUpdated++;
                }

                const existingLink = memoryStreams.find(
                  (s) => s.channelId === channel!._id && s.url === item.streamUrl
                );

                if (!existingLink) {
                  const probe = await probeStreamUrl(item.streamUrl, 8000);
                  const working = probeEstablishesPlayability(probe);
                  const status = working ? "active" : "broken";
                  const chStreams = memoryStreams.filter((s) => s.channelId === channel!._id);

                  inMemoryDb.addStream({
                    _id: `str_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    channelId: channel._id,
                    url: item.streamUrl,
                    priority: chStreams.length + 1,
                    status,
                    failedAttempts: working ? 0 : 1,
                    firstFailedAt: working ? null : new Date(),
                    lastCheckedAt: new Date(),
                    latency: probe.latency || 120,
                    browserBlocker: probe.browserBlocker,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  });

                  if (working) activeLinksAdded++;
                  else brokenLinksAdded++;
                  emitProbe(item.name, status);
                } else {
                  linksSkipped++;
                  emitProbe(item.name, "skipped");
                }
              } catch (itemError: any) {
                failedItems++;
                console.error(`[ingest-m3u] "${item.name}" could not be imported:`, itemError);
                emitProbe(item.name, "error");
              }
            }
          }
        } catch (error: any) {
          importError = error;
        }

        // Enforce every catalogue invariant on the freshly imported data:
        // merge duplicates, purge test links, fastest server first. This runs
        // even when the import itself failed, so a partial import never leaves
        // the catalogue unmerged.
        send({ phase: "maintenance", message: "Running catalogue cleanup & merge..." });
        let maintenance: any = null;
        try {
          maintenance = await runMaintenance();
        } catch (maintenanceError: any) {
          console.error("POST /api/admin/ingest-m3u maintenance error:", maintenanceError);
          if (!importError) importError = maintenanceError;
        }

        if (importError) {
          console.error("POST /api/admin/ingest-m3u error:", importError);
          send({
            phase: "error",
            error: importError?.message || "Failed to ingest M3U playlist",
          });
          return;
        }

        const summary = {
          totalParsed: total,
          channelsCreated,
          channelsUpdated,
          activeLinksAdded,
          brokenLinksAdded,
          linksSkipped,
          notProcessed,
          failedItems,
        };

        send({ phase: "done", summary, maintenance });
      } catch (error: any) {
        console.error("POST /api/admin/ingest-m3u error:", error);
        send({ phase: "error", error: error?.message || "Failed to ingest M3U playlist" });
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
