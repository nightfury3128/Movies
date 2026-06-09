import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/profiles";
import { parseUserContentId } from "@/lib/user-content-id";

export async function POST(request: Request) {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as { profileId?: string; contentId?: string };
  if (!body.profileId || !body.contentId) return NextResponse.json({ error: "profileId and contentId are required" }, { status: 400 });
  const ref = parseUserContentId(body.contentId);
  if (!ref) return NextResponse.json({ error: "Unsupported content id" }, { status: 400 });

  const { data, error } = await supabase
    .from("favorites")
    .upsert({ profile_id: body.profileId, tmdb_id: ref.tmdbId, content_type: ref.contentType }, { onConflict: "profile_id,tmdb_id,content_type" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
