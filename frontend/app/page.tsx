"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const target = isAuthenticated() ? "/clients" : "/login";
    router.replace(target);
    const fallback = setTimeout(() => {
      if (
        typeof window !== "undefined" &&
        window.location.pathname === "/"
      ) {
        window.location.replace(target);
      }
    }, 1500);
    return () => clearTimeout(fallback);
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
