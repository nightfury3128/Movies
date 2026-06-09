import { NextResponse } from "next/server";
import { catalogSections, getContent } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const CATALOG_URL = process.env.ATHERA_CATALOG_URL ?? process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (id) {
    if (CATALOG_URL) {
      const response = await fetch(`${CATALOG_URL}/content/${id}`, { cache: "no-store" }).catch(() => null);
      if (response?.ok) return NextResponse.json(await response.json());
    }
    const item = getContent(id);
    if (!item) return NextResponse.json({ error: "Content not found" }, { status: 404 });
    return NextResponse.json(item);
  }

  return NextResponse.json(catalogSections());
}
