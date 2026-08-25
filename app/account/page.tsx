import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AccountForm from "@/components/AccountForm";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase
    .from("students")
    .select("full_name, mbbs_year, role, opted_in, telegram_chat_id")
    .eq("id", user.id)
    .single();

  if (!me) redirect("/auth/login");

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Account</h1>
      <p className="mb-6 text-sm text-gray-500">
        Manage notifications and your Telegram link. Your email is your college address.
      </p>
      <AccountForm
        id={user.id}
        fullName={me.full_name}
        mbbsYear={me.mbbs_year}
        role={me.role as Role}
        optedIn={me.opted_in}
        telegramChatId={me.telegram_chat_id}
      />
    </div>
  );
}
