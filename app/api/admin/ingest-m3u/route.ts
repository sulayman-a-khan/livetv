import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { parseM3uContent } from "@/lib/m3uParser";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { probeStreamUrl } from "@/lib/streamProbe";
import { canonicalChannelKey } from "@/lib/channelIdentity";
import { runMaintenance } from "@/lib/maintenanceRunner";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("x-admin-secret");
    const body = await req.json().catch(() => ({}));
    const rawSecret = authHeader || body.secretKey || "";
    const secretKey = rawSecret.trim();

    const expectedSecret = (process.env.ADMIN_SECRET_KEY || "supersecret123").trim();

    if (!secretKey || secretKey !== expectedSecret) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    let m3uText = body.m3uText || "";
    const m3uUrl = body.m3uUrl || "";

    if (m3uUrl) {
      const response = await fetch(m3uUrl, { headers: { "User-Agent": "FreeTV/1.0" } });
      if (!response.ok) {
        return NextResponse.json(
          { success: false, error: `Failed to fetch M3U URL: ${response.statusText}` },
          { status: 400 }
        );
      }
      m3uText = await response.text();
    }

    if (!m3uText || typeof m3uText !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing m3uText or m3uUrl in request body" },
        { status: 400 }
      );
    }

    const conn = await connectToDatabase();
    const parsedChannels = parseM3uContent(m3uText);
    let channelsCreated = 0;
    let channelsUpdated = 0;
    let activeLinksAdded = 0;
    let brokenLinksAdded = 0;
    let linksSkipped = 0;

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
          const probe = await probeStreamUrl(item.streamUrl, 4000);
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
        } else {
          linksSkipped++;
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
          const probe = await probeStreamUrl(item.streamUrl, 4000);
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
        } else {
          linksSkipped++;
        }
      }
    }

    // Enforce every catalogue invariant on the freshly imported data:
    // merge duplicates, purge test links, fastest server first.
    const maintenance = await runMaintenance();

    return NextResponse.json({
      success: true,
      maintenance,
      summary: {
        totalParsed: parsedChannels.length,
        channelsCreated,
        channelsUpdated,
        activeLinksAdded,
        brokenLinksAdded,
        linksSkipped,
      },
    });
  } catch (error: any) {
    console.error("POST /api/admin/ingest-m3u error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to ingest M3U playlist" },
      { status: 500 }
    );
  }
}
