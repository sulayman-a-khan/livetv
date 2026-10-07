import { NextRequest } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import SportsEvent from "@/models/SportsEvent";
import {
  sportsJson,
  sportsPreflight,
  parseEventPayload,
  readJsonBody,
  serializeEvent,
  escapeRegex,
} from "@/lib/sportsApi";
import { getDynamicStreamBaseUrl } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const NO_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
};

const UNAUTHORIZED = { success: false, error: "Unauthorized: Invalid Admin Secret Key" };
const DB_DOWN = { success: false, error: "Database unavailable" };

/** Maps Mongoose validation / cast errors to a 400, everything else to a 500. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function failure(req: NextRequest, label: string, error: any) {
  if (error?.name === "ValidationError" && error.errors) {
    const errors = Object.values(error.errors).map((e) => (e as { message: string }).message);
    return sportsJson(req, { success: false, error: "Validation failed", errors }, { status: 400, headers: NO_CACHE_HEADERS });
  }
  if (error?.code === 11000) {
    return sportsJson(req, { success: false, error: "Duplicate event" }, { status: 409, headers: NO_CACHE_HEADERS });
  }
  console.error(`${label} error:`, error);
  return sportsJson(req, { success: false, error: "Internal server error" }, { status: 500, headers: NO_CACHE_HEADERS });
}

/** Preflight for cross-origin admin panels / players. */
export async function OPTIONS(req: NextRequest) {
  return sportsPreflight(req);
}

/**
 * GET /api/sports/events
 * Public. Returns active (live) and scheduled event cards, sorted by
 * priorityOrder ascending, then startTime ascending.
 *
 * Query params:
 *   sportType    exact (case-insensitive) sport filter, e.g. ?sportType=Cricket
 *   limit        1..200 (default 50)
 *   includeEnded true -> also return ended cards (requires admin secret)
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const includeEnded = sp.get("includeEnded") === "true";

    if (includeEnded && !isAuthorizedAdmin(req)) {
      return sportsJson(req, UNAUTHORIZED, { status: 401, headers: NO_CACHE_HEADERS });
    }

    const conn = await connectToDatabase();
    const now = Date.now();

    if (!conn) {
      // On Vercel: return a clear 503 so the issue is visible, not masked
      if (process.env.VERCEL) {
        return sportsJson(
          req,
          {
            success: false,
            error: "Database temporarily unavailable – retrying shortly",
            serverTime: new Date(now).toISOString(),
            events: [],
            data: [],
            matches: [],
            items: [],
          },
          { status: 503, headers: NO_CACHE_HEADERS }
        );
      }
      // Local dev: graceful empty fallback (in-memory store handles channels)
      return sportsJson(
        req,
        {
          success: true,
          count: 0,
          serverTime: new Date(now).toISOString(),
          events: [],
          data: [],
          matches: [],
          items: [],
        },
        {
          headers: NO_CACHE_HEADERS,
        }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {};
    if (!includeEnded) {
      // Exclude only explicitly ended or cancelled events; allow scheduled, live, upcoming, active
      filter.status = { $nin: ["ended", "completed", "cancelled"] };
    }
    const sportType = (sp.get("sportType") || "").trim();
    if (sportType) filter.sportType = new RegExp(`^${escapeRegex(sportType)}$`, "i");

    const limitRaw = parseInt(sp.get("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;

    // 1. Primary query on SportsEvent model (mapped to "sportsevents" collection)
    let docs = await SportsEvent.find(filter).sort({ priorityOrder: 1, startTime: 1, _id: 1 }).limit(limit).lean();

    // 2. Resilient multi-collection fallback: check "events" or "matches" if sportsevents is empty
    if ((!docs || docs.length === 0) && conn.connection && conn.connection.db) {
      const fallbackCollections = ["events", "matches", "sports"];
      for (const collName of fallbackCollections) {
        try {
          const rawDocs = await conn.connection.db
            .collection(collName)
            .find(filter)
            .sort({ priorityOrder: 1, startTime: 1, _id: 1 })
            .limit(limit)
            .toArray();
          if (rawDocs && rawDocs.length > 0) {
            docs = rawDocs as any;
            break;
          }
        } catch {
          // ignore collection query errors
        }
      }
    }

    const activeBaseUrl = await getDynamicStreamBaseUrl();
    let events = (docs || []).map((d) => serializeEvent(d, now, activeBaseUrl));

    // No fallback mock events — the API returns only real MongoDB data.
    // When the local admin creates/edits events they sync to Atlas instantly,
    // and Vercel reads them fresh on every request.

    return sportsJson(
      req,
      {
        success: true,
        count: events.length,
        serverTime: new Date(now).toISOString(),
        events,
        data: events,
        matches: events,
        items: events,
      },
      {
        headers: NO_CACHE_HEADERS,
      }
    );
  } catch (error) {
    return failure(req, "GET /api/sports/events", error);
  }
}

/**
 * POST /api/sports/events   (admin)
 * Creates one event card. Auth: `x-admin-secret` header or body `secretKey`.
 * Body: { matchTitle, sportType, startTime, endTime, primaryStreamUrl, status?,
 *         backupStreamUrls?, isLocalServerActive?, priorityOrder? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    if (!isAuthorizedAdmin(req, typeof body?.secretKey === "string" ? body.secretKey : undefined)) {
      return sportsJson(req, UNAUTHORIZED, { status: 401 });
    }
    if (!body) return sportsJson(req, { success: false, error: "Request body must be a JSON object" }, { status: 400 });

    const parsed = parseEventPayload(body, "create");
    if (!parsed.ok) return sportsJson(req, { success: false, error: "Validation failed", errors: parsed.errors }, { status: 400 });

    const conn = await connectToDatabase();
    if (!conn) return sportsJson(req, DB_DOWN, { status: 503 });

    const created = await SportsEvent.create(parsed.data);
    return sportsJson(req, { success: true, event: serializeEvent(created.toObject()) }, { status: 201 });
  } catch (error) {
    return failure(req, "POST /api/sports/events", error);
  }
}

/**
 * PUT /api/sports/events   (admin)
 *
 * 1) Update one card:  PUT /api/sports/events?id=<id>   body: any subset of the card fields
 *                      (the id may also be sent as body.id)
 * 2) Bulk re-rank:     PUT /api/sports/events           body: { reorder: [{ id, priorityOrder }, …] }
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    if (!isAuthorizedAdmin(req, typeof body?.secretKey === "string" ? body.secretKey : undefined)) {
      return sportsJson(req, UNAUTHORIZED, { status: 401 });
    }
    if (!body) return sportsJson(req, { success: false, error: "Request body must be a JSON object" }, { status: 400 });

    const conn = await connectToDatabase();
    if (!conn) return sportsJson(req, DB_DOWN, { status: 503 });

    /* ---- bulk reorder ---- */
    if (Array.isArray(body.reorder)) {
      const items = body.reorder as unknown[];
      if (items.length === 0 || items.length > 200) {
        return sportsJson(req, { success: false, error: "reorder must contain 1-200 items" }, { status: 400 });
      }
      const ops = [];
      for (const item of items) {
        const it = item as { id?: unknown; priorityOrder?: unknown };
        if (
          typeof it?.id !== "string" ||
          !mongoose.isValidObjectId(it.id) ||
          typeof it.priorityOrder !== "number" ||
          !Number.isInteger(it.priorityOrder) ||
          it.priorityOrder < 0 ||
          it.priorityOrder > 9999
        ) {
          return sportsJson(
            req,
            { success: false, error: "Each reorder item needs a valid id and an integer priorityOrder (0-9999)" },
            { status: 400 }
          );
        }
        ops.push({ updateOne: { filter: { _id: it.id }, update: { $set: { priorityOrder: it.priorityOrder } } } });
      }
      const result = await SportsEvent.bulkWrite(ops);
      return sportsJson(req, { success: true, matched: result.matchedCount, modified: result.modifiedCount });
    }

    /* ---- single update ---- */
    const idRaw = req.nextUrl.searchParams.get("id") ?? body.id ?? body._id;
    if (typeof idRaw !== "string" || !mongoose.isValidObjectId(idRaw)) {
      return sportsJson(req, { success: false, error: "A valid event id is required (?id=… or body.id)" }, { status: 400 });
    }

    const parsed = parseEventPayload(body, "update");
    if (!parsed.ok) return sportsJson(req, { success: false, error: "Validation failed", errors: parsed.errors }, { status: 400 });

    const doc = await SportsEvent.findById(idRaw);
    if (!doc) return sportsJson(req, { success: false, error: "Event not found" }, { status: 404 });

    doc.set(parsed.data);
    await doc.save(); // runs schema validators incl. endTime > startTime against the merged document
    return sportsJson(req, { success: true, event: serializeEvent(doc.toObject()) });
  } catch (error) {
    return failure(req, "PUT /api/sports/events", error);
  }
}

/**
 * DELETE /api/sports/events?id=<id>   (admin)
 * The id may also be sent as body.id.
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    if (!isAuthorizedAdmin(req, typeof body?.secretKey === "string" ? body.secretKey : undefined)) {
      return sportsJson(req, UNAUTHORIZED, { status: 401 });
    }

    const idRaw = req.nextUrl.searchParams.get("id") ?? body?.id ?? body?._id;
    if (typeof idRaw !== "string" || !mongoose.isValidObjectId(idRaw)) {
      return sportsJson(req, { success: false, error: "A valid event id is required (?id=… or body.id)" }, { status: 400 });
    }

    const conn = await connectToDatabase();
    if (!conn) return sportsJson(req, DB_DOWN, { status: 503 });

    const deleted = await SportsEvent.findByIdAndDelete(idRaw).lean();
    if (!deleted) return sportsJson(req, { success: false, error: "Event not found" }, { status: 404 });

    return sportsJson(req, { success: true, deletedId: idRaw });
  } catch (error) {
    return failure(req, "DELETE /api/sports/events", error);
  }
}
