-- 0009_wh_diag.sql
-- TEMPORARY diagnostic for the notify pipeline. Surfaces the pg_net + Vault internals that
-- PostgREST can't see, in one service_role-only RPC. Never returns the secret value — only its
-- presence and length. This function is DROPPED by the follow-up fix migration.
create or replace function public.__wh_diag()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_present boolean; v_len int; v_err text;
  resp jsonb; q jsonb; qcount int;
  has_post boolean := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'net' and p.proname = 'http_post');
  trg boolean := exists (select 1 from pg_trigger where tgname = 'notify_case_inserted' and not tgisinternal);
begin
  begin
    select (decrypted_secret is not null), length(decrypted_secret)
    into v_present, v_len
    from vault.decrypted_secrets where name = 'wardline_webhook_secret' limit 1;
  exception when others then v_err := sqlstate || ': ' || sqlerrm; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into resp
    from (select * from net._http_response order by id desc limit 5) r;
  exception when others then resp := jsonb_build_object('read_error', sqlstate || ': ' || sqlerrm); end;

  begin
    select count(*)::int into qcount from net.http_request_queue;
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into q
    from (select id, method, url, timeout_milliseconds from net.http_request_queue order by id desc limit 5) x;
  exception when others then q := jsonb_build_object('read_error', sqlstate || ': ' || sqlerrm); end;

  return jsonb_build_object(
    'trigger_attached',     trg,
    'has_net_http_post',    has_post,
    'vault_secret_present', v_present,
    'vault_secret_len',     v_len,
    'vault_read_error',     v_err,
    'pending_queue_count',  qcount,
    'pending_queue',        q,
    'recent_responses',     resp
  );
end $$;

revoke execute on function public.__wh_diag() from public;
grant execute on function public.__wh_diag() to service_role;
