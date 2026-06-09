"use client";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContentCard } from "@/components/catalog/content-card";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import type { ContentItem } from "@/lib/catalog";

export function SearchClient() {
  const [query, setQuery] = useState("");
  const lastRecordedRef = useRef("");
  const debounced = useMemo(() => query.trim(), [query]);
  const { data = [], isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => apiGet<ContentItem[]>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0
  });

  useEffect(() => {
    if (debounced.length < 2 || debounced === lastRecordedRef.current) return;
    const profileId = window.localStorage.getItem("athera_active_profile_id");
    if (!profileId) return;
    lastRecordedRef.current = debounced;
    const timer = window.setTimeout(() => {
      void fetch("/api/search-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, query: debounced })
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [debounced]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-10">
      <h1 className="brand-font text-4xl">Search</h1>
      <div className="relative mt-6 max-w-3xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your network"
          className="h-14 rounded-2xl bg-card pl-11 text-base"
          autoFocus
        />
      </div>
      <div className="mt-8">
        {!debounced && <p className="text-muted-foreground">Start typing to search the Athera catalog.</p>}
        {debounced && !isFetching && data.length === 0 && <p className="text-muted-foreground">No results found.</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {data.map((item) => (
            <ContentCard key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}
