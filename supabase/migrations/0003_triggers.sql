-- 0003_triggers.sql
-- Server-side enforcement (build spec §5). None of this is optional and none of it
-- trusts the app layer. All cross-row / privileged checks are SECURITY DEFINER so
-- they see the truth regardless of the caller's RLS view.

-- ── updated_at bump ──────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

create trigger cases_set_updated_at
  before update on cases
  for each row execute function public.set_updated_at();

-- ── §5.1  Reject (never strip) patient identifiers in note ───────────────────
-- Deliberately high-precision: we hard-block only patterns that are almost never
-- legitimate clinical shorthand, so feeders aren't trained to fight false positives.
-- Tune the pattern list at the confirmation gate — see README "Decision 1".
create or replace function public.reject_pii_in_note()
returns trigger language plpgsql as $$
declare n text := coalesce(new.note, '');
begin
  if n = '' then return new; end if;

  -- CNIC (Pakistan): 00000-0000000-0
  if n ~ '\d{5}-\d{7}-\d' then
    raise exception 'PII_REJECTED (CNIC): remove patient identifiers from the note.' using errcode = 'check_violation';
  end if;

  -- Phone / long numeric IDs: PK mobile 03xx-xxxxxxx, +92…, or any run of 10+ digits
  if n ~ '(\+?92|0)?[\s-]?3\d{2}[\s-]?\d{7}' or n ~ '\d{10,}' then
    raise exception 'PII_REJECTED (phone/number): remove patient identifiers from the note.' using errcode = 'check_violation';
  end if;

  -- Email address
  if n ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then
    raise exception 'PII_REJECTED (email): remove patient identifiers from the note.' using errcode = 'check_violation';
  end if;

  -- Hospital/MRN/registration number, labelled
  if n ~* '\m(mrn|mr#|hosp(ital)?\s*(no|number|id)|reg(istration)?\s*(no|number))\M' then
    raise exception 'PII_REJECTED (MRN/hospital no.): remove patient identifiers from the note.' using errcode = 'check_violation';
  end if;

  -- Relational name markers ubiquitous in local records: S/O, D/O, W/O, B/O, "baby of"
  if n ~* '\m[sdwb]\s*/\s*o\M' or n ~* '\mbaby of\M' then
    raise exception 'PII_REJECTED (name/relation): do not enter patient names (e.g. S/O, D/O).' using errcode = 'check_violation';
  end if;

  -- Title + capitalised name: Mr/Mrs/Ms/Miss/Master  Surname
  if n ~ '\m(Mr|Mrs|Ms|Miss|Master)\.?\s+[A-Z][a-z]+' then
    raise exception 'PII_REJECTED (name): do not enter patient names.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger cases_reject_pii
  before insert or update on cases
  for each row execute function public.reject_pii_in_note();

-- ── §5.6  Rate limit: ≤ 20 case inserts per account per rolling hour ─────────
-- SECURITY DEFINER so the COUNT sees ALL of the actor's cases, not just the rows
-- their own RLS SELECT policy exposes (a feeder often can't read what they logged).
create or replace function public.enforce_case_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recent int;
  cap constant int := 20;
begin
  select count(*) into recent
  from cases
  where logged_by = new.logged_by
    and created_at > now() - interval '1 hour';

  if recent >= cap then
    raise exception 'RATE_LIMITED: over % cases in the last hour for this account.', cap using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger cases_rate_limit
  before insert on cases
  for each row execute function public.enforce_case_rate_limit();

-- ── Freeze immutable columns on UPDATE (audit integrity) ─────────────────────
create or replace function public.cases_freeze_immutable()
returns trigger language plpgsql as $$
begin
  if new.taxonomy_id        is distinct from old.taxonomy_id
  or new.diagnosis_snapshot is distinct from old.diagnosis_snapshot
  or new.logged_by          is distinct from old.logged_by
  or new.matched_years      is distinct from old.matched_years
  or new.created_at         is distinct from old.created_at then
    raise exception 'IMMUTABLE: taxonomy_id, diagnosis_snapshot, logged_by, matched_years, created_at cannot change after insert.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger cases_freeze_immutable
  before update on cases
  for each row execute function public.cases_freeze_immutable();

-- ── §5.2  Audit every write to cases ─────────────────────────────────────────
-- INSERT + UPDATE only. Client DELETE is impossible (no RLS delete policy); the sole
-- deletes are the retention purge (§5.9), which must NOT write into the table it purges.
create or replace function public.audit_cases()
returns trigger language plpgsql security definer set search_path = public as $$
declare changed jsonb; act text;
begin
  if tg_op = 'INSERT' then
    insert into case_audit_log(case_id, actor, action, changed_fields)
    values (new.id, (select auth.uid()), 'create', to_jsonb(new) - 'updated_at');
    return new;
  end if;

  -- UPDATE: record only the fields that actually changed.
  select jsonb_object_agg(key, jsonb_build_object('old', o.value, 'new', n.value))
    into changed
  from jsonb_each(to_jsonb(old) - 'updated_at') o
  join jsonb_each(to_jsonb(new) - 'updated_at') n using (key)
  where o.value is distinct from n.value;

  if changed is null then return new; end if;   -- nothing material changed

  act := case when changed ? 'status' then 'update_status' else 'update' end;
  insert into case_audit_log(case_id, actor, action, changed_fields)
  values (new.id, (select auth.uid()), act, changed);
  return new;
end;
$$;

create trigger cases_audit
  after insert or update on cases
  for each row execute function public.audit_cases();

-- ── §5.5  Block role self-escalation ─────────────────────────────────────────
-- Only an admin may change students.role. A null auth.uid() (service_role / raw SQL,
-- e.g. bootstrapping the first admin or the seed script) is allowed through.
create or replace function public.students_no_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and (select auth.uid()) is not null
     and public.auth_role() is distinct from 'admin' then
    raise exception 'FORBIDDEN: only an admin can change a user role.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger students_no_role_escalation
  before update on students
  for each row execute function public.students_no_role_escalation();

-- ── Auto-create student profile on signup (role always 'student') ────────────
-- Guarantees a profile exists and that role can never be self-set at signup (§5.5).
-- The signup flow MUST pass full_name and mbbs_year in auth user metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.students (id, full_name, mbbs_year, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    (new.raw_user_meta_data->>'mbbs_year')::smallint,   -- NOT NULL: signup form must collect year
    'student'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── §5.3  Auto-expire admitted cases after 7 days ───────────────────────────
create or replace function public.expire_old_cases()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update cases set status = 'discharged'
  where status = 'admitted' and auto_expire_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── §5.9  Retention purge: hard-delete cases + audit older than N days ───────
create or replace function public.purge_expired_data(retention_days int default 90)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from case_audit_log where created_at < now() - make_interval(days => retention_days);
  delete from cases          where created_at < now() - make_interval(days => retention_days);
  get diagnostics n = row_count;                 -- rows deleted from cases (audit/notifications cascade)
  return n;
end;
$$;

revoke all on function public.expire_old_cases()      from public;
revoke all on function public.purge_expired_data(int) from public;
