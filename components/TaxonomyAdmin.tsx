"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Row {
  id: string;
  diagnosis: string;
  synonyms: string | null;
  subject_area: string | null;
  module: string | null;
  theme: string | null;
  year: number;
}

const EMPTY = {
  diagnosis: "",
  synonyms: "",
  subject_area: "",
  module: "",
  theme: "",
  year: 1,
};

export default function TaxonomyAdmin() {
  const [supabase] = useState(() => createClient());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    let query = supabase
      .from("syllabus_taxonomy")
      .select("id, diagnosis, synonyms, subject_area, module, theme, year")
      .order("diagnosis")
      .limit(50);
    if (q.trim()) query = query.ilike("diagnosis", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) setError(error.message);
    else setRows((data ?? []) as Row[]);
  }, [q, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function edit(r: Row) {
    setEditingId(r.id);
    setForm({
      diagnosis: r.diagnosis,
      synonyms: r.synonyms ?? "",
      subject_area: r.subject_area ?? "",
      module: r.module ?? "",
      theme: r.theme ?? "",
      year: r.year,
    });
    setMessage(null);
    setError(null);
  }

  function resetForm() {
    setEditingId(null);
    setForm({ ...EMPTY });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!form.diagnosis.trim()) return setError("Diagnosis is required.");
    setBusy(true);
    try {
      const payload = {
        diagnosis: form.diagnosis.trim(),
        synonyms: form.synonyms.trim() || null,
        subject_area: form.subject_area.trim() || null,
        module: form.module.trim() || null,
        theme: form.theme.trim() || null,
        year: Number(form.year),
      };
      const { error } = editingId
        ? await supabase.from("syllabus_taxonomy").update(payload).eq("id", editingId)
        : await supabase.from("syllabus_taxonomy").insert(payload);
      if (error) return setError(error.message);
      setMessage(editingId ? "Updated." : "Added.");
      resetForm();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this taxonomy row?")) return;
    const { error } = await supabase.from("syllabus_taxonomy").delete().eq("id", id);
    if (error) setError(error.message);
    else await load();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={save} className="grid grid-cols-2 gap-2 rounded border border-gray-200 bg-white p-4">
        <input className="col-span-2 rounded border border-gray-300 px-2 py-1" placeholder="Diagnosis *"
          value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} />
        <input className="col-span-2 rounded border border-gray-300 px-2 py-1" placeholder="Synonyms (; separated)"
          value={form.synonyms} onChange={(e) => setForm({ ...form, synonyms: e.target.value })} />
        <input className="rounded border border-gray-300 px-2 py-1" placeholder="Subject area"
          value={form.subject_area} onChange={(e) => setForm({ ...form, subject_area: e.target.value })} />
        <input className="rounded border border-gray-300 px-2 py-1" placeholder="Module"
          value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} />
        <input className="rounded border border-gray-300 px-2 py-1" placeholder="Theme"
          value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })} />
        <select className="rounded border border-gray-300 px-2 py-1" value={form.year}
          onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>Year {y}</option>)}
        </select>
        <div className="col-span-2 flex gap-2">
          <button type="submit" disabled={busy} className="rounded bg-ward px-3 py-1 text-sm text-white disabled:opacity-50">
            {editingId ? "Save changes" : "Add row"}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} className="rounded bg-gray-100 px-3 py-1 text-sm">Cancel</button>
          )}
        </div>
      </form>

      <div className="flex gap-2">
        <input className="flex-1 rounded border border-gray-300 px-3 py-2" placeholder="Search diagnosis…"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {message && <p className="rounded bg-ward-soft px-3 py-2 text-sm text-ward">{message}</p>}
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <ul className="divide-y divide-gray-100 rounded border border-gray-200 bg-white">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{r.diagnosis}</span>
              <span className="ml-2 text-xs text-gray-400">
                Yr {r.year}{r.module ? ` · ${r.module}` : ""}{r.theme ? ` · ${r.theme}` : ""}
              </span>
            </span>
            <span className="flex gap-2">
              <button onClick={() => edit(r)} className="text-ward hover:underline">Edit</button>
              <button onClick={() => remove(r.id)} className="text-red-600 hover:underline">Delete</button>
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="px-3 py-4 text-center text-sm text-gray-400">No rows.</li>}
      </ul>
    </div>
  );
}
