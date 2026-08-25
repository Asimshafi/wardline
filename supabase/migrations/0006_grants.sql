-- 0006_grants.sql
-- Table-level GRANTs for the Supabase API roles (build spec §4 groundwork).
--
-- WHY THIS EXISTS: 0001 creates the tables and 0002 enables RLS + writes policies,
-- but Postgres checks *table-level* privileges BEFORE it ever evaluates an RLS policy.
-- Our migrations relied on Supabase's automatic default-privileges to grant the API
-- roles (anon/authenticated/service_role) access to new tables — and on this project
-- that did not happen, so every PostgREST call (the seed, and the whole app) failed with
--   42501  permission denied for table ...
-- This migration issues those grants explicitly, so they are versioned and reproducible
-- rather than a one-off dashboard click. RLS (0002) remains the row-level security
-- boundary; these grants are only the coarse layer beneath it.
--
-- PRINCIPLE: least privilege for `authenticated` — each grant below has a matching RLS
-- policy in 0002. `anon` gets NO table privileges (every policy targets `authenticated`
-- only; unauthenticated users never touch these tables — auth goes through GoTrue).
-- `service_role` is the trusted bypass role (seed script, notify Edge Function, pg_cron
-- purge) and gets full access.

-- Schema usage (Supabase default; harmless for anon, which holds no object privileges here).
grant usage on schema public to anon, authenticated, service_role;

-- ── service_role: trusted bypass role — full access ──────────────────────────
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- ── authenticated: least privilege, one grant per RLS policy in 0002 ─────────
-- syllabus_taxonomy — taxonomy_read (select) + taxonomy_write_admin (for all, admin-gated in RLS)
grant select, insert, update, delete on syllabus_taxonomy to authenticated;
-- students — students_select_self (select) + students_update_self/_admin (update). No insert/delete policy.
grant select, update on students to authenticated;
-- cases — cases_select_matched_year (select) + cases_insert_feeder (insert) + cases_update_feeder (update). No delete policy.
grant select, insert, update on cases to authenticated;
-- case_audit_log — audit_admin_read (select only); writes are trigger-only (SECURITY DEFINER).
grant select on case_audit_log to authenticated;
-- notifications_sent — notifications_self_read (select only); writes are service_role.
grant select on notifications_sent to authenticated;

-- ── Future-proofing: never silently ship a table without grants again ────────
-- Objects created by later migrations (run as this role) auto-grant to service_role.
-- We deliberately do NOT set default privileges for `authenticated`: each new table
-- should force a conscious least-privilege grant decision (the forcing function that
-- would have caught the omission above).
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
