import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/profiles";

export async function GET() {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  const { supabase, user } = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    theme?: string;
    autoplay?: boolean;
    default_quality?: string;
    subtitles_enabled?: boolean;
    preferred_language?: string;
  };

  const { data, error } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id, ...body }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
