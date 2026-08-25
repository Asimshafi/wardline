import { Suspense } from "react";
import LoginForm from "@/components/LoginForm";

// Server wrapper: LoginForm uses useSearchParams, which needs a Suspense boundary.
export default function LoginPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <LoginForm />
    </Suspense>
  );
}
