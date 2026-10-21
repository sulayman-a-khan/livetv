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

    const { channelId, isPinned, priorityOrder } = body;

    if (!channelId || typeof isPinned !== "boolean") {
      return NextResponse.json(
        { success: false, error: "Missing required fields: channelId, isPinned" },
        { status: 400 }
      );
    }

    // A negative or absurd order is refused instead of being stored verbatim:
    // the ladder sorts on this number, so an out-of-range value silently
    // pushes a channel to the wrong end of the pinned board.
    let order: number;
    if (typeof priorityOrder === "number") {
      if (!Number.isInteger(priorityOrder) || priorityOrder < 1 || priorityOrder > 9999) {
        return NextResponse.json(
          {
            success: false,
            error: "priorityOrder must be a whole number between 1 and 9999",
          },
          { status: 400 }
        );
      }
      order = priorityOrder;
    } else {
      order = isPinned ? 1 : 99;
    }

    const conn = await connectToDatabase();

    if (conn) {
      if (!mongoose.isValidObjectId(channelId)) {
        return NextResponse.json(
          { success: false, error: "Channel not found" },
          { status: 404 }
        );
      }
      // MongoDB Mode — report a miss instead of claiming a pin that never happened.
      const updated = await Channel.findByIdAndUpdate(channelId, {
        isPinned,
        priorityOrder: order,
      });
      if (!updated) {
        return NextResponse.json(
          { success: false, error: "Channel not found" },
          { status: 404 }
        );
      }
    } else {
      // In-memory mode: the store owns the catalogue, so it is the only thing
      // that is written.
      const updated = inMemoryDb.updateChannelPin(channelId, isPinned, order);
      if (!updated) {
        return NextResponse.json(
          { success: false, error: "Channel not found" },
          { status: 404 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: `Channel ${channelId} ${isPinned ? "pinned" : "unpinned"} successfully`,
      isPinned,
      priorityOrder: order,
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/pin error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to update channel pin status" },
      { status: 500 }
    );
  }
}
