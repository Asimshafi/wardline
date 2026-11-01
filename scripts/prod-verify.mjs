// scripts/prod-verify.mjs
// Pre-pilot PRODUCTION security verification for Wardline (build spec §4, §5).
// Exercises the live database THROUGH the same PostgREST/GoTrue path the app uses, as
// real feeder / student / admin users (never the service_role key for the assertions).
// service_role is used ONLY for setup (create users, bootstrap roles), for reading the
// admin-only audit log, for read-back confirmation, and for teardown.
//
// SAFETY: every case inserted here uses status='discharged', so the 0008 notify trigger
// (WHEN new.status='admitted') never fires — no Telegram messages are sent. The controls
// under test are all status-independent (see 0002/0003). All test data is torn down.
//
// Run:  set -a && source <(sed 's/\r$//' .env.local) && set +a && node scripts/prod-verify.mjs
//
// #6 (pg_cron) calls a temporary service_role-only RPC public.__verify_ops() (migration
// 0012); if it isn't deployed the cron/trigger evidence is reported as SKIPPED, not failed.

const BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE || !SVC || !ANON) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in env.');
  process.exitCode = 1;
}

const TAG = 'V' + Date.now();                         // unique per run → collision-free + targeted teardown
const PW  = 'verify-Test-123!';
const mk  = (r, yr) => ({ email: `wardline-verify-${r}-${TAG}@example.com`, password: PW, full_name: `Verify ${r}`, mbbs_year: yr });
const ADMIN = mk('admin', 5);
const FEED  = mk('feeder', 4);
const STU   = mk('student', 3);
const RL    = mk('ratelimit', 4);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'}  ${name}${detail ? `\n         → ${detail}` : ''}`);
}

async function req(path, { method = 'GET', token, key, body, prefer } = {}) {
  const apikey = key || ANON;
  const headers = { 'Content-Type': 'application/json', apikey, Authorization: `Bearer ${token || apikey}` };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}
const rest   = (p, o = {}) => req(`/rest/v1${p}`, o);
const gotrue = (p, o = {}) => req(`/auth/v1${p}`, o);

const createdIds = [];
async function createUser(u) {
  const r = await gotrue(`/admin/users`, {
    method: 'POST', key: SVC, token: SVC,
    body: { email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.full_name, mbbs_year: u.mbbs_year } },
  });
  if (!r.ok) throw new Error(`create ${u.email}: ${r.status} ${JSON.stringify(r.body)}`);
  createdIds.push(r.body.id);
  return r.body.id;
}
async function setRole(id, role) {
  const r = await rest(`/students?id=eq.${id}`, { method: 'PATCH', key: SVC, token: SVC, body: { role }, prefer: 'return=representation' });
  if (!r.ok) throw new Error(`setRole ${role}: ${r.status} ${JSON.stringify(r.body)}`);
}
async function login(u) {
  const r = await gotrue(`/token?grant_type=password`, { method: 'POST', key: ANON, body: { email: u.email, password: u.password } });
  if (!r.ok) throw new Error(`login ${u.email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}
const isPiiReject = (r) => !r.ok && JSON.stringify(r.body).includes('PII_REJECTED');

async function cleanup() {
  console.log('\n— teardown —');
  if (createdIds.length === 0) return;
  const ids = createdIds.join(',');
  // audit rows first (actor FK is SET NULL on user delete → target by actor while still set)
  await rest(`/case_audit_log?actor=in.(${ids})`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
  await rest(`/notifications_sent?student_id=in.(${ids})`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
  await rest(`/cases?logged_by=in.(${ids})`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
  for (const id of createdIds) await gotrue(`/admin/users/${id}`, { method: 'DELETE', key: SVC, token: SVC });
  console.log(`   removed ${createdIds.length} test users + their cases/audit rows`);
}

async function main() {
  // ── #4 (part A): snapshot REAL pre-existing audit 'create' rows (the E2E case) ──
  const preAudit = await rest(`/case_audit_log?action=eq.create&select=case_id,actor,action,created_at&order=created_at.desc&limit=5`, { key: SVC, token: SVC });
  let realEvidence = 'no pre-existing create rows found';
  if (preAudit.ok && Array.isArray(preAudit.body) && preAudit.body.length) {
    const top = preAudit.body[0];
    const who = top.actor ? await rest(`/students?id=eq.${top.actor}&select=full_name,role`, { key: SVC, token: SVC }) : { body: [] };
    const what = top.case_id ? await rest(`/cases?id=eq.${top.case_id}&select=diagnosis_snapshot,ward,status&limit=1`, { key: SVC, token: SVC }) : { body: [] };
    realEvidence = `${preAudit.body.length} real create-row(s); latest @ ${top.created_at}: actor=${who.body?.[0]?.full_name ?? top.actor} (${who.body?.[0]?.role ?? '?'}), action='${top.action}', case='${what.body?.[0]?.diagnosis_snapshot ?? '(purged/expired)'}'`;
  }

  // ── setup ──
  const adminId = await createUser(ADMIN);
  const feedId  = await createUser(FEED);
  const stuId   = await createUser(STU);
  const rlId    = await createUser(RL);
  await setRole(adminId, 'admin');
  await setRole(feedId, 'feeder');
  await setRole(rlId, 'feeder');
  // stuId stays 'student' (handle_new_user default) — verified implicitly below.

  const adminTok = await login(ADMIN);
  const feedTok  = await login(FEED);
  const stuTok   = await login(STU);
  const rlTok    = await login(RL);

  const tax = await rest(`/syllabus_taxonomy?select=id,diagnosis&limit=1`, { key: SVC, token: SVC });
  const taxId = tax.body?.[0]?.id ?? null;
  const dx = tax.body?.[0]?.diagnosis ?? 'Verification diagnosis';
  const baseCase = { taxonomy_id: taxId, diagnosis_snapshot: dx, ward: 'VERIFY', status: 'discharged', logged_by: feedId, matched_years: [4] };

  // ══ #1  PII rejection — REJECT not strip, as a feeder ═══════════════════════════
  const piiCases = [
    { label: 'CNIC',      note: 'Admitted with chest pain, CNIC 12345-1234567-1', bed: `${TAG}-cnic` },
    { label: 'phone',     note: 'Attendant contact 0301-2345678',                 bed: `${TAG}-phone` },
    { label: 'name (S/O)',note: 'Patient S/O Muhammad Asim, stable',              bed: `${TAG}-son` },
  ];
  let rejected = 0, notStripped = 0;
  for (const p of piiCases) {
    const r = await rest(`/cases`, { method: 'POST', token: feedTok, body: { ...baseCase, bed: p.bed, note: p.note }, prefer: 'return=minimal' });
    if (isPiiReject(r)) rejected++;
    const rb = await rest(`/cases?logged_by=eq.${feedId}&bed=eq.${p.bed}&select=id`, { key: SVC, token: SVC });   // proof it was NOT written
    if (Array.isArray(rb.body) && rb.body.length === 0) notStripped++;
  }
  // positive control: a CLEAN note from the same feeder must succeed (proves it's the PII, not the path)
  const clean = await rest(`/cases`, { method: 'POST', token: feedTok, body: { ...baseCase, bed: `${TAG}-clean`, note: 'Stable, on IV fluids.' }, prefer: 'return=minimal' });
  check('#1 PII note (CNIC + phone + S/O) REJECTED server-side, not silently stripped, via feeder token',
    rejected === 3 && notStripped === 3 && clean.status === 201,
    `${rejected}/3 rejected with PII_REJECTED; ${notStripped}/3 confirmed NOT inserted; clean note still inserts (${clean.status})`);

  // ══ #2  RLS — yr3 student cannot read a yr5-only case (query AS that user) ═══════
  await rest(`/cases`, { method: 'POST', token: feedTok, body: { ...baseCase, bed: `${TAG}-y5`, matched_years: [5] }, prefer: 'return=minimal' });
  await rest(`/cases`, { method: 'POST', token: feedTok, body: { ...baseCase, bed: `${TAG}-y3`, matched_years: [3] }, prefer: 'return=minimal' });
  const y5 = await rest(`/cases?logged_by=eq.${feedId}&bed=eq.${TAG}-y5&select=id`, { key: SVC, token: SVC });
  const y3 = await rest(`/cases?logged_by=eq.${feedId}&bed=eq.${TAG}-y3&select=id`, { key: SVC, token: SVC });
  const y5id = y5.body?.[0]?.id, y3id = y3.body?.[0]?.id;
  const seeY5 = await rest(`/cases?id=eq.${y5id}&select=id`, { token: stuTok });        // AS the yr3 student
  const seeY3 = await rest(`/cases?id=eq.${y3id}&select=id`, { token: stuTok });
  const cannotY5 = seeY5.ok && Array.isArray(seeY5.body) && seeY5.body.length === 0;
  const canY3    = seeY3.ok && Array.isArray(seeY3.body) && seeY3.body.length === 1;
  check('#2 yr3 student CANNOT read a yr5-only case (and CAN read a yr3 case) — queried as that user',
    cannotY5 && canY3,
    `yr5 rows visible=${Array.isArray(seeY5.body) ? seeY5.body.length : seeY5.status} (want 0); yr3 rows visible=${Array.isArray(seeY3.body) ? seeY3.body.length : seeY3.status} (want 1)`);

  // ══ #3  Role escalation — student cannot self-grant admin OR feeder ═════════════
  const escAdmin = await rest(`/students?id=eq.${stuId}`, { method: 'PATCH', token: stuTok, body: { role: 'admin' }, prefer: 'return=representation' });
  const afterAdmin = await rest(`/students?id=eq.${stuId}&select=role`, { key: SVC, token: SVC });
  const escFeeder = await rest(`/students?id=eq.${stuId}`, { method: 'PATCH', token: stuTok, body: { role: 'feeder' }, prefer: 'return=representation' });
  const afterFeeder = await rest(`/students?id=eq.${stuId}&select=role`, { key: SVC, token: SVC });
  const blockedBoth = !escAdmin.ok && afterAdmin.body?.[0]?.role === 'student' && !escFeeder.ok && afterFeeder.body?.[0]?.role === 'student';
  check('#3 student CANNOT self-escalate role to admin or feeder via direct client call (§5.5 trigger)',
    blockedBoth,
    `→admin: ${escAdmin.status}, role stays '${afterAdmin.body?.[0]?.role}'; →feeder: ${escFeeder.status}, role stays '${afterFeeder.body?.[0]?.role}'`);
  // positive control = the /admin/students page's exact data path: an ADMIN can change the role.
  const adminGrant = await rest(`/students?id=eq.${stuId}`, { method: 'PATCH', token: adminTok, body: { role: 'feeder' }, prefer: 'return=representation' });
  const grantedRole = adminGrant.ok ? adminGrant.body?.[0]?.role : null;
  await rest(`/students?id=eq.${stuId}`, { method: 'PATCH', token: adminTok, body: { role: 'student' }, prefer: 'return=minimal' }); // restore
  check('#3b positive control: an ADMIN CAN change a role (this is exactly what /admin/students does)',
    adminGrant.ok && grantedRole === 'feeder',
    `admin PATCH role→feeder: ${adminGrant.status}, resulting role='${grantedRole}'`);

  // ══ #4  Audit — feeder INSERT produced a create row with correct actor/action ═══
  const auditY5 = await rest(`/case_audit_log?case_id=eq.${y5id}&select=actor,action`, { key: SVC, token: SVC });
  const createRow = Array.isArray(auditY5.body) ? auditY5.body.find((r) => r.action === 'create') : null;
  check('#4 audit log records case INSERT with correct actor + action (§5.2)',
    !!createRow && createRow.actor === feedId,
    `case_audit_log for the yr5 case: action='${createRow?.action}', actor matches feeder=${createRow?.actor === feedId}`);
  console.log(`         ↳ real E2E-case evidence (pre-existing, untouched): ${realEvidence}`);

  // ══ #5  Rate limit — 20 inserts OK, 21st blocked, from one feeder (fresh account) ═
  let ok20 = 0;
  for (let i = 1; i <= 20; i++) {
    const r = await rest(`/cases`, { method: 'POST', token: rlTok, body: { ...baseCase, logged_by: rlId, bed: `${TAG}-RL${i}` }, prefer: 'return=minimal' });
    if (r.status === 201) ok20++;
  }
  const over = await rest(`/cases`, { method: 'POST', token: rlTok, body: { ...baseCase, logged_by: rlId, bed: `${TAG}-RL21` }, prefer: 'return=minimal' });
  const rlBlocked = !over.ok && JSON.stringify(over.body).includes('RATE_LIMITED');
  check('#5 rate limit: 20 inserts/hour succeed, the 21st is blocked (§5.6)',
    ok20 === 20 && rlBlocked,
    `${ok20}/20 inserts accepted; 21st → ${over.status} ${rlBlocked ? '(RATE_LIMITED)' : JSON.stringify(over.body)}`);

  // ══ #6  pg_cron + trigger attachment (SQL-level, via temp RPC) ══════════════════
  const ops = await rest(`/rpc/__verify_ops`, { method: 'POST', key: SVC, token: SVC, body: {} });
  if (ops.status === 404) {
    check('#6 pg_cron expire schedule registered AND has run', false, 'SKIPPED — __verify_ops() RPC not deployed (push migration 0012 first)');
  } else if (!ops.ok) {
    check('#6 pg_cron expire schedule registered AND has run', false, `RPC error ${ops.status}: ${JSON.stringify(ops.body)}`);
  } else {
    const o = ops.body || {};
    const jobs = Array.isArray(o.cron_jobs) ? o.cron_jobs : [];
    const expireJob = jobs.find((j) => j.jobname === 'wardline-expire-cases');
    const purgeJob  = jobs.find((j) => j.jobname === 'wardline-purge-90d');
    const expireRuns = o.expire_run_count ?? 0;
    check('#6 pg_cron expire schedule is registered with the correct cron expression',
      !!expireJob && expireJob.active && expireJob.schedule === '0 2 * * *',
      `expire job: ${expireJob ? `'${expireJob.jobname}' @ '${expireJob.schedule}' active=${expireJob.active}` : 'MISSING'}; purge job: ${purgeJob ? `'${purgeJob.schedule}'` : 'MISSING'}`);
    check('#6b pg_cron expire job has run at least once',
      expireRuns >= 1,
      expireRuns >= 1
        ? `${expireRuns} run(s); latest: ${JSON.stringify((Array.isArray(o.cron_runs) ? o.cron_runs : []).find((r) => r.jobname === 'wardline-expire-cases') || o.cron_runs?.[0] || {})}`
        : `0 runs recorded. db utc-now=${o.utc_now}; next fire 02:00 UTC. Registered+armed but not yet fired (project age).`);
    const trigs = Array.isArray(o.security_triggers) ? o.security_triggers : [];
    const need = ['cases_reject_pii', 'cases_rate_limit', 'cases_audit', 'students_no_role_escalation', 'on_auth_user_created'];
    const present = need.filter((n) => trigs.some((t) => t.trigger === n && (t.enabled === 'O' || t.enabled === 'A')));
    check('#6c all security triggers are attached AND enabled on the live DB',
      present.length === need.length,
      `${present.length}/${need.length} enabled: ${trigs.map((t) => `${t.trigger}(${t.enabled})`).join(', ')}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('VERIFY ERROR:', e.message); process.exitCode = 1; })
  .finally(cleanup);
