"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

type PlaybackState = {
  positions: Record<string, { currentTime: number; duration: number; updatedAt: number }>;
  setPosition: (contentId: string, currentTime: number, duration: number) => void;
};

export const usePlaybackStore = create<PlaybackState>()(
  persist(
    (set) => ({
      positions: {},
      setPosition: (contentId, currentTime, duration) =>
        set((state) => ({
          positions: {
            ...state.positions,
            [contentId]: { currentTime, duration, updatedAt: Date.now() }
          }
        }))
    }),
    { name: "athera-playback" }
  )
);
