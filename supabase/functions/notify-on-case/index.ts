// supabase/functions/notify-on-case/index.ts
//
// Deno Edge Function. Wire it to a Supabase Database Webhook on INSERT into public.cases
// (Dashboard → Database → Webhooks). It messages every opted-in student in a matched year
// who has linked Telegram, and logs each attempt in notifications_sent.
//
// Secrets (set with `supabase secrets set …`):
//   TELEGRAM_BOT_TOKEN   from @BotFather
//   WEBHOOK_SECRET       arbitrary string; also add it as header `x-webhook-secret` on the webhook
// Injected by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface CaseRecord {
  id: string;
  diagnosis_snapshot: string;
  ward: string;
  bed: string;
  status: string;
  matched_years: number[];
}
interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: CaseRecord | null;
}

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Reject spoofed calls when a secret is configured.
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN not set", { status: 500 });

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const c = payload.record;
  if (payload.type !== "INSERT" || payload.table !== "cases" || !c) {
    return new Response("Ignored", { status: 200 });
  }
  // Only notify on a fresh admission.
  if (c.status !== "admitted") return new Response("Not an admission; skipped", { status: 200 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: recipients, error } = await admin
    .from("students")
    .select("id, telegram_chat_id")
    .eq("opted_in", true)
    .not("telegram_chat_id", "is", null)
    .in("mbbs_year", c.matched_years); // mbbs_year ∈ matched_years

  if (error) return new Response(`Recipient query failed: ${error.message}`, { status: 500 });

  const text =
    `🏥 <b>${escapeHtml(c.diagnosis_snapshot)}</b>\n` +
    `${escapeHtml(c.ward)} · Bed ${escapeHtml(c.bed)}\n` +
    `Status: ${escapeHtml(c.status)} · Years ${c.matched_years.join(", ")}`;

  let sent = 0;
  let failed = 0;

  for (const r of recipients ?? []) {
    // Claim the send; the unique(case_id, student_id, channel) constraint makes webhook
    // retries idempotent — a conflict means it was already handled.
    const { error: claimErr } = await admin
      .from("notifications_sent")
      .insert({ case_id: c.id, student_id: r.id, channel: "telegram", status: "pending" });
    if (claimErr) continue;

    let ok = false;
    let errMsg: string | null = null;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: r.telegram_chat_id, text, parse_mode: "HTML" }),
      });
      ok = resp.ok;
      if (!ok) errMsg = `telegram ${resp.status}: ${(await resp.text()).slice(0, 400)}`;
    } catch (e) {
      errMsg = String(e).slice(0, 400);
    }

    await admin
      .from("notifications_sent")
      .update({
        status: ok ? "sent" : "failed",
        sent_at: ok ? new Date().toISOString() : null,
        error: errMsg,
      })
      .eq("case_id", c.id)
      .eq("student_id", r.id)
      .eq("channel", "telegram");

    ok ? sent++ : failed++;
  }

  return new Response(JSON.stringify({ recipients: recipients?.length ?? 0, sent, failed }), {
    headers: { "content-type": "application/json" },
  });
});
