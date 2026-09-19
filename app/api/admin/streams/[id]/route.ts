import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { refreshChannelLinks } from "@/lib/maintenanceRunner";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const { id } = params;
    const conn = await connectToDatabase();

    // Remember the owner so the remaining links can be renumbered afterwards.
    let channelId: string | null = null;

    if (conn && mongoose.isValidObjectId(id)) {
      const doc = await StreamLink.findById(id).lean();
      if (doc) channelId = String(doc.channelId);
      await StreamLink.findByIdAndDelete(id);
    }

    if (!channelId) {
      const mem = inMemoryDb.getStreams().find((s) => s._id === id);
      if (mem) channelId = mem.channelId;
    }

    // Always clean inMemoryDb as well
    inMemoryDb.deleteStream(id);

    // Keep "fastest link is Server 1" true after the gap left by the delete.
    if (channelId) await refreshChannelLinks(channelId);

    return NextResponse.json({
      success: true,
      message: `Stream link ${id} deleted successfully`,
    });
  } catch (error: any) {
    console.error("DELETE /api/admin/streams/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to delete stream link" },
      { status: 500 }
    );
  }
}
