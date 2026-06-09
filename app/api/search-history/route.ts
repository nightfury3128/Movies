import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/profiles";

export async function POST(request: Request) {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as { profileId?: string; query?: string };
  const query = body.query?.trim();
  if (!body.profileId || !query) return NextResponse.json({ error: "profileId and query are required" }, { status: 400 });

  const { data, error } = await supabase
    .from("search_history")
    .insert({ profile_id: body.profileId, query })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
