"use client";

import { useEffect, useState } from "react";
import AuthGuard from "@/components/auth-guard";
import { getMe, User } from "@/lib/api";
import { removeToken } from "@/lib/auth";
import { useRouter } from "next/navigation";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();

  useEffect(() => {
    getMe().then(setUser).catch(() => {});
  }, []);

  function handleLogout() {
    removeToken();
    router.replace("/login");
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-950 flex flex-col">
        <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
          <span className="text-base font-bold text-white tracking-tight">Keel AI</span>
          <div className="flex items-center gap-4">
            {user && (
              <span className="text-sm text-gray-400 hidden sm:block">
                {user.name}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-red-400 transition-colors"
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </div>
    </AuthGuard>
  );
}
