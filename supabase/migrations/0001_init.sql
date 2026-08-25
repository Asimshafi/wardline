-- 0001_init.sql
-- Wardline core schema (build spec §3).
-- Applied first. Faithful to §3, with additions marked [ADD] and explained in README.md.
-- Every "if not exists" makes re-running during development safe.

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;     -- [ADD] trigram fuzzy search for /lib/matching.ts (§6)

-- ── Syllabus taxonomy ────────────────────────────────────────────────────────
-- Seeded once from wardline_master_taxonomy.csv; rarely written after (§3).
create table if not exists syllabus_taxonomy (
  id           uuid primary key default gen_random_uuid(),
  diagnosis    text not null,
  synonyms     text,                 -- ';'-separated in the source CSV
  subject_area text,
  module       text,
  theme        text,
  year         smallint not null check (year between 1 and 5),
  created_at   timestamptz not null default now()
);

-- Full-text search over diagnosis + synonyms (spec §3, verbatim expression).
create index if not exists idx_taxonomy_fts
  on syllabus_taxonomy using gin (to_tsvector('english', diagnosis || ' ' || coalesce(synonyms, '')));

-- [ADD] Trigram indexes back the ilike/similarity fallback in matching.ts (§6).
create index if not exists idx_taxonomy_diagnosis_trgm
  on syllabus_taxonomy using gin (diagnosis gin_trgm_ops);

create index if not exists idx_taxonomy_year on syllabus_taxonomy (year);

-- ── Students ─────────────────────────────────────────────────────────────────
-- Profile row is auto-created on signup by public.handle_new_user() (see 0003),
-- which always forces role='student'. There is deliberately NO client INSERT policy.
create table if not exists students (
  id               uuid primary key references auth.users(id) on delete cascade,
  full_name        text not null,
  mbbs_year        smallint not null check (mbbs_year between 1 and 5),
  telegram_chat_id text unique,       -- [ADD] unique: one Telegram account ↔ one student. null until linked (§8)
  opted_in         boolean not null default true,
  role             text not null default 'student' check (role in ('student','feeder','admin')),
  created_at       timestamptz not null default now()
);

-- ── Cases (the admissions log) ───────────────────────────────────────────────
create table if not exists cases (
  id                 uuid primary key default gen_random_uuid(),
  taxonomy_id        uuid references syllabus_taxonomy(id) on delete set null,  -- [ADD] set null: snapshot survives taxonomy delete
  diagnosis_snapshot text not null,           -- denormalized copy; survives taxonomy edits (§3)
  ward               text not null,
  bed                text not null,
  note               text,                    -- server-validated in 0003 (§5.1); NO patient identifiers
  status             text not null default 'admitted' check (status in ('admitted','discharged')),
  logged_by          uuid not null references students(id),
  matched_years      smallint[] not null check (cardinality(matched_years) >= 1),  -- [ADD] must match ≥1 year (cardinality: array_length is NULL on '{}')
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  auto_expire_at     timestamptz not null default (now() + interval '7 days')
);

create index if not exists idx_cases_status         on cases (status);
create index if not exists idx_cases_created         on cases (created_at desc);
create index if not exists idx_cases_logged_by       on cases (logged_by);                    -- [ADD] rate-limit counting (§5.6)
create index if not exists idx_cases_matched_years   on cases using gin (matched_years);       -- [ADD] RLS: mbbs_year = any(matched_years)
create index if not exists idx_cases_auto_expire     on cases (auto_expire_at) where status = 'admitted';  -- [ADD] expiry scan (§5.3)

-- ── Case audit log ───────────────────────────────────────────────────────────
-- Written ONLY by the SECURITY DEFINER trigger in 0003; admin-readable (see 0002).
create table if not exists case_audit_log (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid references cases(id) on delete set null,     -- [ADD] set null: audit row outlives a purged case
  actor          uuid references students(id) on delete set null,
  action         text not null check (action in ('create','update','update_status','delete')),
  changed_fields jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_audit_case    on case_audit_log (case_id);
create index if not exists idx_audit_created  on case_audit_log (created_at desc);

-- ── Notifications sent ───────────────────────────────────────────────────────
create table if not exists notifications_sent (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid references cases(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  channel    text not null default 'telegram',
  status     text not null default 'pending' check (status in ('pending','sent','failed')),
  error      text,                          -- [ADD] failure reason, for the "debug" purpose in §3
  created_at timestamptz not null default now(),  -- [ADD] for rate-limit / debugging
  sent_at    timestamptz,
  unique (case_id, student_id, channel)      -- [ADD] idempotency: webhook retries can't double-send
);
create index if not exists idx_notifications_student on notifications_sent (student_id);
create index if not exists idx_notifications_case    on notifications_sent (case_id);
