import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
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

    const { orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing required field: orderedIds (array of channel IDs)" },
        { status: 400 }
      );
    }

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode: Bulk update priorityOrder for each channel
      const bulkOps = orderedIds
        .filter((id: string) => mongoose.isValidObjectId(id))
        .map((id: string, index: number) => ({
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(id) },
            update: { $set: { priorityOrder: index + 1 } },
          },
        }));

      if (bulkOps.length > 0) {
        await Channel.bulkWrite(bulkOps);
      }
    }

    // Always update in-memory store too
    inMemoryDb.updatePinnedOrder(orderedIds);

    return NextResponse.json({
      success: true,
      message: `Reordered ${orderedIds.length} pinned channels successfully`,
      count: orderedIds.length,
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/reorder error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to reorder pinned channels" },
      { status: 500 }
    );
  }
}
