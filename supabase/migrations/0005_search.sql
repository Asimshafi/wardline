-- 0005_search.sql
-- Deterministic diagnosis search backing /lib/matching.ts and the feeder picker (§7).
-- Returns ONE row per distinct diagnosis, with `years` unioned across every module/year
-- that diagnosis appears in — this is what lets the feeder auto-fill matched_years without NLP.
--
-- SECURITY INVOKER: runs as the caller, so the taxonomy_read RLS policy still applies.
-- Ranking: full-text hit > diagnosis substring > synonym substring, then trigram similarity.

create or replace function public.search_taxonomy(q text, max_results int default 20)
returns table (
  diagnosis         text,
  synonyms          text,
  subject_area      text,
  module            text,
  theme             text,
  years             smallint[],
  taxonomy_ids      uuid[],
  representative_id uuid
)
language sql stable security invoker set search_path = public
as $$
  with scored as (
    select
      t.*,
      case
        when to_tsvector('english', t.diagnosis || ' ' || coalesce(t.synonyms, ''))
             @@ websearch_to_tsquery('english', q) then 3
        when t.diagnosis ilike '%' || q || '%' then 2
        when coalesce(t.synonyms, '') ilike '%' || q || '%' then 1
        else 0
      end as score,
      greatest(
        similarity(t.diagnosis, q),
        similarity(coalesce(t.synonyms, ''), q)
      ) as sim
    from syllabus_taxonomy t
    where
      to_tsvector('english', t.diagnosis || ' ' || coalesce(t.synonyms, ''))
        @@ websearch_to_tsquery('english', q)
      or t.diagnosis ilike '%' || q || '%'
      or coalesce(t.synonyms, '') ilike '%' || q || '%'
      or similarity(t.diagnosis, q) > 0.2
  )
  select
    diagnosis,
    (array_agg(synonyms     order by score desc, sim desc))[1] as synonyms,
    (array_agg(subject_area order by score desc, sim desc))[1] as subject_area,
    (array_agg(module       order by score desc, sim desc))[1] as module,
    (array_agg(theme        order by score desc, sim desc))[1] as theme,
    array_agg(distinct year order by year)                     as years,
    array_agg(distinct id)                                     as taxonomy_ids,
    (array_agg(id order by score desc, sim desc))[1]           as representative_id
  from scored
  group by diagnosis
  order by max(score) desc, max(sim) desc, diagnosis
  limit greatest(max_results, 1);
$$;

revoke all on function public.search_taxonomy(text, int) from public;
grant execute on function public.search_taxonomy(text, int) to authenticated;
