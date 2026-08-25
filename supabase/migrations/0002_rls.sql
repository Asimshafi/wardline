-- 0002_rls.sql
-- Row Level Security (build spec §4). RLS is enabled BEFORE any app code runs.
--
-- ⚠ CORRECTNESS FIX vs the spec: the spec's policies query `students` inline, e.g.
--   exists (select 1 from students s where s.id = auth.uid() and s.role = 'admin')
-- The students SELECT policy ITSELF contains such a subquery over students, so Postgres
-- would raise "infinite recursion detected in policy for relation students". We route
-- every role/year lookup through SECURITY DEFINER helpers that bypass RLS. This also
-- avoids re-planning the subquery per row (a well-known Supabase RLS performance trap),
-- and we wrap auth.uid() in (select …) so it is evaluated once, not per row.

-- ── SECURITY DEFINER helpers (own the RLS recursion break) ───────────────────
create or replace function public.auth_role()
returns text
language sql stable security definer set search_path = public
as $$ select role from public.students where id = (select auth.uid()); $$;
comment on function public.auth_role() is
  'App role (student|feeder|admin) of the current user, read bypassing RLS to avoid recursive policy evaluation.';

create or replace function public.auth_mbbs_year()
returns smallint
language sql stable security definer set search_path = public
as $$ select mbbs_year from public.students where id = (select auth.uid()); $$;

revoke all on function public.auth_role()      from public;
revoke all on function public.auth_mbbs_year() from public;
grant execute on function public.auth_role()      to authenticated, anon, service_role;
grant execute on function public.auth_mbbs_year() to authenticated, anon, service_role;

-- ── Enable RLS on every table (spec §4: before a single line of app code) ────
alter table syllabus_taxonomy  enable row level security;
alter table students           enable row level security;
alter table cases              enable row level security;
alter table case_audit_log     enable row level security;
alter table notifications_sent enable row level security;

-- ── Taxonomy: any authenticated user reads; only admin writes ────────────────
create policy taxonomy_read on syllabus_taxonomy
  for select to authenticated
  using (true);

create policy taxonomy_write_admin on syllabus_taxonomy
  for all to authenticated
  using (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');

-- ── Students: self read/update; admin reads & updates all ────────────────────
create policy students_select_self on students
  for select to authenticated
  using (id = (select auth.uid()) or public.auth_role() = 'admin');

-- Self-update of your own row. NOTE: this policy alone cannot stop a user rewriting
-- their own role column (RLS WITH CHECK can't compare OLD vs NEW), so the actual
-- guard is the students_no_role_escalation trigger in 0003. (Spec §5.5.)
create policy students_update_self on students
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Admin updates any student row — this is the ONLY path that grants feeder/admin (§5.5).
create policy students_update_admin on students
  for update to authenticated
  using (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');
-- (No client INSERT/DELETE policy: profiles are created by handle_new_user() in 0003.)

-- ── Cases: feeders/admins insert; matched-year students read; no hard delete ─
create policy cases_insert_feeder on cases
  for insert to authenticated
  with check (
    public.auth_role() in ('feeder','admin')
    and logged_by = (select auth.uid())      -- [FIX vs spec] can't attribute a case to another user
  );

create policy cases_select_matched_year on cases
  for select to authenticated
  using (
    public.auth_role() = 'admin'
    or public.auth_mbbs_year() = any (matched_years)
  );

create policy cases_update_feeder on cases
  for update to authenticated
  using (public.auth_role() in ('feeder','admin'))
  with check (public.auth_role() in ('feeder','admin'));
-- Core columns are frozen post-insert by cases_freeze_immutable (0003).
-- There is deliberately NO delete policy → authenticated/anon cannot hard-delete.
-- The retention purge (§5.9) runs as service_role, which bypasses RLS.

-- ── Audit log: admin read only; writes are trigger-only ──────────────────────
create policy audit_admin_read on case_audit_log
  for select to authenticated
  using (public.auth_role() = 'admin');

-- ── Notifications: a student sees only their own history ─────────────────────
create policy notifications_self_read on notifications_sent
  for select to authenticated
  using (student_id = (select auth.uid()));
-- The notify Edge Function writes these as service_role (bypasses RLS).
