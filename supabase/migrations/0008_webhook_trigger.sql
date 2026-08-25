-- 0008_webhook_trigger.sql
-- Wire public.cases INSERT → the notify-on-case Edge Function WITHOUT Supabase's Dashboard
-- "Database Webhooks" feature. That feature wires triggers to supabase_functions.http_request(),
-- but the internal `supabase_functions` schema was never provisioned on this project, so the
-- dashboard errors with `3F000: schema "supabase_functions" does not exist`. We call the Edge
-- Function directly with pg_net (net.http_post) — the same mechanism, under our control.
--
-- SECRET IS NOT HARDCODED (spec §5.7/§10). The x-webhook-secret is read at fire-time from
-- Supabase Vault. Store it ONCE from the SQL editor (your real value; never commit it):
--
--   select vault.create_secret('<your WEBHOOK_SECRET>', 'wardline_webhook_secret',
--                              'x-webhook-secret header for the notify-on-case Edge Function');
--   -- if the name already exists, rotate with:
--   -- select vault.update_secret((select id from vault.secrets where name='wardline_webhook_secret'),
--   --                            '<new value>');

-- Prerequisites (idempotent). pg_net = async HTTP from Postgres; supabase_vault = encrypted secret store.
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Diagnostic: prints what this project actually has (visible in `supabase db push` output).
do $$
begin
  raise notice 'pg_net (net) present:               %', exists (select 1 from pg_namespace where nspname = 'net');
  raise notice 'supabase_functions schema present:  %', exists (select 1 from pg_namespace where nspname = 'supabase_functions');
  raise notice 'supabase_vault (vault) present:     %', exists (select 1 from pg_namespace where nspname = 'vault');
end $$;

create or replace function public.notify_case_inserted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fn_url text := 'https://dqzwrcaguwzaoiqhicor.supabase.co/functions/v1/notify-on-case';
  secret text;
begin
  -- Best-effort: a notification failure must NEVER roll back the case insert.
  begin
    select decrypted_secret into secret
    from vault.decrypted_secrets
    where name = 'wardline_webhook_secret'
    limit 1;

    if secret is null then
      raise warning 'notify_case_inserted: vault secret "wardline_webhook_secret" not set; skipping notify for case %', new.id;
      return new;
    end if;

    perform net.http_post(
      url     := fn_url,
      body    := jsonb_build_object('type', 'INSERT', 'table', 'cases', 'record', to_jsonb(new)),
      headers := jsonb_build_object(
                   'Content-Type',     'application/json',
                   'x-webhook-secret', secret
                 ),
      timeout_milliseconds := 5000
    );
  exception when others then
    raise warning 'notify_case_inserted: notify failed for case % (%): %', new.id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

-- Fire only on a fresh admission (mirrors the function's own filter — avoids pointless HTTP calls).
drop trigger if exists notify_case_inserted on public.cases;
create trigger notify_case_inserted
  after insert on public.cases
  for each row
  when (new.status = 'admitted')
  execute function public.notify_case_inserted();

-- The trigger runs as its definer; clients never call this directly.
revoke execute on function public.notify_case_inserted() from public;
