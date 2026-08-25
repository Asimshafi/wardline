"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { COLLEGE_EMAIL_DOMAIN } from "@/lib/env";

type Mode = "password" | "magic" | "signup";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/feed";
  const supabase = createClient();

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [mbbsYear, setMbbsYear] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function wrongDomain(): boolean {
    if (!COLLEGE_EMAIL_DOMAIN) return false;
    return !email.trim().toLowerCase().endsWith("@" + COLLEGE_EMAIL_DOMAIN.toLowerCase());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (wrongDomain()) {
      setError(`Use your college email (@${COLLEGE_EMAIL_DOMAIN}).`);
      return;
    }

    setBusy(true);
    try {
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      } else if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo },
        });
        if (error) throw error;
        setMessage("Check your email for a sign-in link.");
      } else {
        // signup — full_name + mbbs_year go into user metadata; handle_new_user() reads them.
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo,
            data: { full_name: fullName.trim(), mbbs_year: mbbsYear },
          },
        });
        if (error) throw error;
        setMessage("Account created. Check your email to confirm, then sign in.");
        setMode("password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Wardline</h1>
      <p className="mb-6 text-sm text-gray-500">
        Sign in with your college email to see admissions matched to your year.
      </p>

      <div className="mb-4 flex gap-2 text-sm">
        {(["password", "magic", "signup"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
              setMessage(null);
            }}
            className={`rounded px-3 py-1 ${
              mode === m ? "bg-ward text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            {m === "password" ? "Password" : m === "magic" ? "Magic link" : "Sign up"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === "signup" && (
          <>
            <input
              className="w-full rounded border border-gray-300 px-3 py-2"
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
            <label className="block text-sm text-gray-600">
              MBBS year
              <select
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                value={mbbsYear}
                onChange={(e) => setMbbsYear(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    Year {y}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <input
          type="email"
          className="w-full rounded border border-gray-300 px-3 py-2"
          placeholder={COLLEGE_EMAIL_DOMAIN ? `you@${COLLEGE_EMAIL_DOMAIN}` : "you@college.edu"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        {mode !== "magic" && (
          <input
            type="password"
            className="w-full rounded border border-gray-300 px-3 py-2"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-ward px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy
            ? "…"
            : mode === "password"
              ? "Sign in"
              : mode === "magic"
                ? "Send magic link"
                : "Create account"}
        </button>
      </form>

      {message && <p className="mt-4 rounded bg-ward-soft px-3 py-2 text-sm text-ward">{message}</p>}
      {error && <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
