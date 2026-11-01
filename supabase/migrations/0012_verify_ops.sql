-- 0012_verify_ops.sql
-- Read-only production-verification RPC for scripts/prod-verify.mjs.
--
-- Returns cron jobs, run counts, and security trigger states.
-- Trigger list includes exactly five wardline-relevant triggers across schemas.
--
-- Read-only: SELECT only. No secrets or patient data.
-- SECURITY DEFINER: runs as the function owner (postgres).
-- service_role-only: clients never call this directly.

create or replace function public.__verify_ops()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_utc_now     timestamptz := now();
  v_jobs        jsonb := '[]'::jsonb;
  v_runs        jsonb := '[]'::jsonb;
  v_expire_runs int  := 0;
  v_triggers    jsonb := '[]'::jsonb;
  v_has_cron    boolean;
begin
  -- ── pg_cron metadata (safe if schema absent) ───────────────────────────────
  v_has_cron := exists (select 1 from pg_namespace where nspname = 'cron');

  if v_has_cron then
    select coalesce(jsonb_agg(to_jsonb(j)), '[]'::jsonb)
      into v_jobs
    from (
      select jobname, schedule, active
      from cron.job
      where jobname like 'wardline%'
      order by jobname
    ) j;

    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_runs
    from (
      select j2.jobname, r.status, r.start_time, r.end_time
      from cron.job j2
      join cron.job_run_details r on r.jobid = j2.jobid
      where j2.jobname = 'wardline-expire-cases'
      order by r.runid desc
      limit 20
    ) r;

    select count(*)::int
      into v_expire_runs
    from cron.job_run_details r
    join cron.job j2 on r.jobid = j2.jobid
    where j2.jobname = 'wardline-expire-cases';
  end if;

  -- ── Security trigger states (exactly five triggers) ────────────────────────
  --   cases_reject_pii, cases_rate_limit, cases_audit  → public.cases
  --   students_no_role_escalation                       → public.students
  --   on_auth_user_created                              → auth.users
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_triggers
  from (
    select
      t.tgname   as trigger,
      c.relname  as "table",
      t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where
      (
        (
          n.nspname = 'public'
          and c.relname = 'cases'
          and t.tgname in (
            'cases_reject_pii',
            'cases_rate_limit',
            'cases_audit'
          )
        )
        or
        (
          n.nspname = 'public'
          and c.relname = 'students'
          and t.tgname = 'students_no_role_escalation'
        )
        or
        (
          n.nspname = 'auth'
          and c.relname = 'users'
          and t.tgname = 'on_auth_user_created'
        )
      )
      and not t.tgisinternal
    order by t.tgname
  ) t;

  return jsonb_build_object(
    'utc_now',          v_utc_now,
    'cron_jobs',        v_jobs,
    'expire_run_count', v_expire_runs,
    'cron_runs',        v_runs,
    'security_triggers', v_triggers
  );
end $$;

-- Keep the surface minimal: clients never call this directly.
revoke all on function public.__verify_ops() from public;
grant execute on function public.__verify_ops() to service_role;
