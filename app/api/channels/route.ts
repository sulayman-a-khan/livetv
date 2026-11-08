import { NextRequest } from "next/server";
import { channelCatalogueResponse } from "@/lib/channelCatalogueResponse";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return channelCatalogueResponse(req, "web");
}
