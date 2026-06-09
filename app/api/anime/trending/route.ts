import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CATALOG_URL = process.env.ATHERA_CATALOG_URL ?? process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function GET() {
  if (CATALOG_URL) {
    const response = await fetch(`${CATALOG_URL}/anime/trending`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return NextResponse.json(await response.json());
  }

  return NextResponse.json([]);
}
