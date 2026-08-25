import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";

// Server component: reads the session + role and renders role-appropriate links.
export default async function Nav() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: Role | null = null;
  let name: string | null = null;
  if (user) {
    const { data: me } = await supabase
      .from("students")
      .select("role, full_name")
      .eq("id", user.id)
      .single();
    role = (me?.role as Role) ?? "student";
    name = me?.full_name ?? null;
  }

  const canFeed = !!user;
  const canFeeder = role === "feeder" || role === "admin";
  const isAdmin = role === "admin";

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link href="/feed" className="text-lg font-semibold text-ward">
          Wardline
        </Link>

        <nav className="flex items-center gap-4 text-sm">
          {canFeed && <Link href="/feed" className="text-gray-700 hover:text-ward">Feed</Link>}
          {canFeeder && <Link href="/feeder" className="text-gray-700 hover:text-ward">Log a case</Link>}
          {isAdmin && (
            <>
              <Link href="/admin/taxonomy" className="text-gray-700 hover:text-ward">Taxonomy</Link>
              <Link href="/admin/students" className="text-gray-700 hover:text-ward">Students</Link>
            </>
          )}
          {user ? (
            <>
              <Link href="/account" className="text-gray-500 hover:text-ward">
                {name ? name.split(" ")[0] : "Account"}
                {role ? <span className="ml-1 text-xs text-gray-400">({role})</span> : null}
              </Link>
              <form action="/auth/signout" method="post">
                <button className="rounded bg-gray-100 px-2 py-1 text-gray-700 hover:bg-gray-200">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/auth/login" className="text-gray-700 hover:text-ward">Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
