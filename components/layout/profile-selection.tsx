"use client";

import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { Database } from "@/lib/supabase/types";

type Profile = Database["public"]["Tables"]["user_profiles"]["Row"];

export function ProfileSelection({ profiles }: { profiles: Profile[] }) {
  const [items, setItems] = useState(profiles);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  function selectProfile(profileId: string) {
    window.localStorage.setItem("athera_active_profile_id", profileId);
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) return;

    const response = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    if (!response.ok) {
      setError("Unable to create that profile.");
      return;
    }

    const profile = (await response.json()) as Profile;
    setItems((current) => [...current, profile]);
    setCreating(false);
  }

  return (
    <div className="mt-10 grid gap-4 sm:grid-cols-3">
      {items.map((profile) => (
        <Link key={profile.id} href="/home" className="group" onClick={() => selectProfile(profile.id)}>
          <Card className="athera-lift athera-surface p-6">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl bg-primary/15 text-3xl font-black text-primary">
              {profile.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="mt-5 font-semibold">{profile.name}</div>
            <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-primary" />
              Synced
            </div>
          </Card>
        </Link>
      ))}
      <Card className="athera-lift border-dashed bg-transparent p-6 text-muted-foreground">
        {creating ? (
          <form onSubmit={createProfile} className="space-y-3">
            <Input name="name" placeholder="Profile name" autoFocus />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="action">Create</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <button type="button" className="w-full" onClick={() => setCreating(true)}>
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl border border-dashed border-current">
              <Plus className="h-8 w-8" />
            </div>
            <div className="mt-5 font-semibold">Add Profile</div>
          </button>
        )}
      </Card>
    </div>
  );
}
