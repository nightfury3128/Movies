"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Play, Plus, Zap } from "lucide-react";
import type { ContentItem } from "@/lib/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ContentDetails({ item }: { item: ContentItem }) {
  const warmPlayback = useMutation({
    mutationFn: async () => {
      await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: item.id })
      });
    }
  });

  useEffect(() => {
    warmPlayback.mutate();
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-10">
      <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="athera-surface rounded-3xl border p-4">
          <div className="relative aspect-[2/3] overflow-hidden rounded-2xl">
              <Image src={item.poster} alt={`${item.title} poster`} fill sizes="280px" className="object-cover" />
          </div>
        </div>
        <div className="athera-surface rounded-3xl border p-6 sm:p-8">
          <div className="flex max-w-3xl flex-col">
            <div className="flex flex-wrap gap-2">
              <Badge>{item.match}% Match</Badge>
              <Badge>{item.year}</Badge>
              <Badge>{item.maturity}</Badge>
              <Badge>{item.runtime}</Badge>
            </div>
            <h1 className="brand-font mt-6 text-5xl sm:text-7xl">{item.title}</h1>
            <p className="mt-5 text-lg leading-8 text-muted-foreground">{item.description}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
              {item.genres.map((genre) => (
                <span key={genre}>{genre}</span>
              ))}
            </div>
            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              {["Ready", "Optimized", "Instant Resume"].map((label, index) => (
                <div key={label} className="rounded-2xl bg-background/35 p-4">
                  {index === 0 ? <Activity className="h-5 w-5 text-primary" /> : <Zap className="h-5 w-5 text-primary" />}
                  <div className="mt-3 text-sm font-semibold">{label}</div>
                </div>
              ))}
            </div>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg" variant="action" className="rounded-full">
                <Link href={`/watch/${item.id}`}>
                  <Play className="h-5 w-5 fill-current" />
                  {item.progress ? "Resume" : "Play"}
                </Link>
              </Button>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Plus className="h-5 w-5" />
                My List
              </Button>
            </div>
          </div>
        </div>
      </section>

      {(item.type === "series" || item.type === "anime") && item.episodes && (
        <section className="mt-8">
          <h2 className="brand-font mb-4 text-2xl">Season 1</h2>
          <div className="grid gap-3">
            {item.episodes.map((episode) => (
              <Card key={episode.id} className="athera-lift grid grid-cols-[64px_1fr_auto] items-center gap-4 p-4">
                <div className="text-center text-2xl font-black text-muted-foreground">{episode.episode}</div>
                <div>
                  <div className="font-semibold">{episode.title}</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    S{episode.season}:E{episode.episode} · {episode.runtime}
                    {episode.progress ? ` · ${episode.progress}% watched` : ""}
                  </div>
                </div>
                <Button asChild variant="secondary" size="sm" className="rounded-full">
                  <Link href={`/watch/${episode.id}`}>{episode.progress ? "Resume" : "Play"}</Link>
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
