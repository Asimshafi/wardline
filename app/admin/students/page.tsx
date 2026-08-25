import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StudentsAdmin from "@/components/StudentsAdmin";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const { data: me } = await supabase.from("students").select("role").eq("id", user.id).single();
  if (me?.role !== "admin") redirect("/feed");

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Students</h1>
      <p className="mb-6 text-sm text-gray-500">
        Grant the feeder role to ward-duty students. Admin-only; changes are audited.
      </p>
      <StudentsAdmin selfId={user.id} />
    </div>
  );
}
