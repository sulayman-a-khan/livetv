import { NextRequest } from "next/server";
import { channelDetailResponse } from "@/lib/channelDetailResponse";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return channelDetailResponse(req, params.id, "web");
}
