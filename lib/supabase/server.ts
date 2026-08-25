import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/env";

// Server-side Supabase client for Server Components, Route Handlers and Server Actions.
// Uses the anon key + the user's cookies, so RLS still applies as that user.
// NOTE (spec §6 asked for a single lib/supabase.ts): the App Router SSR cookie pattern
// requires next/headers, which cannot be bundled into a client component, so the client
// and server factories live in separate files. See README.
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component render, cookie writes throw; middleware refreshes the
        // session instead, so we swallow it here.
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          /* called from a Server Component — safe to ignore */
        }
      },
    },
  });
}
