import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/profiles";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let settings: { theme: string; autoplay: boolean; default_quality: string; subtitles_enabled: boolean; preferred_language: string } | null = null;
  try {
    const { supabase, user } = await getCurrentUser();
    if (user) {
      const { data } = await supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle();
      settings = data;
    }
  } catch {
    settings = null;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-10">
      <h1 className="text-3xl font-black">Settings</h1>
      <Card className="mt-6 p-5">
        <div className="font-semibold">Playback</div>
        <p className="mt-2 text-sm text-muted-foreground">
          {settings
            ? `Quality: ${settings.default_quality} · Subtitles: ${settings.subtitles_enabled ? "On" : "Off"} · Language: ${settings.preferred_language}`
            : "Connect Supabase to sync playback, subtitles, and device preferences."}
        </p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href="/settings/developer">Developer diagnostics</Link>
        </Button>
      </Card>
    </div>
  );
}
