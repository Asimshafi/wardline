// scripts/rls-smoke.mjs
// Headless RLS / security smoke test for Wardline (build spec §4, §5).
// Verifies the load-bearing security properties AGAINST the live database via PostgREST +
// GoTrue — never around them. It creates two temporary, pre-confirmed auth users
// (student yr3, feeder yr4), exercises the policies/triggers, prints PASS/FAIL, then
// DELETES everything it created. Secrets come from the environment only (spec §10);
// nothing is printed. Idempotent: only ever touches its own two @example.com test emails.
//
// Run:  set -a && source .env.local && set +a && node scripts/rls-smoke.mjs
// (Dev/staging tool. It signs up + tears down real auth users, so don't point it at a
//  project holding production accounts with those exact test emails.)

const BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE || !SVC || !ANON) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in env.');
  process.exitCode = 1;
}

const STU = { email: 'wardline-smoke-student@example.com', password: 'smoke-Test-123!', full_name: 'Smoke Student', mbbs_year: 3 };
const FDR = { email: 'wardline-smoke-feeder@example.com',  password: 'smoke-Test-123!', full_name: 'Smoke Feeder',  mbbs_year: 4 };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   (' + detail + ')' : ''}`);
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

async function deleteByEmail(email) {
  const list = await gotrue(`/admin/users?per_page=200`, { key: SVC, token: SVC });
  const users = (list.body && list.body.users) || [];
  for (const u of users.filter((x) => x.email === email)) {
    await rest(`/cases?logged_by=eq.${u.id}`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
    await gotrue(`/admin/users/${u.id}`, { method: 'DELETE', key: SVC, token: SVC });
  }
}
async function createUser(u) {
  const r = await gotrue(`/admin/users`, {
    method: 'POST', key: SVC, token: SVC,
    body: { email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.full_name, mbbs_year: u.mbbs_year } },
  });
  if (!r.ok) throw new Error(`create ${u.email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function login(u) {
  const r = await gotrue(`/token?grant_type=password`, { method: 'POST', key: ANON, body: { email: u.email, password: u.password } });
  if (!r.ok) throw new Error(`login ${u.email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

async function main() {
  console.log('— setup: clearing any prior test users —');
  await deleteByEmail(STU.email);
  await deleteByEmail(FDR.email);

  const stuId = await createUser(STU);
  const fdrId = await createUser(FDR);

  // handle_new_user() should have auto-created a student profile, role forced to 'student'
  const prof = await rest(`/students?id=eq.${stuId}&select=role,mbbs_year`, { key: SVC, token: SVC });
  check('signup auto-creates profile as role=student, year 3 (handle_new_user)',
    prof.ok && prof.body[0]?.role === 'student' && prof.body[0]?.mbbs_year === 3,
    JSON.stringify(prof.body?.[0]));

  // service_role (auth.uid() IS NULL) may grant roles — the §5.5 bootstrap path
  const promo = await rest(`/students?id=eq.${fdrId}`, { method: 'PATCH', key: SVC, token: SVC, body: { role: 'feeder' }, prefer: 'return=representation' });
  check('service_role can grant feeder role (bootstrap path, §5.5)', promo.ok && promo.body[0]?.role === 'feeder', `status ${promo.status}`);

  const stuTok = await login(STU);
  const fdrTok = await login(FDR);

  const tax = await rest(`/syllabus_taxonomy?select=id,diagnosis&limit=1`, { key: SVC, token: SVC });
  const taxId = tax.body?.[0]?.id ?? null;
  const dx = tax.body?.[0]?.diagnosis ?? 'Smoke test diagnosis';
  const base = { taxonomy_id: taxId, diagnosis_snapshot: dx, ward: 'Medicine A', bed: '7', note: 'Stable, on IV fluids.', logged_by: fdrId };
  const caseY4 = { ...base, matched_years: [4] };
  const caseY3 = { ...base, bed: '8', matched_years: [3] };

  // a) student cannot INSERT a case (cases_insert_feeder)
  const stuIns = await rest(`/cases`, { method: 'POST', token: stuTok, body: { ...caseY4, logged_by: stuId }, prefer: 'return=representation' });
  check('student INSERT case denied by RLS (cases_insert_feeder)', !stuIns.ok, `status ${stuIns.status}`);

  // b) student cannot escalate own role (students_no_role_escalation trigger)
  const esc = await rest(`/students?id=eq.${stuId}`, { method: 'PATCH', token: stuTok, body: { role: 'admin' }, prefer: 'return=representation' });
  const roleNow = await rest(`/students?id=eq.${stuId}&select=role`, { key: SVC, token: SVC });
  check('student self-role-escalation blocked (§5.5)', !esc.ok && roleNow.body?.[0]?.role === 'student', `status ${esc.status}, role=${roleNow.body?.[0]?.role}`);

  // c) feeder CAN insert a case matching their OWN year (return=minimal — exactly like CaseEntryForm)
  const f4 = await rest(`/cases`, { method: 'POST', token: fdrTok, body: caseY4, prefer: 'return=minimal' });
  check('feeder INSERT own-year (yr4) case succeeds', f4.status === 201, `status ${f4.status}`);

  // …and a case OUTSIDE their own year (yr4 feeder logging a yr3 topic) — the real workflow; must also succeed.
  // NOTE: the app inserts with return=minimal (no .select()). With return=representation this same insert
  // 403s, because PostgREST's RETURNING read-back is filtered by cases_select_matched_year and a yr4 feeder
  // cannot read back a yr3-only row. Keep the feeder insert read-back-free (as CaseEntryForm does).
  const f3 = await rest(`/cases`, { method: 'POST', token: fdrTok, body: caseY3, prefer: 'return=minimal' });
  check('feeder INSERT cross-year (yr3) case succeeds', f3.status === 201, `status ${f3.status}${f3.status === 201 ? '' : ' ' + JSON.stringify(f3.body)}`);

  // resolve the two case ids via service_role (the feeder can't read the yr3 one back)
  const got4 = await rest(`/cases?logged_by=eq.${fdrId}&bed=eq.7&select=id`, { key: SVC, token: SVC });
  const got3 = await rest(`/cases?logged_by=eq.${fdrId}&bed=eq.8&select=id`, { key: SVC, token: SVC });
  const case4 = got4.body?.[0]?.id;
  const case3 = got3.body?.[0]?.id;

  // d) feeder note containing a CNIC is rejected server-side (reject_pii_in_note, §5.1)
  const pii = await rest(`/cases`, { method: 'POST', token: fdrTok, body: { ...caseY4, bed: '9', note: 'Admitted; CNIC 35202-1234567-8' }, prefer: 'return=minimal' });
  check('feeder INSERT with CNIC note rejected server-side (§5.1)', !pii.ok && JSON.stringify(pii.body).includes('PII_REJECTED'), `status ${pii.status}`);

  // e) student (yr3) cannot READ the year-4 case
  const see4 = await rest(`/cases?id=eq.${case4}&select=id`, { token: stuTok });
  check('student (yr3) CANNOT read year-4 case (cases_select_matched_year)', see4.ok && Array.isArray(see4.body) && see4.body.length === 0, `rows ${Array.isArray(see4.body) ? see4.body.length : see4.status}`);

  // f) student (yr3) CAN read a year-3 case → proves matching, not blanket-deny
  const see3 = await rest(`/cases?id=eq.${case3}&select=id`, { token: stuTok });
  check('student (yr3) CAN read year-3 case', see3.ok && Array.isArray(see3.body) && see3.body.length === 1, `rows ${Array.isArray(see3.body) ? see3.body.length : see3.status}`);

  // g) anonymous cannot read cases at all
  const anon = await rest(`/cases?select=id`, { key: ANON, token: ANON });
  check('anon CANNOT read cases', anon.status === 401 || (Array.isArray(anon.body) && anon.body.length === 0), `status ${anon.status}`);

  // h) the feeder insert was audited (§5.2), visible to service_role
  const audit = await rest(`/case_audit_log?case_id=eq.${case4}&select=action`, { key: SVC, token: SVC });
  check('feeder INSERT is audited (§5.2)', audit.ok && Array.isArray(audit.body) && audit.body.some((r) => r.action === 'create'), JSON.stringify(audit.body));

  console.log('— teardown: deleting test cases and users —');
  await rest(`/cases?logged_by=eq.${fdrId}`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
  await rest(`/cases?logged_by=eq.${stuId}`, { method: 'DELETE', key: SVC, token: SVC, prefer: 'return=minimal' });
  await gotrue(`/admin/users/${fdrId}`, { method: 'DELETE', key: SVC, token: SVC });
  await gotrue(`/admin/users/${stuId}`, { method: 'DELETE', key: SVC, token: SVC });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exitCode = 1;   // exitCode (not exit()) → clean socket drain on Windows
}

main().catch((e) => { console.error('SMOKE TEST ERROR:', e.message); process.exitCode = 1; });
