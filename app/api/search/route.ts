import { NextResponse } from "next/server";
import { catalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const CATALOG_URL = process.env.ATHERA_CATALOG_URL ?? process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim().toLowerCase() ?? "";

  if (!query) return NextResponse.json([]);

  if (CATALOG_URL) {
    const response = await fetch(`${CATALOG_URL}/search?q=${encodeURIComponent(query)}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return NextResponse.json(await response.json());
  }

  return NextResponse.json(
    catalog.filter((item) => {
      const haystack = [item.title, item.description, item.type, ...item.genres].join(" ").toLowerCase();
      return haystack.includes(query);
    })
  );
}
