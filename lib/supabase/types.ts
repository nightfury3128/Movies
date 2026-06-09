export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      user_profiles: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          avatar_url: string | null;
          is_child: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          name: string;
          avatar_url?: string | null;
          is_child?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_profiles"]["Insert"]>;
        Relationships: [];
      };
      playback_state: {
        Row: {
          id: string;
          profile_id: string;
          content_type: string;
          tmdb_id: number;
          season_number: number | null;
          episode_number: number | null;
          current_time_seconds: number;
          duration_seconds: number;
          percent_complete: number;
          last_watched_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          content_type: string;
          tmdb_id: number;
          season_number?: number | null;
          episode_number?: number | null;
          current_time_seconds?: number;
          duration_seconds?: number;
          percent_complete?: number;
          last_watched_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["playback_state"]["Insert"]>;
        Relationships: [];
      };
      watch_history: {
        Row: {
          id: string;
          profile_id: string;
          content_type: string;
          tmdb_id: number;
          season_number: number | null;
          episode_number: number | null;
          started_at: string;
          completed_at: string | null;
          watch_time_seconds: number;
          completion_percentage: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["watch_history"]["Row"], "id" | "created_at" | "updated_at"> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["watch_history"]["Insert"]>;
        Relationships: [];
      };
      watchlists: {
        Row: { id: string; profile_id: string; tmdb_id: number; content_type: string; added_at: string; created_at: string; updated_at: string };
        Insert: { id?: string; profile_id: string; tmdb_id: number; content_type: string; added_at?: string; created_at?: string; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["watchlists"]["Insert"]>;
        Relationships: [];
      };
      favorites: {
        Row: { id: string; profile_id: string; tmdb_id: number; content_type: string; created_at: string; updated_at: string };
        Insert: { id?: string; profile_id: string; tmdb_id: number; content_type: string; created_at?: string; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["favorites"]["Insert"]>;
        Relationships: [];
      };
      user_settings: {
        Row: {
          id: string;
          user_id: string;
          theme: string;
          autoplay: boolean;
          default_quality: string;
          subtitles_enabled: boolean;
          preferred_language: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          theme?: string;
          autoplay?: boolean;
          default_quality?: string;
          subtitles_enabled?: boolean;
          preferred_language?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_settings"]["Insert"]>;
        Relationships: [];
      };
      watch_sessions: {
        Row: {
          id: string;
          profile_id: string;
          tmdb_id: number;
          content_type: string;
          session_start: string;
          session_end: string | null;
          watch_time_seconds: number;
          average_quality: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["watch_sessions"]["Row"], "id" | "created_at" | "updated_at"> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["watch_sessions"]["Insert"]>;
        Relationships: [];
      };
      search_history: {
        Row: { id: string; profile_id: string; query: string; created_at: string; updated_at: string };
        Insert: { id?: string; profile_id: string; query: string; created_at?: string; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["search_history"]["Insert"]>;
        Relationships: [];
      };
      profile_preferences: {
        Row: {
          id: string;
          profile_id: string;
          favorite_genres: Json;
          favorite_languages: Json;
          favorite_categories: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          favorite_genres?: Json;
          favorite_languages?: Json;
          favorite_categories?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profile_preferences"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {};
    Functions: {};
    Enums: {};
    CompositeTypes: {};
  };
};
