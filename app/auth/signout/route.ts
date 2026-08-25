import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createClient();
  await supabase.auth.signOut();
  // 303 so the browser follows with GET.
  return NextResponse.redirect(new URL("/auth/login", request.url), { status: 303 });
}
