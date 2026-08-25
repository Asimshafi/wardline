-- 0010_wh_set_secret.sql
-- TEMPORARY admin helper: set/rotate the Vault secret the 0008 trigger reads, from a value passed
-- over the (TLS) PostgREST body — so the secret never lands in a migration file (§5.7/§10) or the
-- CLI arg list. service_role-only. Returns ONLY the length as confirmation, never the value.
-- Dropped by the cleanup migration once the pipeline is verified.
create or replace function public.__set_wh_secret(p_secret text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'wardline_webhook_secret';
  if sid is null then
    perform vault.create_secret(p_secret, 'wardline_webhook_secret', 'x-webhook-secret header for notify-on-case');
  else
    perform vault.update_secret(sid, p_secret);
  end if;
  return 'ok len=' || length(p_secret)::text;
end $$;

revoke execute on function public.__set_wh_secret(text) from public;
grant execute on function public.__set_wh_secret(text) to service_role;
