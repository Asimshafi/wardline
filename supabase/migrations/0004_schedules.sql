-- 0004_schedules.sql
-- Scheduled jobs (build spec §5.3 auto-expire, §5.9 retention).
--
-- Requires the pg_cron extension. On Supabase: Dashboard → Database → Extensions →
-- enable "pg_cron" (free tier supports it). This runs pure SQL functions on a schedule,
-- so NO separate "expire-cases" Edge Function is needed — see README "Decision 4".
--
-- Times are UTC. Idempotent: re-running will not create duplicate jobs.
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'wardline-expire-cases') then
    perform cron.schedule('wardline-expire-cases', '0 2 * * *', $q$ select public.expire_old_cases(); $q$);
  end if;

  if not exists (select 1 from cron.job where jobname = 'wardline-purge-90d') then
    -- Data retention: 90 days (§5.9). Change the argument here + document it if you alter it.
    perform cron.schedule('wardline-purge-90d', '0 3 * * *', $q$ select public.purge_expired_data(90); $q$);
  end if;
end $$;
