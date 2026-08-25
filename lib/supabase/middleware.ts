import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/env";

const FEEDER_PREFIXES = ["/feeder"];
const ADMIN_PREFIXES = ["/admin"];
// Everything else that requires only a logged-in user:
const PROTECTED_PREFIXES = ["/feed", "/feeder", "/admin", "/account"];

// Refreshes the auth session on every request AND gates routes by role for UX.
// RLS is the real access control; this just keeps users out of pages they can't use.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not run other logic between createServerClient and getUser (auth-helpers rule).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const needsAuth = PROTECTED_PREFIXES.some((p) => path.startsWith(p));

  if (!user) {
    if (!needsAuth) return response;
    return redirectPreservingCookies(request, response, "/auth/login", path);
  }

  const needsFeeder = FEEDER_PREFIXES.some((p) => path.startsWith(p));
  const needsAdmin = ADMIN_PREFIXES.some((p) => path.startsWith(p));

  if (needsFeeder || needsAdmin) {
    const { data: me } = await supabase
      .from("students")
      .select("role")
      .eq("id", user.id)
      .single();
    const role = me?.role ?? "student";
    if (needsAdmin && role !== "admin") {
      return redirectPreservingCookies(request, response, "/feed");
    }
    if (needsFeeder && role !== "feeder" && role !== "admin") {
      return redirectPreservingCookies(request, response, "/feed");
    }
  }

  return response;
}

function redirectPreservingCookies(
  request: NextRequest,
  from: NextResponse,
  pathname: string,
  next?: string,
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next) url.searchParams.set("next", next);
  const redirect = NextResponse.redirect(url);
  // Carry over any refreshed auth cookies so the session isn't lost on redirect.
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}
