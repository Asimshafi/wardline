"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { searchDiagnoses } from "@/lib/matching";
import { WARDS, type CaseStatus, type TaxonomyMatch } from "@/lib/types";

// Soft, client-side PII hint only. The DB trigger (§5.1) is the real, authoritative check.
function looksLikePII(note: string): string | null {
  if (/\d{5}-\d{7}-\d/.test(note)) return "That looks like a CNIC.";
  if (/\d{10,}/.test(note) || /(\+?92|0)?[\s-]?3\d{2}[\s-]?\d{7}/.test(note))
    return "That looks like a phone/ID number.";
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(note)) return "That looks like an email.";
  if (/\b[sdwb]\s*\/\s*o\b/i.test(note)) return "Do not enter names or relations (S/O, D/O).";
  return null;
}

function friendlyError(message: string): string {
  if (message.includes("PII_REJECTED"))
    return "Rejected: the note contains patient-identifying data. Remove names, CNIC, MRN, phone, or email.";
  if (message.includes("RATE_LIMITED"))
    return "Slow down — you've logged too many cases in the last hour.";
  if (message.includes("row-level security"))
    return "You don't have permission to log cases.";
  return message;
}

export default function CaseEntryForm() {
  const [supabase] = useState(() => createClient());

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaxonomyMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<TaxonomyMatch | null>(null);

  const [ward, setWard] = useState<string>("");
  const [bed, setBed] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<CaseStatus>("admitted");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Debounced diagnosis search.
  useEffect(() => {
    if (selected && query === selected.diagnosis) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const r = await searchDiagnoses(supabase, q);
        if (active) setResults(r);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, selected, supabase]);

  function pick(match: TaxonomyMatch) {
    setSelected(match);
    setQuery(match.diagnosis);
    setResults([]);
  }

  function reset() {
    setSelected(null);
    setQuery("");
    setResults([]);
    setBed("");
    setNote("");
    setStatus("admitted");
  }

  const noteWarning = note ? looksLikePII(note) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!selected) return setError("Pick a diagnosis from the list.");
    if (!ward) return setError("Choose a ward.");
    if (!bed.trim()) return setError("Enter a bed.");

    setBusy(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return setError("Session expired — please sign in again.");

      const { error } = await supabase.from("cases").insert({
        taxonomy_id: selected.representative_id,
        diagnosis_snapshot: selected.diagnosis,
        ward,
        bed: bed.trim(),
        note: note.trim() || null,
        status,
        logged_by: user.id,
        matched_years: selected.years,
      });
      if (error) {
        setError(friendlyError(error.message));
        return;
      }
      setSuccess(`Logged "${selected.diagnosis}" — years ${selected.years.join(", ")} notified.`);
      reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Diagnosis search */}
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700">Diagnosis</label>
        <input
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          placeholder="Start typing… e.g. DVT, anaemia, TOF"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          autoComplete="off"
        />
        {searching && <p className="mt-1 text-xs text-gray-400">Searching…</p>}

        {results.length > 0 && !selected && (
          <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border border-gray-200 bg-white shadow">
            {results.map((m) => (
              <li key={m.representative_id}>
                <button
                  type="button"
                  onClick={() => pick(m)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-ward-soft"
                >
                  <span>
                    <span className="font-medium">{m.diagnosis}</span>
                    {m.synonyms && (
                      <span className="ml-2 text-xs text-gray-400">{m.synonyms}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-gray-500">
                    Yr {m.years.join(", ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="rounded bg-ward-soft px-3 py-2 text-sm text-ward">
          Matches year-group(s): <strong>{selected.years.join(", ")}</strong>
          {selected.subject_area ? ` · ${selected.subject_area}` : ""}
          {selected.theme ? ` · ${selected.theme}` : ""}
        </div>
      )}

      {/* Ward + bed */}
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium text-gray-700">
          Ward
          <select
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={ward}
            onChange={(e) => setWard(e.target.value)}
          >
            <option value="">Select…</option>
            {WARDS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm font-medium text-gray-700">
          Bed
          <input
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            placeholder="e.g. 12B"
            value={bed}
            onChange={(e) => setBed(e.target.value)}
          />
        </label>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Status</span>
        {(["admitted", "discharged"] as CaseStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded px-3 py-1 text-sm capitalize ${
              status === s ? "bg-ward text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Note */}
      <div>
        <label className="block text-sm font-medium text-gray-700">
          Note <span className="font-normal text-gray-400">(optional, no identifiers)</span>
        </label>
        <textarea
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          rows={2}
          placeholder="Teaching-relevant context only"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {noteWarning && (
          <p className="mt-1 text-xs text-amber-700">⚠ {noteWarning} It will be rejected on submit.</p>
        )}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-ward px-3 py-2 font-medium text-white disabled:opacity-50"
      >
        {busy ? "Logging…" : "Log case"}
      </button>

      {success && (
        <p className="rounded bg-ward-soft px-3 py-2 text-sm text-ward">{success}</p>
      )}
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </form>
  );
}
