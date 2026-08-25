import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CaseEntryForm from "@/components/CaseEntryForm";

// Role gate is enforced by middleware + RLS; this is defense-in-depth for the render.
export default async function FeederPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase
    .from("students")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!me || (me.role !== "feeder" && me.role !== "admin")) redirect("/feed");

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Log a case</h1>
      <p className="mb-6 text-sm text-gray-500">
        Search the diagnosis, pick from the list, and matched year-groups are filled
        automatically. Never enter names, CNIC, MRN, or phone numbers.
      </p>
      <CaseEntryForm />
    </div>
  );
}
