import { NextRequest, NextResponse } from "next/server";
import { getDynamicStreamBaseUrl, setDynamicStreamBaseUrl } from "@/lib/settings";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { isAuthorizedLocalServer, sportsCorsHeaders, sportsJson, sportsPreflight } from "@/lib/sportsApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return sportsPreflight(req);
}

/**
 * GET /api/admin/stream-settings
 * Returns the active streamBaseUrl from MongoDB settings (or env fallback).
 * Auth: Admin secret or Local Server secret — same gate as the POST, since this
 * reply names the host every forwarded stream is pulled from.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req) && !isAuthorizedLocalServer(req)) {
      return sportsJson(req, { success: false, error: "Unauthorized" }, { status: 401 });
    }

    const streamBaseUrl = await getDynamicStreamBaseUrl();
    return sportsJson(req, {
      success: true,
      streamBaseUrl,
      source: streamBaseUrl ? "mongodb_settings" : "env_fallback",
    });
  } catch (err: any) {
    return sportsJson(req, { success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/admin/stream-settings
 * Updates the active streamBaseUrl in MongoDB settings.
 * Auth: Admin secret or Local Server secret.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const secretKey = typeof body?.secretKey === "string" ? body.secretKey : undefined;

    const isAdmin = isAuthorizedAdmin(req, secretKey);
    const isLocal = isAuthorizedLocalServer(req);

    if (!isAdmin && !isLocal) {
      return sportsJson(req, { success: false, error: "Unauthorized" }, { status: 401 });
    }

    const newUrl = typeof body?.streamBaseUrl === "string" ? body.streamBaseUrl.trim() : "";
    if (!newUrl) {
      return sportsJson(req, { success: false, error: "streamBaseUrl is required" }, { status: 400 });
    }

    const updatedUrl = await setDynamicStreamBaseUrl(newUrl);
    return sportsJson(req, {
      success: true,
      message: "Active Stream Base URL updated successfully",
      streamBaseUrl: updatedUrl,
    });
  } catch (err: any) {
    return sportsJson(req, { success: false, error: err.message }, { status: 500 });
  }
}
