import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase, databaseUnavailable } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { authorizeAdminRequest } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.status }
      );
    }
    const body = auth.body;

    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { success: false, error: "No channel IDs provided for deletion" },
        { status: 400 }
      );
    }

    const conn = await connectToDatabase();
    const unavailable = databaseUnavailable(conn, "Database unavailable — nothing was deleted");
    if (unavailable) return unavailable;

    // Counts what was actually deleted, not what was submitted.
    let deletedCount = 0;

    if (conn) {
      // MongoDB Mode: Bulk delete channels with valid ObjectIds
      const validMongoIds = ids.filter((id: string) => mongoose.isValidObjectId(id));
      if (validMongoIds.length > 0) {
        const res = await Channel.deleteMany({ _id: { $in: validMongoIds } });
        await StreamLink.deleteMany({ channelId: { $in: validMongoIds } });
        deletedCount += res.deletedCount ?? 0;
      }
      // Custom string ids can only live in the local store; valid ObjectIds were
      // already counted above, so their store copies are cleaned without double-counting.
      for (const id of ids) {
        const removed = inMemoryDb.deleteChannel(id);
        if (removed && !mongoose.isValidObjectId(id)) deletedCount += 1;
      }
    } else {
      for (const id of ids) {
        if (inMemoryDb.deleteChannel(id)) deletedCount += 1;
      }
    }

    return NextResponse.json({
      success: true,
      count: deletedCount,
      message: `Successfully deleted ${deletedCount} of ${ids.length} marked channels and their stream links.`,
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/bulk-delete error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to bulk delete channels" },
      { status: 500 }
    );
  }
}
