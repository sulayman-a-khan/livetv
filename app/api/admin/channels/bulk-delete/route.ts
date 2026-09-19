import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { success: false, error: "No channel IDs provided for deletion" },
        { status: 400 }
      );
    }

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode: Bulk delete channels with valid ObjectIds
      const validMongoIds = ids.filter((id: string) => mongoose.isValidObjectId(id));
      if (validMongoIds.length > 0) {
        await Channel.deleteMany({ _id: { $in: validMongoIds } });
        await StreamLink.deleteMany({ channelId: { $in: validMongoIds } });
      }
    }

    // Always clean inMemoryDb for all provided IDs
    for (const id of ids) {
      inMemoryDb.deleteChannel(id);
    }

    return NextResponse.json({
      success: true,
      count: ids.length,
      message: `Successfully deleted ${ids.length} marked channels and their stream links.`,
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/bulk-delete error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to bulk delete channels" },
      { status: 500 }
    );
  }
}
