import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { parseM3uContent } from "@/lib/m3uParser";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { probeStreamUrl } from "@/lib/streamProbe";
import { canonicalChannelKey } from "@/lib/channelIdentity";
import { runMaintenance } from "@/lib/maintenanceRunner";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

/**
 * Streams ingestion progress back to the admin panel as Server-Sent Events so
 * the UI can show a live per-stream progress readout instead of a single
 * blocking spinner. Each `data:` frame is one JSON progress event.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  if (!isAuthorizedAdmin(req, body.secretKey)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
      { status: 401 }
    );
  }

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
          send({ phase: "fetch", message: `Downloading playlist from ${m3uUrl}...` });
          const started = Date.now();
          const response = await fetch(m3uUrl, {
            headers: { "User-Agent": "SoluPlay/1.0" },
          });
          if (!response.ok) {
            send({
              phase: "error",
              error: `Failed to fetch M3U URL: ${response.status} ${response.statusText}`,
            });
            controller.close();
            return;
          }
          m3uText = await response.text();
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

        if (conn) {
          // MongoDB Mode
          for (const item of parsedChannels) {
            // Identity is resolved through the canonical key, so "Bangla/TV" and
            // "bangla_tv" land on the same channel instead of creating two.
            const canonicalKey = canonicalChannelKey(item.name);
            let channel = await Channel.findOne({ normalizedName: canonicalKey });
            if (!channel) {
              channel = await Channel.create({
                name: item.name,
                normalizedName: canonicalKey,
                logo: item.logo,
                category: item.category,
                subCategory: item.subCategory,
                country: item.country,
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
              const status = probe.ok ? "active" : "broken";
              const existingCount = await StreamLink.countDocuments({ channelId: channel._id });

              await StreamLink.create({
                channelId: channel._id,
                url: item.streamUrl,
                priority: existingCount + 1,
                status,
                latency: probe.latency,
                failedAttempts: probe.ok ? 0 : 1,
                firstFailedAt: probe.ok ? null : new Date(),
              });

              if (probe.ok) activeLinksAdded++;
              else brokenLinksAdded++;
              emitProbe(item.name, status);
            } else {
              linksSkipped++;
              emitProbe(item.name, "skipped");
            }
          }
        } else {
          // In-Memory Mode
          const memoryChannels = inMemoryDb.getChannels();
          const memoryStreams = inMemoryDb.getStreams();

          for (const item of parsedChannels) {
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
                subCategory: item.subCategory,
                country: item.country,
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
              const status = probe.ok ? "active" : "broken";
              const chStreams = memoryStreams.filter((s) => s.channelId === channel!._id);

              inMemoryDb.addStream({
                _id: `str_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                channelId: channel._id,
                url: item.streamUrl,
                priority: chStreams.length + 1,
                status,
                failedAttempts: probe.ok ? 0 : 1,
                firstFailedAt: probe.ok ? null : new Date(),
                lastCheckedAt: new Date(),
                latency: probe.latency || 120,
                createdAt: new Date(),
                updatedAt: new Date(),
              });

              if (probe.ok) activeLinksAdded++;
              else brokenLinksAdded++;
              emitProbe(item.name, status);
            } else {
              linksSkipped++;
              emitProbe(item.name, "skipped");
            }
          }
        }

        // Enforce every catalogue invariant on the freshly imported data:
        // merge duplicates, purge test links, fastest server first.
        send({ phase: "maintenance", message: "Running catalogue cleanup & merge..." });
        const maintenance = await runMaintenance();

        const summary = {
          totalParsed: total,
          channelsCreated,
          channelsUpdated,
          activeLinksAdded,
          brokenLinksAdded,
          linksSkipped,
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
