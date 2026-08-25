"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

interface Props {
  id: string;
  fullName: string;
  mbbsYear: number;
  role: Role;
  optedIn: boolean;
  telegramChatId: string | null;
}

function friendlyError(msg: string): string {
  if (/duplicate key|unique/i.test(msg)) return "That Telegram ID is already linked to another account.";
  if (/row-level security/i.test(msg)) return "You can only edit your own account.";
  return msg;
}

export default function AccountForm(props: Props) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  const [fullName, setFullName] = useState(props.fullName);
  const [optedIn, setOptedIn] = useState(props.optedIn);
  const [chatId, setChatId] = useState(props.telegramChatId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const telegramLinked = !!props.telegramChatId;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    const trimmedChat = chatId.trim();
    if (trimmedChat && !/^-?\d+$/.test(trimmedChat)) {
      return setError("Telegram ID must be numeric (e.g. 123456789).");
    }
    if (!fullName.trim()) return setError("Name is required.");

    setBusy(true);
    try {
      const { error } = await supabase
        .from("students")
        .update({
          full_name: fullName.trim(),
          opted_in: optedIn,
          telegram_chat_id: trimmedChat || null,
        })
        .eq("id", props.id);
      if (error) return setError(friendlyError(error.message));
      setMessage("Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-md space-y-5">
      <div>
        <label className="block text-sm text-gray-600">Full name</label>
        <input
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
      </div>

      <div className="flex items-center justify-between rounded border border-gray-200 bg-white px-3 py-2 text-sm">
        <span>
          MBBS year <span className="font-medium">Year {props.mbbsYear}</span>
          <span className="ml-2 text-xs text-gray-400">({props.role})</span>
        </span>
        <span className="text-xs text-gray-400">Contact an admin to change your year</span>
      </div>

      <div className="rounded border border-gray-200 bg-white p-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={optedIn}
            onChange={(e) => setOptedIn(e.target.checked)}
          />
          Send me Telegram notifications for matching cases
        </label>

        <div className="mt-3">
          <label className="block text-sm text-gray-600">
            Telegram chat ID {telegramLinked && <span className="text-xs text-ward">· linked</span>}
          </label>
          <input
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            placeholder="e.g. 123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            inputMode="numeric"
          />
          <p className="mt-1 text-xs text-gray-400">
            Open Telegram, message <span className="font-mono">@userinfobot</span>, and paste the numeric
            Id it replies with. Then send <span className="font-mono">/start</span> to the Wardline bot so it
            can message you. Leave blank to unlink.
          </p>
        </div>
      </div>

      {message && <p className="rounded bg-ward-soft px-3 py-2 text-sm text-ward">{message}</p>}
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="rounded bg-ward px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
