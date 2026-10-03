import { NextRequest } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import SportsEvent from "@/models/SportsEvent";
import {
  sportsJson,
  sportsPreflight,
  readJsonBody,
  isAuthorizedLocalServer,
  heartbeatTtlMs,
} from "@/lib/sportsApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const OWNED_BY_NODE = { sourceNode: { $exists: true, $ne: null } };
const MAX_REPORTED_IDS = 500;

export async function OPTIONS(req: NextRequest) {
  return sportsPreflight(req);
}

/**
 * GET /api/sports/health-check
 * Public ping. Reports whether this app + its database are up and whether a
 * local PC server has checked in recently.
 *
 *   200 -> app and database are healthy
 *   503 -> database unreachable (the events API cannot serve cards)
 *
 * Side effect: cards whose PC heartbeat went stale are flipped to
 * isLocalServerActive=false so anything reading the collection directly
 * sees the same truth as the API. The update is idempotent and cheap.
 */
export async function GET(req: NextRequest) {
  const serverTime = new Date().toISOString();
  try {
    const conn = await connectToDatabase();
    if (!conn) {
      return sportsJson(
        req,
        { success: false, status: "degraded", database: "unavailable", serverTime },
        { status: 503 }
      );
    }

    const ttlMs = heartbeatTtlMs();
    const cutoff = new Date(Date.now() - ttlMs);

    try {
      await SportsEvent.updateMany(
        { ...OWNED_BY_NODE, isLocalServerActive: true, lastHeartbeatAt: { $lt: cutoff } },
        { $set: { isLocalServerActive: false } }
      );
    } catch (sweepError) {
      console.error("health-check stale sweep failed:", sweepError);
    }

    const [totalEvents, activeEvents, latest] = await Promise.all([
      SportsEvent.countDocuments(OWNED_BY_NODE),
      SportsEvent.countDocuments({ ...OWNED_BY_NODE, isLocalServerActive: true, lastHeartbeatAt: { $gte: cutoff } }),
      SportsEvent.findOne({ ...OWNED_BY_NODE, lastHeartbeatAt: { $ne: null } })
        .sort({ lastHeartbeatAt: -1 })
        .select("lastHeartbeatAt")
        .lean(),
    ]);

    return sportsJson(req, {
      success: true,
      status: "ok",
      database: "connected",
      serverTime,
      localServer: {
        online: activeEvents > 0,
        activeEvents,
        totalEvents,
        lastHeartbeatAt: latest?.lastHeartbeatAt ? new Date(latest.lastHeartbeatAt).toISOString() : null,
        ttlSeconds: Math.round(ttlMs / 1000),
      },
    });
  } catch (error) {
    console.error("GET /api/sports/health-check error:", error);
    return sportsJson(req, { success: false, status: "error", serverTime }, { status: 500 });
  }
}

/**
 * POST /api/sports/health-check
 * Heartbeat from the local PC server.
 *
 * Auth: `X-Local-Server-Secret: <LOCAL_SERVER_SECRET>` (or the admin secret).
 * Body: {
 *   sourceNode: string,               // the PC's LOCAL_NODE_ID (required)
 *   active?: boolean,                 // default true; false = "going offline" (clean shutdown)
 *   onlineExternalIds?: string[]      // events whose encoder/origin is reachable right now.
 *                                     // Omitted = every event of the node is online.
 * }
 *
 * Marks all of the node's cards with the new lastHeartbeatAt and sets each card's
 * isLocalServerActive in ONE atomic update (no flicker between "off" and "on").
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req);

    const allowed =
      isAuthorizedLocalServer(req) || isAuthorizedAdmin(req, typeof body?.secretKey === "string" ? body.secretKey : undefined);
    if (!allowed) {
      return sportsJson(req, { success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!body) return sportsJson(req, { success: false, error: "Request body must be a JSON object" }, { status: 400 });

    const sourceNode = typeof body.sourceNode === "string" ? body.sourceNode.trim() : "";
    if (!sourceNode || sourceNode.length > 100) {
      return sportsJson(req, { success: false, error: "sourceNode is required (max 100 chars)" }, { status: 400 });
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      return sportsJson(req, { success: false, error: "active must be a boolean" }, { status: 400 });
    }
    const active = body.active !== false;

    let onlineIds: string[] | null = null;
    if (body.onlineExternalIds !== undefined) {
      const ids = body.onlineExternalIds;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_REPORTED_IDS ||
        !ids.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)
      ) {
        return sportsJson(
          req,
          { success: false, error: `onlineExternalIds must be an array of up to ${MAX_REPORTED_IDS} id strings` },
          { status: 400 }
        );
      }
      onlineIds = ids as string[];
    }

    const conn = await connectToDatabase();
    if (!conn) return sportsJson(req, { success: false, error: "Database unavailable" }, { status: 503 });

    const now = new Date();
    let result;

    if (!active) {
      // Clean shutdown: everything goes offline immediately.
      result = await SportsEvent.updateMany({ sourceNode }, { $set: { isLocalServerActive: false } });
    } else {
      // Aggregation-pipeline update through the native driver so the per-card flag is
      // computed server-side in a single atomic operation. $literal guards against
      // ids that happen to start with "$" being read as field paths.
      result = await SportsEvent.collection.updateMany({ sourceNode }, [
        {
          $set: {
            lastHeartbeatAt: now,
            isLocalServerActive: onlineIds === null ? true : { $in: ["$externalId", { $literal: onlineIds }] },
          },
        },
      ]);
    }

    return sportsJson(req, {
      success: true,
      sourceNode,
      active,
      matched: "matchedCount" in result ? result.matchedCount : 0,
      modified: "modifiedCount" in result ? result.modifiedCount : 0,
      serverTime: now.toISOString(),
    });
  } catch (error) {
    console.error("POST /api/sports/health-check error:", error);
    return sportsJson(req, { success: false, error: "Internal server error" }, { status: 500 });
  }
}
