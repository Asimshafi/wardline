-- 0007_signup_domain.sql
-- §5.4 — restrict signup to the college email domain, enforced SERVER-SIDE (not just the
-- client hint in NEXT_PUBLIC_COLLEGE_EMAIL_DOMAIN). This holds even if the UI is bypassed and
-- applies to every insert into auth.users (self-signup AND the admin API).
--
-- Ships DISABLED: with no domain configured the trigger is a no-op, so behaviour is identical
-- to today and nothing breaks (incl. the @example.com users that `npm run smoke` creates).
-- Turn it on with a single UPDATE — see the bottom of this file. No code change needed to flip.

-- 1) Server-side config store (key/value). Locked down: RLS on, and NO grants to anon/
--    authenticated, so only service_role (SQL editor / admin API) and SECURITY DEFINER
--    functions can see or change it. Consistent with 0006 (least privilege; RLS is the gate).
create table if not exists public.app_config (
  key   text primary key,
  value text not null default ''
);
alter table public.app_config enable row level security;
-- no policies for anon/authenticated on purpose → they get nothing; service_role bypasses RLS.
grant all on public.app_config to service_role;

-- disabled by default: empty value = no restriction
insert into public.app_config (key, value)
values ('signup_allowed_email_domains', '')
on conflict (key) do nothing;

-- 2) Parsed allow-list: lowercased, comma/semicolon/whitespace separated. Empty ⇒ no restriction.
create or replace function public.signup_allowed_email_domains()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array(
      select btrim(lower(d))
      from regexp_split_to_table(
             coalesce((select value from public.app_config
                       where key = 'signup_allowed_email_domains'), ''),
             '[,;[:space:]]+') as d
      where btrim(d) <> ''
    ),
    '{}'::text[]
  );
$$;

-- 3) Enforcement: BEFORE INSERT on auth.users. Rejects when an allow-list is configured and the
--    new email's domain isn't in it. No-op when the list is empty (the shipped default).
create or replace function public.enforce_signup_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed text[] := public.signup_allowed_email_domains();
  dom text;
begin
  if allowed is null or cardinality(allowed) = 0 then
    return new;                       -- restriction disabled (default)
  end if;
  if new.email is null or new.email = '' then
    return new;                       -- phone / OAuth identities unaffected
  end if;
  dom := lower(split_part(new.email, '@', 2));
  if not (dom = any (allowed)) then
    raise exception using
      errcode = 'check_violation',
      message = 'EMAIL_DOMAIN_NOT_ALLOWED: signup is restricted to approved college email domains';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_signup_email_domain on auth.users;
create trigger enforce_signup_email_domain
  before insert on auth.users
  for each row execute function public.enforce_signup_email_domain();

-- Keep the surface minimal: clients never call these directly (the trigger runs as definer).
revoke execute on function public.signup_allowed_email_domains() from public;
revoke execute on function public.enforce_signup_email_domain()  from public;

-- ────────────────────────────────────────────────────────────────────────────────────────
-- TO ACTIVATE (run in Dashboard → SQL editor once you know the real domain; NOT run here):
--
--   update public.app_config set value = 'students.yourcollege.edu.pk'
--   where key = 'signup_allowed_email_domains';
--
-- Multiple allowed domains: comma-separate them, e.g.
--   'students.college.edu.pk, college.edu.pk'
-- To disable again: set value back to ''.
--
-- NOTE: while active, this also blocks @example.com — so `npm run smoke` (which creates
-- @example.com users via the admin API) must be run with the restriction disabled, or against
-- a non-prod project. Also: GoTrue surfaces a rejected signup as a generic "Database error
-- saving new user"; the login form's domain hint is the friendly pre-submit guard. If you want
-- a clean per-error message, the upgrade path is a Supabase "Before User Created" Auth Hook.
-- ────────────────────────────────────────────────────────────────────────────────────────
