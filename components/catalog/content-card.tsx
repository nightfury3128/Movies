"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Plus } from "lucide-react";
import type { ContentItem } from "@/lib/catalog";
import { apiGet, detailsPath } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function ContentCard({ item, emphasis = "default" }: { item: ContentItem; emphasis?: "default" | "continue" }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const href = detailsPath(item);

  const prefetch = () => {
    router.prefetch(href);
    void queryClient.prefetchQuery({
      queryKey: ["content", item.id],
      queryFn: () => apiGet<ContentItem>(`/api/catalog?id=${item.id}`)
    });
    if (typeof window !== "undefined") {
      [item.poster, item.backdrop].forEach((src) => {
        const image = new window.Image();
        image.src = src;
      });
    }
  };

  return (
    <div
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className="athera-lift group relative w-full overflow-hidden rounded-2xl border bg-card p-3"
    >
      <Link href={href} className="absolute inset-0 z-10" aria-label={`Open ${item.title}`} />
      <div className="grid grid-cols-[92px_1fr] gap-3">
        <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-muted">
          <Image src={item.poster} alt={`${item.title} poster`} fill sizes="100px" className="object-cover transition duration-200 group-hover:scale-105" />
        </div>
        <div className="flex min-w-0 flex-col py-1">
          <div className="line-clamp-2 font-semibold leading-tight">{item.title}</div>
          <div className="mt-2 text-sm text-muted-foreground">
            {item.year} · {item.genres[0]}
          </div>
          {emphasis === "continue" && (
            <>
              <div className="mt-3 text-xs text-muted-foreground">
                {Math.max(0, 100 - Math.round(item.progress ?? 0))}% left
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/60">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(item.progress ?? 0)}%` }} />
              </div>
            </>
          )}
          <div className="pointer-events-none mt-auto flex translate-y-2 gap-2 opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100">
            <Button size="sm" variant="action" asChild className="pointer-events-auto z-20 rounded-full">
              <Link href={`/watch/${item.id}`} aria-label={`Play ${item.title}`}>
                <Play className="h-4 w-4 fill-current" />
              </Link>
            </Button>
            <Button size="sm" variant="secondary" aria-label="Add to watchlist" className="pointer-events-auto z-20 rounded-full">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
