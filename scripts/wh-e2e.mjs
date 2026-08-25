// scripts/wh-e2e.mjs
// One-shot END-TO-END delivery test for the notify pipeline:
//   cases INSERT  →  0008 pg_net trigger (net.http_post + x-webhook-secret from Vault)
//                 →  notify-on-case Edge Function  →  Telegram  →  notifications_sent flips to 'sent'.
// Creates ONE throwaway, opted-in student pointed at a given chat id + mbbs_year, inserts ONE
// 'admitted' case (service_role) whose matched_years includes that year, polls notifications_sent
// until it resolves, prints a verdict, then deletes everything it created. Secrets come from env
// only (spec §10); none are printed. Dev/staging tool — do not point at a project with real accounts.
//
// Run:
//   set -a && source <(sed 's/\r$//' .env.local) && set +a && node scripts/wh-e2e.mjs <telegram_chat_id>

const BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CHAT_ID = process.argv[2];
const YEAR = 4;

if (!BASE || !SVC || !ANON) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in env.'); process.exitCode = 1; }
if (!CHAT_ID) { console.error('Usage: node scripts/wh-e2e.mjs <telegram_chat_id>'); process.exitCode = 1; }

async function req(path, { method = 'GET', token, key, body, prefer } = {}) {
  const apikey = key || SVC;
  const headers = { 'Content-Type': 'application/json', apikey, Authorization: `Bearer ${token || apikey}` };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}
const rest   = (p, o = {}) => req(`/rest/v1${p}`, o);
const gotrue = (p, o = {}) => req(`/auth/v1${p}`, o);
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL = `wardline-wh-e2e-${Date.now()}@example.com`;

async function main() {
  if (!BASE || !SVC || !ANON || !CHAT_ID) return;

  console.log('— setup: creating one throwaway opted-in recipient —');
  const cu = await gotrue(`/admin/users`, {
    method: 'POST', key: SVC,
    body: { email: EMAIL, password: 'e2e-Test-123!', email_confirm: true, user_metadata: { full_name: 'Webhook E2E', mbbs_year: YEAR } },
  });
  if (!cu.ok) throw new Error(`create user: ${cu.status} ${JSON.stringify(cu.body)}`);
  const uid = cu.body.id;

  // handle_new_user() already made the students row (opted_in defaults true); link the chat id + pin the year.
  const patch = await rest(`/students?id=eq.${uid}`, {
    method: 'PATCH', key: SVC, prefer: 'return=representation',
    body: { opted_in: true, telegram_chat_id: String(CHAT_ID), mbbs_year: YEAR },
  });
  if (!patch.ok) throw new Error(`patch student: ${patch.status} ${JSON.stringify(patch.body)}`);
  console.log(`  recipient ready — year ${YEAR}, opted in, chat id linked.`);

  // Use a real syllabus term so the message looks realistic; force matched_years to [YEAR] so it targets our recipient.
  const tax = await rest(`/syllabus_taxonomy?select=id,diagnosis&limit=1`, { key: SVC });
  const taxId = tax.body?.[0]?.id ?? null;
  const dx = `[Wardline test] ${tax.body?.[0]?.diagnosis ?? 'Test diagnosis'}`;

  console.log('— firing: inserting ONE admitted case (service_role) —');
  const ins = await rest(`/cases`, {
    method: 'POST', key: SVC, prefer: 'return=representation',
    body: { taxonomy_id: taxId, diagnosis_snapshot: dx, ward: 'E2E-TEST', bed: 'T1', status: 'admitted', matched_years: [YEAR], logged_by: uid, note: 'Wardline delivery test — please ignore.' },
  });
  if (!ins.ok) throw new Error(`insert case: ${ins.status} ${JSON.stringify(ins.body)}`);
  const caseId = ins.body[0].id;
  console.log(`  case ${caseId} inserted; trigger enqueued net.http_post → awaiting delivery (async)…`);

  // pg_net worker → function → row. Poll notifications_sent for up to ~40s.
  let row = null, resolved = null;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const n = await rest(`/notifications_sent?case_id=eq.${caseId}&select=student_id,channel,status,error,sent_at`, { key: SVC });
    row = Array.isArray(n.body) ? n.body.find((r) => r.student_id === uid) : null;
    if (row) {
      console.log(`  [t+${(i + 1) * 2}s] notifications_sent.status=${row.status}${row.error ? ` error=${JSON.stringify(row.error)}` : ''}`);
      if (row.status === 'sent' || row.status === 'failed') { resolved = row; break; }
    } else {
      console.log(`  [t+${(i + 1) * 2}s] no notifications_sent row yet…`);
    }
  }

  const delivered = resolved && resolved.status === 'sent';
  console.log('');
  if (delivered) {
    console.log(`RESULT: DELIVERED ✅  notifications_sent flipped to 'sent'${resolved.sent_at ? ` at ${resolved.sent_at}` : ''}. Check your Telegram for the "${dx}" message.`);
  } else if (resolved) {
    console.log(`RESULT: REACHED TELEGRAM BUT FAILED ❌  status='failed', error=${JSON.stringify(resolved.error)}.`);
    console.log(`        (Function ran + auth passed. Usual causes: you haven't pressed Start on the bot, or a bad TELEGRAM_BOT_TOKEN / chat id.)`);
  } else if (row) {
    console.log(`RESULT: STUCK PENDING ❌  a row exists but never left 'pending' within ~40s (function crashed mid-send).`);
  } else {
    console.log(`RESULT: NO NOTIFICATION ROW ❌  the function never wrote one within ~40s.`);
    console.log(`        Most likely: the Vault secret 'wardline_webhook_secret' ≠ the function's WEBHOOK_SECRET (→ 401, function exits before any DB write),`);
    console.log(`        or the trigger/pg_net didn't fire. (Insert itself succeeded, so the trigger IS attached.)`);
  }

  console.log('— teardown: removing test rows + user —');
  await rest(`/notifications_sent?case_id=eq.${caseId}`, { method: 'DELETE', key: SVC, prefer: 'return=minimal' });
  await rest(`/cases?id=eq.${caseId}`, { method: 'DELETE', key: SVC, prefer: 'return=minimal' });
  await rest(`/cases?logged_by=eq.${uid}`, { method: 'DELETE', key: SVC, prefer: 'return=minimal' });
  await gotrue(`/admin/users/${uid}`, { method: 'DELETE', key: SVC });
  console.log('  clean — no test data left behind.');

  if (!delivered) process.exitCode = 1;   // exitCode (not exit()) → clean socket drain on Windows/Node 24
}
main().catch((e) => { console.error('E2E ERROR:', e.message); process.exitCode = 1; });
