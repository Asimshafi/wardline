# Wardline — full stack (DB + frontend)

The database foundation (spec §3–§5) was confirmed first; the frontend, auth, and
Telegram Edge Function (spec §6–§8) are now built on top of it. The schema and RLS are
the load-bearing part — everything in `/app` runs *against* RLS, never around it.

```
supabase/migrations/
  0001_init.sql        tables, indexes, extensions            (§3)
  0002_rls.sql         RLS + SECURITY DEFINER role helpers     (§4)
  0003_triggers.sql    audit, PII reject, rate-limit, immutability, role guard, expire/purge (§5)
  0004_schedules.sql   pg_cron: daily expire + 90-day purge    (§5.3, §5.9)
  0005_search.sql      search_taxonomy() RPC: FTS + trigram    (§6, §7)
  0006_grants.sql      table GRANTs for anon/authenticated/service_role (§4 groundwork)
  0007_signup_domain.sql  server-side college-email signup gate (§5.4); ships disabled
  0008_webhook_trigger.sql pg_net trigger: cases INSERT → notify-on-case (bypasses Dashboard webhooks) (§8)
  0009–0011 (webhook secret)  one-time diagnostic + secret rotation that verified §8; temp helpers dropped by 0011
supabase/functions/
  notify-on-case/      Deno Edge Function → Telegram; fired by the 0008 pg_net trigger on cases INSERT (§8)
scripts/
  seed-taxonomy.mjs    one-time CSV → syllabus_taxonomy loader (§9.2)
  rls-smoke.mjs        headless RLS/security regression test — 11 checks (§4, §5)
  wh-e2e.mjs           one-shot Telegram delivery test: cases INSERT → 0008 trigger → function → TG
lib/
  supabase/            browser + server + middleware clients (see deviation below)
  env.ts matching.ts time.ts types.ts
app/
  feed/ feeder/ account/ admin/{taxonomy,students}/ auth/{login,callback,signout}/
components/            Nav, LoginForm, CaseEntryForm, CaseFeed, CaseCard, *Admin, AccountForm
middleware.ts          role-gating: protects /feed /feeder /admin /account
.env.example           required env vars (copy → .env.local)
```

The taxonomy source is `../Downloads/wardline_master_taxonomy.csv`: **1,268 rows**, years
1–5 (72 / 138 / 277 / 448 / 333). The two CSV copies in Downloads are byte-identical.

---

## Tooling status

Installed and verified on this machine:

- **Node.js** v24.19.0 + **npm** 11.17.0 — frontend, seed script, tooling
- **Supabase CLI** 2.115.0 (scoop) — `supabase db push`, functions deploy
- **Deno** — *not installed*; optional, only needed to run `notify-on-case` locally
  (`supabase functions deploy` bundles it server-side, so it's not required to ship)

`npm install` has been run (deps + `package-lock.json` present).

---

## Confirmed decisions

**Decision 1 — PII rejection is high-precision (§5.1). [confirmed]**
`reject_pii_in_note()` hard-blocks only high-precision patterns: CNIC, phone / 10+ digit runs,
email, labelled MRN/registration numbers, relational markers (`S/O D/O W/O B/O`, "baby of"),
and `title + Name` (Mr/Mrs/Ms/Miss/Master). It intentionally does **not** block generic
"two capitalised words" — that would reject legitimate notes (drug names, "Left Lower Lobe",
eponymous diseases like "Crohn Disease") and train feeders to fight the form. It rejects rather
than silently strips (§5.1), and the client shows a soft warning before submit as a courtesy.

**Decision 2 — data retention window: 90 days (§5.9). [confirmed]**
Both `cases` and `case_audit_log` are purged daily by `purge_expired_data(90)`.

**Decision 3 — signup requires `mbbs_year` in metadata. [confirmed]**
`students.mbbs_year` is `NOT NULL` (per §3), and profiles are auto-created on signup by
`handle_new_user()`. The signup form passes `full_name` and `mbbs_year` as auth user-metadata.
Year is admin-managed after signup (the account page shows it read-only) to keep year→case
matching honest; only an admin can change a student's year or role.

**Decision 4 — no `expire-cases` Edge Function.** The spec's app tree lists one, but expiry is
pure SQL, so I schedule `expire_old_cases()` directly with pg_cron (0004) — cheaper, simpler,
one less deploy target. The `notify-on-case` Edge Function is still needed (Telegram HTTP call).

## Corrections & additions vs the literal spec

- **RLS recursion (correctness bug in the spec).** The spec's policies query `students`
  inline; the `students` SELECT policy doing so would raise *"infinite recursion detected in
  policy for relation students."* Fixed with SECURITY DEFINER helpers `auth_role()` /
  `auth_mbbs_year()` that bypass RLS. This also fixes the §5.5 hole the spec flagged: role
  self-escalation is now blocked by `students_no_role_escalation` (only an admin can change a
  role), and there is no client INSERT path to self-assign a role at signup.
- **`auth.uid()` wrapped in `(select …)`** in every policy — the standard Supabase per-row
  re-evaluation performance fix.
- **`cases_insert_feeder` also enforces `logged_by = auth.uid()`** — the spec let a feeder
  attribute a case to another user.
- **Immutable case columns** (`taxonomy_id, diagnosis_snapshot, logged_by, matched_years,
  created_at`) are frozen on UPDATE, so an "update status" can't silently rewrite history.
- **Rate-limit / audit run as SECURITY DEFINER** so counts and logs aren't distorted by the
  caller's RLS view.
- **`[ADD]`-tagged schema extras** (see comments in 0001): trigram indexes, `matched_years`
  GIN index, `notifications_sent` unique(case,student,channel) + `created_at`/`error`, FK
  `on delete` behaviours, `matched_years` non-empty check, `telegram_chat_id` unique.
- **Table GRANTs were missing — fixed in `0006_grants.sql`.** 0001 creates the tables and
  0002 enables RLS + policies, but nothing granted the API roles *table-level* privileges;
  we relied on Supabase's automatic default-privileges, which did not apply on this project,
  so every PostgREST call (the seed, and the whole app) failed with `42501 permission denied
  for table …` *before* RLS was ever consulted. 0006 grants least-privilege access to
  `authenticated` (one grant per policy in 0002), full access to `service_role` (the trusted
  bypass role), and **nothing to `anon`** (every policy targets `authenticated`). RLS remains
  the row-level gate; grants are only the coarse layer beneath it.
- **`return=minimal` on the feeder insert is load-bearing.** `CaseEntryForm` inserts without
  `.select()`, so PostgREST issues no `RETURNING` read-back. With `return=representation`, a
  feeder logging a case *outside their own year* would get `42501` — the returned row is
  filtered by `cases_select_matched_year`, which a feeder can't satisfy for another year's
  case. Do not add `.select()` to that insert. (Both behaviours are asserted by the smoke test.)

## Frontend & Edge Function (§6–§8)

- **`lib/supabase/` is a folder, not the single `lib/supabase.ts` the spec sketches.** The SSR
  helper splits into three clients that must not be bundled together: `client.ts`
  (`'use client'`, browser), `server.ts` (uses `next/headers` `cookies()` — server-only, would
  break a client bundle), and `middleware.ts` (request/response cookie plumbing for the Edge
  runtime). Importing a `next/headers` module into a client component is a build error, so the
  split is required, not stylistic.
- **`0005_search.sql` adds a `search_taxonomy()` RPC** the feeder form calls (via
  `lib/matching.ts`). It groups the 1,268 rows by distinct diagnosis, **unions the years** a
  diagnosis spans into one `matched_years` array, and ranks FTS > diagnosis-ilike > synonym-ilike
  with a pg_trgm similarity tiebreak. Returning one row per diagnosis (not per year) is what lets
  a single logged case notify every relevant year at once.
- **`NEXT_PUBLIC_COLLEGE_EMAIL_DOMAIN`** pre-fills the login placeholder and shows a soft "use
  your college email" warning — a **client hint only**. The real enforcement is server-side in
  `0007_signup_domain.sql`: a `before insert` trigger on `auth.users` rejects out-of-domain
  emails (self-signup *and* the admin API), reading the allow-list from `public.app_config`. It
  ships **disabled** (empty allow-list = no-op); activate it with one SQL `update` once you know
  the real domain (§5.4). Leave the `NEXT_PUBLIC_` var blank to also drop the client hint.
- **Role gating is defence-in-depth.** `middleware.ts` redirects unauthenticated users off
  `/feed /feeder /admin /account` and non-feeders/non-admins off `/feeder` and `/admin`, but the
  real enforcement is RLS + the role trigger — the middleware is UX, not the security boundary.
- **Telegram linking is self-service via chat ID.** The account page takes a numeric chat ID
  (from `@userinfobot`) rather than running an inbound bot webhook; `notify-on-case` only sends.
  Students opt in and can unlink by clearing the field.

## Dependency security posture (Next.js) + tracked follow-up

`next` was bumped from the originally-pinned `14.2.15` to **`^14.2.35`** (latest maintained
14.x). That clears the **critical** advisories and — importantly, since we role-gate in
`middleware.ts` — the **middleware authorization-bypass** CVE (`GHSA-f82v-jwr5-mffw` /
CVE-2025-29927, fixed in 14.2.25).

Two **high** advisories remain, both only fixed by a breaking jump to Next 16. They were mapped
against this codebase before deciding to ship on 14.x:

- **7 of the residual `next` advisories don't apply** — they require Server Actions, custom
  servers, `rewrites`, Pages-Router + i18n, or WebSocket upgrades. This app uses none of those
  (`"use server"` = 0 matches; `next.config.mjs` sets only `reactStrictMode` + `images`).
- **Image Optimization DoS** (`GHSA-h64f-5h5j-jqjh`) is neutralized by `images: { unoptimized:
  true }` in `next.config.mjs` — we use no `next/image`, so the `/_next/image` endpoint is off.
- **RSC-response cache poisoning / cache confusion** (`wfc6`, `68g3`, `4633`) is low-exposure:
  every sensitive route is `export const dynamic = "force-dynamic"` and authenticated, so
  responses aren't shared-cacheable. This class is the main reason for the follow-up below.
- **postcss `<=8.5.22`** (transitive under Next's build tooling) is **build-time only** —
  source-map path traversal / CSS-stringify XSS on attacker-controlled CSS. We compile only our
  own Tailwind + `globals.css`, so runtime exposure is zero.

> **TODO (fast-follow, not a launch blocker): upgrade to Next 16.** `npm audit fix --force`
> targets `next@16.3.2`, which also requires **React 19** and an **async `cookies()`** refactor
> in `lib/supabase/server.ts` (`const cookieStore = await cookies()`), plus a full retest of
> auth/middleware. Doing it now, blind and pre-launch, carries more risk than the low residual
> exposure above. Schedule it once the app is live and smoke-tested.

## Apply & verify

```bash
supabase init
supabase link --project-ref YOUR_REF
supabase db push                 # applies 0001–0008 in order
# enable pg_cron in Dashboard → Database → Extensions if 0004 errors
cp .env.example .env.local       # fill in real values (git-ignored)
npm install                      # installs next/react/@supabase/ssr etc.
npm run seed                     # reads keys from env; refuses if already seeded
npm run smoke                    # headless RLS regression test (creates + tears down 2 temp users)
npm run dev                      # http://localhost:3000
```

Then smoke-test RLS *against* it (not around it). `npm run smoke` (`scripts/rls-smoke.mjs`)
does this headlessly — it signs up a temporary student (yr3) and feeder (yr4) via the admin
API, then asserts 11 properties and deletes everything it created:

- signup auto-creates a `student` profile (role can't be self-set); only `service_role`/SQL
  can grant roles; a student **cannot** self-escalate role, insert a case, or read an
  off-year case, but **can** read a matched-year case; a feeder **can** insert (including a
  case outside their own year); a CNIC note is **rejected** server-side; `anon` reads nothing;
  every insert is audited.

## Deploy (§8, §9)

1. **Frontend → Vercel.** Import the repo; set the same env vars (`NEXT_PUBLIC_*` +, if you use
   the seed step in CI, the service-role key). `SUPABASE_SERVICE_ROLE_KEY` / `TELEGRAM_BOT_TOKEN`
   must **never** be `NEXT_PUBLIC_` (§5.7).
2. **Auth URLs + domain gate.** Dashboard → Authentication → URL Configuration: set the site URL
   / redirect URLs to your Vercel domain + `/auth/callback`. Then activate the §5.4 signup gate
   (already installed by `0007`) from the SQL editor once you know the real domain:

   ```sql
   update public.app_config set value = 'students.yourcollege.edu.pk'
   where key = 'signup_allowed_email_domains';   -- comma-separate for multiple domains
   ```
3. **Edge Function.** `supabase functions deploy notify-on-case`, then
   `supabase secrets set TELEGRAM_BOT_TOKEN=… WEBHOOK_SECRET=…` (SUPABASE_URL and service-role
   key are injected by the platform).
4. **Wire cases INSERT → the function (migration `0008`, not the Dashboard).** The Dashboard's
   "Database Webhooks" feature fails on this project — it wires triggers to
   `supabase_functions.http_request()`, but that internal schema was never provisioned here
   (`ERROR 3F000: schema "supabase_functions" does not exist`; enabling `pg_net` alone doesn't
   create it). Instead `0008_webhook_trigger.sql` installs an `after insert` trigger on
   `public.cases` that calls the function directly via `pg_net` (`net.http_post`) — the same
   mechanism a webhook uses, sending the same `{type,table,record}` payload + `x-webhook-secret`
   header. The shared secret is **not** in the migration (§5.7/§10); it's read at fire-time from
   Supabase Vault. Store it once from the SQL editor (must equal the function's `WEBHOOK_SECRET`):

   ```sql
   select vault.create_secret('<your WEBHOOK_SECRET>', 'wardline_webhook_secret',
                              'x-webhook-secret header for notify-on-case');
   ```

   The trigger fires only for `status = 'admitted'` rows; the function is idempotent on retries via
   `notifications_sent unique(case_id, student_id, channel)`; and a notify failure can never roll
   back the case insert (the trigger body is exception-guarded, best-effort).

## Execution status

Verified against the live project (`dqzwrcaguwzaoiqhicor`) on 2026-08-24:

- **Migrations 0001–0011 applied** (`supabase db push`, incl. 0006 grants, the 0007 signup gate, and the 0008 pg_net webhook trigger; 0009–0011 were a one-time secret diagnostic + rotation, helpers dropped by 0011). pg_cron OK.
- **Taxonomy seeded**: 1,268 rows, distribution 72 / 138 / 277 / 448 / 333 for years 1–5 (verified).
- **RLS smoke test: 11/11 passing** (`npm run smoke`), temp users torn down, DB left clean.
- **§5.4 signup gate verified** (`0007`): ships disabled; a temporary toggle proved out-of-domain
  signup is rejected (`500`) and in-domain accepted (`200`), then reset to disabled; smoke re-run 11/11.
- **Telegram delivery verified end-to-end**: a `service_role` `cases` INSERT fired the `0008` trigger →
  `net.http_post` (`x-webhook-secret` read from the Vault secret `wardline_webhook_secret`) →
  `notify-on-case` (200) → Telegram, and `notifications_sent` flipped `pending → sent` (throwaway
  recipient + case torn down after). `WEBHOOK_SECRET` was **regenerated** so the function secret and
  the Vault secret match byte-for-byte — a paste-time mismatch had made the function 401 its own call.
- **Dev server**: `npm run dev` serves on :3000; `/` → `/feed`, `/feed` (unauth) → `/auth/login`,
  `/auth/login` renders 200 — middleware auth-gating and the SSR Supabase client both work.

Still to do (deploy, §8/§9): promote the **first real admin** (see below); deploy the frontend to
Vercel; set the Auth redirect URLs; and **activate** the §5.4 signup gate (one SQL `update` — the
mechanism is already deployed in `0007`) once the real college domain is known. The notify pipeline
is fully wired and verified: `notify-on-case` is deployed (`verify_jwt=false`, `TELEGRAM_BOT_TOKEN`
+ `WEBHOOK_SECRET` set), `0008` wires `cases` INSERT → it via pg_net, and the Vault secret matches.

**First-admin bootstrap.** Everyone signs up as `student`; the role trigger lets only an admin
(or a null-`auth.uid()` context — `service_role`/SQL editor) grant roles. After the real admin
signs up, promote them once from the Dashboard SQL editor:

```sql
update public.students set role = 'admin'
where id = (select id from auth.users where email = 'you@your-college.edu');
```

That admin then manages every other role/year from `/admin/students`.

> **Security note — resolved.** The `service_role` key used during setup was **rotated on
> 2026-08-24** (Dashboard → Project Settings → API → reset), the old exposed key **deleted**, and
> `.env.local` updated with the new secret (now Supabase's `sb_secret_…` format). Verified: the new
> key authenticates against PostgREST and the anon key is unchanged. **At deploy, set the *new*
> key** in Vercel/Supabase env vars — never as a `NEXT_PUBLIC_` var (§5.7).
