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

    const { channelId, isPinned, priorityOrder } = body;

    if (!channelId || typeof isPinned !== "boolean") {
      return NextResponse.json(
        { success: false, error: "Missing required fields: channelId, isPinned" },
        { status: 400 }
      );
    }

    const order = typeof priorityOrder === "number" ? priorityOrder : (isPinned ? 1 : 99);

    const conn = await connectToDatabase();

    if (conn && mongoose.isValidObjectId(channelId)) {
      // MongoDB Mode
      await Channel.findByIdAndUpdate(channelId, {
        isPinned,
        priorityOrder: order,
      });
    }

    // Always update in-memory store too
    inMemoryDb.updateChannelPin(channelId, isPinned, order);

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
