import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxonomyMatch } from "@/lib/types";

// Diagnosis search against the taxonomy (§6/§7). Delegates to the search_taxonomy RPC
// (0005_search.sql) so ranking + the FTS/trigram indexes live in one deterministic place,
// and the browser never ships raw query logic. Returns one row per diagnosis with years
// unioned across modules — exactly what the feeder form needs to auto-fill matched_years.
export async function searchDiagnoses(
  supabase: SupabaseClient,
  query: string,
  limit = 20,
): Promise<TaxonomyMatch[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const { data, error } = await supabase.rpc("search_taxonomy", {
    q,
    max_results: limit,
  });
  if (error) throw error;
  return (data ?? []) as TaxonomyMatch[];
}
