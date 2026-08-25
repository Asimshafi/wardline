import { redirect } from "next/navigation";

// Landing → feed. Unauthenticated users are bounced to /auth/login by middleware.
export default function Home() {
  redirect("/feed");
}
