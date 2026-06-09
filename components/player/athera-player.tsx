"use client";

import Image from "next/image";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Captions, Gauge, Maximize, Pause, Play, RotateCcw, Sparkles, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ContentItem } from "@/lib/catalog";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { usePlaybackStore } from "@/stores/playback-store";

type ResolveResponse = {
  mode: "preview" | "engine";
  streamUrl: string;
  status: "ready" | "warming";
  candidates: string[];
  message?: string;
};

export function AtheraPlayer({ content, contentId, title }: { content: ContentItem; contentId: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSaveRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [quality, setQuality] = useState("Optimized");
  const [subtitles, setSubtitles] = useState("Off");
  const [profileId, setProfileId] = useState<string | null>(null);
  const localPosition = usePlaybackStore((state) => state.positions[contentId]);
  const setPosition = usePlaybackStore((state) => state.setPosition);

  const resolve = useQuery({
    queryKey: ["resolve", contentId],
    queryFn: async () => {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId })
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<ResolveResponse>;
    }
  });

  const savePlayback = useMutation({
    mutationFn: (payload: { currentTime: number; duration: number }) =>
      apiGet("/api/playback", {
        method: "POST",
        body: JSON.stringify({ profileId, contentId, ...payload })
      })
  });

  const persist = () => {
    const video = videoRef.current;
    if (!video) return;
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    setPosition(contentId, currentTime, duration);
    if (profileId) savePlayback.mutate({ currentTime, duration });
  };

  useEffect(() => {
    setProfileId(window.localStorage.getItem("athera_active_profile_id"));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolve.data?.streamUrl) return;

    let hls: { destroy: () => void; loadSource: (src: string) => void; attachMedia: (video: HTMLVideoElement) => void } | null = null;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = resolve.data.streamUrl;
    } else {
      void import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) return;
        hls = new Hls({ lowLatencyMode: true });
        hls.loadSource(resolve.data.streamUrl);
        hls.attachMedia(video);
      });
    }

    return () => hls?.destroy();
  }, [resolve.data?.streamUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !localPosition?.currentTime) return;
    const restore = () => {
      if (Math.abs(video.currentTime - localPosition.currentTime) > 3) {
        video.currentTime = localPosition.currentTime;
      }
    };
    video.addEventListener("loadedmetadata", restore, { once: true });
    return () => video.removeEventListener("loadedmetadata", restore);
  }, [localPosition?.currentTime]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (Date.now() - lastSaveRef.current >= 15_000) {
        lastSaveRef.current = Date.now();
        persist();
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      persist();
    };
    const onEnded = () => {
      setPlaying(false);
      persist();
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", persist);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    window.addEventListener("beforeunload", persist);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", persist);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
      window.removeEventListener("beforeunload", persist);
    };
  });

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, video.currentTime + seconds);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <Image src={content.backdrop} alt="" fill priority sizes="100vw" className="object-cover opacity-10 blur-sm" />
      <div className="absolute inset-0 bg-background/88" />
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex h-16 items-center gap-4 px-4 sm:px-6">
          <Button asChild variant="ghost" size="icon" aria-label="Back">
            <Link href={content.type === "anime" ? `/anime/${content.id}` : content.type === "series" ? `/series/${content.id}` : `/movie/${content.id}`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="text-sm text-muted-foreground">Athera Player</div>
            <h1 className="font-semibold">{title}</h1>
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm text-primary sm:flex">
            <Sparkles className="h-4 w-4" />
            {resolve.data?.streamUrl ? "Ready" : "Optimizing"}
          </div>
        </header>

        <section className="flex flex-1 items-center justify-center px-4 pb-24">
          <div className="athera-surface relative aspect-video w-full max-w-6xl overflow-hidden rounded-3xl border bg-background shadow-2xl">
            {resolve.data?.streamUrl ? (
              <video ref={videoRef} className="h-full w-full" controls={false} playsInline poster={content.backdrop} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="brand-font text-3xl">{resolve.isLoading ? "Optimizing" : "Ready"}</div>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    {resolve.data?.message ?? "Athera is preparing the best available route for instant resume."}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-primary/10 bg-background/85 px-4 py-4 backdrop-blur-xl sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <Button onClick={toggle} variant="action" size="icon" aria-label={playing ? "Pause" : "Play"} className="rounded-full">
              {playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
            </Button>
            <Button onClick={() => seek(-10)} variant="secondary" size="icon" aria-label="Rewind 10 seconds" className="rounded-full">
              <RotateCcw className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2 rounded-full border border-primary/10 bg-card px-3 py-2 text-sm">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              <select value={quality} onChange={(event) => setQuality(event.target.value)} className="bg-transparent outline-none">
                {["Optimized", "1080p", "720p"].map((candidate) => (
                  <option key={candidate} value={candidate} className="bg-card">
                    {candidate}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-primary/10 bg-card px-3 py-2 text-sm">
              <Captions className="h-4 w-4 text-muted-foreground" />
              <select value={subtitles} onChange={(event) => setSubtitles(event.target.value)} className="bg-transparent outline-none">
                {["Off", "English", "Spanish"].map((track) => (
                  <option key={track} value={track} className="bg-card">
                    {track}
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto flex items-center gap-3 text-muted-foreground">
              <Volume2 className="h-5 w-5" />
              <Maximize className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
