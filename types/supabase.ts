/**
 * Supabase database types.
 *
 * This is a stub. Regenerate from the live schema with:
 *
 *   npx supabase gen types typescript \
 *     --project-id gytyylwgcmxywdyuouwj \
 *     --schema public \
 *     > types/supabase.ts
 *
 * Until that's run, `Database` is intentionally loose so the app
 * compiles. Typed queries will return `any` — that's fine for now;
 * generate real types before we rely on row-level inference.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: Record<string, {
      Row: Record<string, any>;
      Insert: Record<string, any>;
      Update: Record<string, any>;
      Relationships: [];
    }>;
    Views: Record<string, { Row: Record<string, any> }>;
    Functions: Record<string, {
      Args: Record<string, any>;
      Returns: any;
    }>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, Record<string, any>>;
  };
}
