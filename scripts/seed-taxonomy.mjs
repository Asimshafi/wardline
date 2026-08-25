// scripts/seed-taxonomy.mjs
// One-time seed of syllabus_taxonomy from wardline_master_taxonomy.csv (spec §9.2).
// Secrets come from the environment only (spec §10) — nothing is hardcoded.
//
// Usage (after `npm i @supabase/supabase-js` and filling .env.local):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TAXONOMY_CSV=path/to.csv \
//     node scripts/seed-taxonomy.mjs [--force]
//
// Idempotent: refuses to run if the table is already populated, unless --force.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CSV = process.env.TAXONOMY_CSV || process.argv.find((a) => a.endsWith('.csv'));
const FORCE = process.argv.includes('--force');

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env. See .env.example.');
  process.exit(1);
}
if (!CSV) {
  console.error('Missing TAXONOMY_CSV env var or a *.csv argument.');
  process.exit(1);
}

// Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas, doubled quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(readFileSync(CSV, 'utf8'));
const header = rows.shift().map((h) => h.trim());
const expected = ['diagnosis', 'synonyms', 'subject_area', 'module', 'theme', 'year'];
if (header.join(',') !== expected.join(',')) {
  console.error(`Unexpected CSV header:\n  got:      ${header.join(',')}\n  expected: ${expected.join(',')}`);
  process.exit(1);
}

const records = rows
  .filter((r) => r.length === 6 && r[0].trim() !== '')
  .map(([diagnosis, synonyms, subject_area, module, theme, year]) => ({
    diagnosis: diagnosis.trim(),
    synonyms: synonyms.trim() || null,
    subject_area: subject_area.trim() || null,
    module: module.trim() || null,
    theme: theme.trim() || null,
    year: Number(year.trim()),
  }));

const bad = records.filter((r) => !(r.year >= 1 && r.year <= 5));
if (bad.length) {
  console.error(`${bad.length} row(s) have year outside 1–5, e.g.`, bad[0]);
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const { count, error: countErr } = await supabase
  .from('syllabus_taxonomy')
  .select('*', { count: 'exact', head: true });
if (countErr) { console.error('Count failed:', countErr.message); process.exit(1); }

if (count > 0 && !FORCE) {
  console.error(`syllabus_taxonomy already has ${count} rows. Re-run with --force to add anyway.`);
  process.exit(1);
}

console.log(`Seeding ${records.length} taxonomy rows…`);
const BATCH = 500;
for (let i = 0; i < records.length; i += BATCH) {
  const chunk = records.slice(i, i + BATCH);
  const { error } = await supabase.from('syllabus_taxonomy').insert(chunk);
  if (error) { console.error(`Batch at ${i} failed:`, error.message); process.exit(1); }
  console.log(`  inserted ${Math.min(i + BATCH, records.length)}/${records.length}`);
}
console.log('Done.');
