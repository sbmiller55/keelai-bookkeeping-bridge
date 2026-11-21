"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login } from "@/lib/api";
import { setToken } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Both boxes start read-only and unlock on first press or focus. Browsers
  // and password add-ons skip read-only fields when filling a page as it
  // loads, so the form opens empty and the saved-login choice appears on click
  // instead — an outdated saved password was being filled in silently.
  // Unlocking on pointerdown, which comes before focus, matters: a box that is
  // still read-only when it takes focus gets no saved-login list, which cost a
  // second click. The attribute is dropped on the element directly so it is
  // gone before focus, without waiting for React to re-render.
  const [unlocked, setUnlocked] = useState(false);
  function unlock(e: React.SyntheticEvent<HTMLInputElement>) {
    e.currentTarget.form?.querySelectorAll("input").forEach((el) => { el.readOnly = false; });
    setUnlocked(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await login(email, password);
      setToken(data.access_token);
      router.replace("/clients");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">Keel AI</h1>
          <p className="mt-2 text-gray-400">Sign in to your account</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 rounded-2xl border border-gray-800 shadow-xl p-8 space-y-5"
        >
          {error && (
            <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Email
            </label>
            <input
              type="email"
              name="email"
              autoComplete="username"
              readOnly={!unlocked}
              onPointerDown={unlock}
              onFocus={unlock}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Password
            </label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              readOnly={!unlocked}
              onPointerDown={unlock}
              onFocus={unlock}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 transition-colors"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-center text-sm text-gray-400">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-indigo-400 hover:text-indigo-300 font-medium">
              Create one
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
