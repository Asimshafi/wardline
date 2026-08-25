import type { CaseRow } from "@/lib/types";
import { timeAgo } from "@/lib/time";

export default function CaseCard({ c }: { c: CaseRow }) {
  const admitted = c.status === "admitted";
  const tags = [c.taxonomy?.subject_area, c.taxonomy?.module, c.taxonomy?.theme].filter(
    Boolean,
  ) as string[];

  return (
    <li className="rounded border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-gray-900">{c.diagnosis_snapshot}</h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            admitted ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
          }`}
        >
          {c.status}
        </span>
      </div>

      <p className="mt-1 text-sm text-gray-500">
        {c.ward} · Bed {c.bed}
      </p>

      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((t) => (
            <span key={t} className="rounded bg-ward-soft px-2 py-0.5 text-xs text-ward">
              {t}
            </span>
          ))}
        </div>
      )}

      {c.note && <p className="mt-2 text-sm text-gray-700">{c.note}</p>}

      <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
        <span>Years {c.matched_years.join(", ")}</span>
        <time dateTime={c.created_at}>{timeAgo(c.created_at)}</time>
      </div>
    </li>
  );
}
