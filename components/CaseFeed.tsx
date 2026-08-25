"use client";

import { useState } from "react";
import type { CaseRow } from "@/lib/types";
import CaseCard from "@/components/CaseCard";

// Shared by the student view (canFilterYears=false; RLS already scopes rows) and the admin
// view (canFilterYears=true; sees all years and can filter client-side) — spec §8.
export default function CaseFeed({
  cases,
  canFilterYears,
  viewerYear,
  error,
}: {
  cases: CaseRow[];
  canFilterYears: boolean;
  viewerYear: number | null;
  error: string | null;
}) {
  const [year, setYear] = useState<number | "all">("all");

  const filtered =
    canFilterYears && year !== "all"
      ? cases.filter((c) => c.matched_years.includes(year))
      : cases;

  if (error) {
    return <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }

  return (
    <div>
      {canFilterYears && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500">Year:</span>
          {(["all", 1, 2, 3, 4, 5] as const).map((y) => (
            <button
              key={y}
              onClick={() => setYear(y)}
              className={`rounded px-3 py-1 ${
                year === y ? "bg-ward text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {y === "all" ? "All" : `Year ${y}`}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-400">
          No cases yet
          {viewerYear && !canFilterYears ? ` for year ${viewerYear}` : ""}.
        </p>
      ) : (
        <ul className="space-y-3">
          {filtered.map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
