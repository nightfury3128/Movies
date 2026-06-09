import { NextResponse } from "next/server";
import { getContent } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const CATALOG_URL = process.env.ATHERA_CATALOG_URL ?? process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (CATALOG_URL) {
    const response = await fetch(`${CATALOG_URL}/content/${id}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return NextResponse.json(await response.json());
  }

  const content = getContent(id);
  if (!content) return NextResponse.json({ error: "Content not found" }, { status: 404 });
  return NextResponse.json(content);
}
