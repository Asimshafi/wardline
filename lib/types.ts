// Domain types. Hand-written for the MVP; once the Supabase CLI is installed you can
// replace these with generated types (`supabase gen types typescript`).

export type Role = "student" | "feeder" | "admin";
export type CaseStatus = "admitted" | "discharged";

export interface Student {
  id: string;
  full_name: string;
  mbbs_year: number;
  telegram_chat_id: string | null;
  opted_in: boolean;
  role: Role;
  created_at: string;
}

// One row per distinct diagnosis returned by the search_taxonomy RPC, with years
// unioned across every module/year that diagnosis appears in (§7).
export interface TaxonomyMatch {
  diagnosis: string;
  synonyms: string | null;
  subject_area: string | null;
  module: string | null;
  theme: string | null;
  years: number[];
  taxonomy_ids: string[];
  representative_id: string;
}

export interface CaseTaxonomyTag {
  subject_area: string | null;
  module: string | null;
  theme: string | null;
}

export interface CaseRow {
  id: string;
  diagnosis_snapshot: string;
  ward: string;
  bed: string;
  note: string | null;
  status: CaseStatus;
  matched_years: number[];
  created_at: string;
  // Joined from syllabus_taxonomy via taxonomy_id (may be null if the row was deleted).
  taxonomy: CaseTaxonomyTag | null;
}

// Ward list is hospital-specific — edit to match your teaching hospital.
export const WARDS = [
  "Medical Ward",
  "Surgical Ward",
  "Paediatrics Ward",
  "Gynae/Obs Ward",
  "Cardiology",
  "Neurology",
  "Orthopaedics",
  "ICU",
  "CCU",
  "Emergency",
] as const;
