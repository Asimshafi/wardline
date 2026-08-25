"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

interface StudentRow {
  id: string;
  full_name: string;
  mbbs_year: number;
  role: Role;
  opted_in: boolean;
  telegram_chat_id: string | null;
}

const ROLES: Role[] = ["student", "feeder", "admin"];

export default function StudentsAdmin({ selfId }: { selfId: string }) {
  const [supabase] = useState(() => createClient());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    let query = supabase
      .from("students")
      .select("id, full_name, mbbs_year, role, opted_in, telegram_chat_id")
      .order("full_name")
      .limit(200);
    if (q.trim()) query = query.ilike("full_name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) setError(error.message);
    else setRows((data ?? []) as StudentRow[]);
  }, [q, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, patch: Partial<StudentRow>, label: string) {
    setError(null);
    setMessage(null);
    setSavingId(id);
    try {
      const { error } = await supabase.from("students").update(patch).eq("id", id);
      if (error) {
        setError(error.message);
        await load(); // revert optimistic UI to server truth
      } else {
        setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
        setMessage(label);
      }
    } finally {
      setSavingId(null);
    }
  }

  function changeRole(r: StudentRow, role: Role) {
    if (role === r.role) return;
    if (r.id === selfId && role !== "admin") {
      if (!confirm("Change your OWN role away from admin? You will lose admin access.")) return;
    }
    if (role === "admin" && !confirm(`Grant admin to ${r.full_name}?`)) return;
    patch(r.id, { role }, `${r.full_name} → ${role}`);
  }

  return (
    <div className="space-y-4">
      <input
        className="w-full rounded border border-gray-300 px-3 py-2"
        placeholder="Search by name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {message && <p className="rounded bg-ward-soft px-3 py-2 text-sm text-ward">{message}</p>}
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <ul className="divide-y divide-gray-100 rounded border border-gray-200 bg-white">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{r.full_name}</span>
              {r.id === selfId && <span className="ml-1 text-xs text-gray-400">(you)</span>}
              <span className="ml-2 text-xs text-gray-400">
                {r.telegram_chat_id ? (r.opted_in ? "Telegram ✓" : "Telegram (opted out)") : "no Telegram"}
              </span>
            </span>

            <span className="flex items-center gap-2">
              <select
                className="rounded border border-gray-300 px-2 py-1"
                value={r.mbbs_year}
                disabled={savingId === r.id}
                onChange={(e) => patch(r.id, { mbbs_year: Number(e.target.value) }, `${r.full_name} → Year ${e.target.value}`)}
              >
                {[1, 2, 3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    Year {y}
                  </option>
                ))}
              </select>

              <select
                className="rounded border border-gray-300 px-2 py-1"
                value={r.role}
                disabled={savingId === r.id}
                onChange={(e) => changeRole(r, e.target.value as Role)}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="px-3 py-4 text-center text-sm text-gray-400">No students.</li>}
      </ul>

      <p className="text-xs text-gray-400">
        Role changes are enforced server-side: only admins can change roles (§5.5), and the change is audited.
      </p>
    </div>
  );
}
