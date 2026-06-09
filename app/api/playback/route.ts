import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/profiles";
import { parseUserContentId } from "@/lib/user-content-id";

export async function GET(request: Request) {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const profileId = searchParams.get("profileId");
  if (!profileId) return NextResponse.json({ error: "profileId is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("playback_state")
    .select("*")
    .eq("profile_id", profileId)
    .lt("percent_complete", 95)
    .order("last_watched_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as { profileId?: string; contentId?: string; currentTime?: number; duration?: number };
  if (!body.profileId) return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  if (!body.contentId) return NextResponse.json({ error: "contentId is required" }, { status: 400 });

  const ref = parseUserContentId(body.contentId);
  if (!ref) return NextResponse.json({ error: "Unsupported content id for user playback state" }, { status: 400 });

  const current = Math.max(0, Math.round(Number(body.currentTime ?? 0)));
  const duration = Math.max(0, Math.round(Number(body.duration ?? 0)));
  const percent = duration > 0 ? Math.min(100, Number(((current / duration) * 100).toFixed(2))) : 0;

  const row = {
    profile_id: body.profileId,
    content_type: ref.contentType,
    tmdb_id: ref.tmdbId,
    season_number: ref.seasonNumber,
    episode_number: ref.episodeNumber,
    current_time_seconds: current,
    duration_seconds: duration,
    percent_complete: percent,
    last_watched_at: new Date().toISOString()
  };

  if (percent >= 95) {
    let deleteQuery = supabase
      .from("playback_state")
      .delete()
      .eq("profile_id", row.profile_id)
      .eq("content_type", row.content_type)
      .eq("tmdb_id", row.tmdb_id);
    deleteQuery = row.season_number == null ? deleteQuery.is("season_number", null) : deleteQuery.eq("season_number", row.season_number);
    deleteQuery = row.episode_number == null ? deleteQuery.is("episode_number", null) : deleteQuery.eq("episode_number", row.episode_number);
    await deleteQuery;

    await supabase.from("watch_history").insert({
      profile_id: row.profile_id,
      content_type: row.content_type,
      tmdb_id: row.tmdb_id,
      season_number: row.season_number,
      episode_number: row.episode_number,
      started_at: row.last_watched_at,
      completed_at: row.last_watched_at,
      watch_time_seconds: current,
      completion_percentage: percent
    });

    return NextResponse.json({ ...row, removedFromContinueWatching: true });
  }

  let existingQuery = supabase
    .from("playback_state")
    .select("id")
    .eq("profile_id", row.profile_id)
    .eq("content_type", row.content_type)
    .eq("tmdb_id", row.tmdb_id)
    .limit(1);
  existingQuery = row.season_number == null ? existingQuery.is("season_number", null) : existingQuery.eq("season_number", row.season_number);
  existingQuery = row.episode_number == null ? existingQuery.is("episode_number", null) : existingQuery.eq("episode_number", row.episode_number);

  const { data: existing, error: lookupError } = await existingQuery.maybeSingle();
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 400 });

  const mutation = existing
    ? supabase.from("playback_state").update(row).eq("id", existing.id)
    : supabase.from("playback_state").insert(row);

  const { data, error } = await mutation
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
