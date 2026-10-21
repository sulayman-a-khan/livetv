import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
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

    const { orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing required field: orderedIds (array of channel IDs)" },
        { status: 400 }
      );
    }

    if (!orderedIds.every((id: unknown) => typeof id === "string" && id.trim().length > 0)) {
      return NextResponse.json(
        { success: false, error: "orderedIds must contain channel ID strings only" },
        { status: 400 }
      );
    }

    const ids = orderedIds as string[];
    const conn = await connectToDatabase();

    if (conn) {
      // An id that could never name a channel is refused outright. Dropping it
      // silently is what made this route report a reorder it never performed.
      const invalid = ids.filter((id) => !mongoose.isValidObjectId(id));
      if (invalid.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `Not a valid channel ID: ${invalid.slice(0, 5).join(", ")}${
              invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ""
            }`,
          },
          { status: 400 }
        );
      }

      const bulkOps = ids.map((id, index) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(id) },
          update: { $set: { priorityOrder: index + 1 } },
        },
      }));

      const result = await Channel.bulkWrite(bulkOps);
      const applied = result.matchedCount ?? 0;
      return NextResponse.json({
        success: true,
        message: `Reordered ${applied} pinned channel(s)`,
        /** Channels that now carry the requested order. */
        count: applied,
        /** Ids that named no channel — they were not reordered. */
        skipped: ids.length - applied,
        /** Already in that position, so nothing had to change. */
        unchanged: Math.max(0, applied - (result.modifiedCount ?? 0)),
      });
    }

    // In-memory mode: the store owns the catalogue, and it can only apply the
    // ids it actually holds — so it reports how many of them it moved.
    const applied = inMemoryDb.updatePinnedOrder(ids);
    return NextResponse.json({
      success: true,
      message: `Reordered ${applied} pinned channel(s)`,
      count: applied,
      skipped: ids.length - applied,
      unchanged: 0,
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/reorder error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to reorder pinned channels" },
      { status: 500 }
    );
  }
}
