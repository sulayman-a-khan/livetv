import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { canonicalChannelKey } from "@/lib/channelIdentity";

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

    if (conn && mongoose.isValidObjectId(id)) {
      // MongoDB Mode
      await Channel.findByIdAndDelete(id);
      await StreamLink.deleteMany({ channelId: id });
    }

    // Always check/clean inMemoryDb as well
    inMemoryDb.deleteChannel(id);

    return NextResponse.json({
      success: true,
      message: `Channel ${id} and associated streams deleted successfully`,
    });
  } catch (error: any) {
    console.error("DELETE /api/admin/channels/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to delete channel" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/channels/[id]
 * Manual override of channel metadata. Accepts any subset of:
 *   name, logo, category, subCategory, country, tags[]
 *
 * Saving marks the channel `isManuallyEdited`, which permanently protects these
 * fields from auto-detection and from the merge pass overwriting them.
 * Renaming re-derives the canonical identity key so the channel merges with (or
 * separates from) the right siblings on the next maintenance run.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const { id } = params;
    const { name, logo, category, subCategory, country, tags } = body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: any = {};
    if (typeof name === "string" && name.trim()) {
      patch.name = name.trim();
      patch.normalizedName = canonicalChannelKey(name.trim());
    }
    if (typeof logo === "string") patch.logo = logo.trim();
    if (typeof category === "string" && category.trim()) patch.category = category.trim();
    if (typeof subCategory === "string") patch.subCategory = subCategory.trim();
    if (typeof country === "string" && country.trim()) patch.country = country.trim();
    if (Array.isArray(tags)) {
      patch.tags = tags
        .map((t: unknown) => String(t).trim())
        .filter(Boolean)
        .slice(0, 20);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: "No editable fields supplied" },
        { status: 400 }
      );
    }

    patch.isManuallyEdited = true;
    const conn = await connectToDatabase();

    if (conn && mongoose.isValidObjectId(id)) {
      const updated = await Channel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (updated) {
        return NextResponse.json({ success: true, channel: updated });
      }
    }

    const updated = inMemoryDb.updateChannel(id, patch, true);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, channel: updated });
  } catch (error: any) {
    console.error("PUT /api/admin/channels/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to update channel" },
      { status: 500 }
    );
  }
}
