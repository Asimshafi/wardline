import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CaseFeed from "@/components/CaseFeed";
import type { CaseRow } from "@/lib/types";

export const dynamic = "force-dynamic"; // auth-dependent; never statically cached

export default async function FeedPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase
    .from("students")
    .select("role, mbbs_year")
    .eq("id", user.id)
    .single();
  const isAdmin = me?.role === "admin";

  // RLS restricts students to cases whose matched_years include their year; admins see all.
  const { data, error } = await supabase
    .from("cases")
    .select(
      "id, diagnosis_snapshot, ward, bed, note, status, matched_years, created_at, taxonomy:syllabus_taxonomy(subject_area, module, theme)",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  const cases = (data ?? []) as unknown as CaseRow[];

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Case feed</h1>
      <p className="mb-6 text-sm text-gray-500">
        {isAdmin
          ? "All admissions across every year-group."
          : `Admissions matching MBBS year ${me?.mbbs_year ?? "?"}.`}
      </p>
      <CaseFeed
        cases={cases}
        canFilterYears={isAdmin}
        viewerYear={me?.mbbs_year ?? null}
        error={error?.message ?? null}
      />
    </div>
  );
}
