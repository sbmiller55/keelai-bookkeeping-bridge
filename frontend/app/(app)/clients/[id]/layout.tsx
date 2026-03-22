"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { getClient, Client, getTransactionsWithEntries } from "@/lib/api";
import ChatPanel from "@/components/ChatPanel";
import { ChatContextProvider } from "@/lib/chat-context";

const NAV_MAIN = [
  { label: "Overview", suffix: "" },
  { label: "Review Queue", suffix: "/review" },
  { label: "Monthly Close", suffix: "/close" },
  { label: "Payments", suffix: "/payments" },
  { label: "Export", suffix: "/export" },
  { label: "Settings", suffix: "/settings" },
];

const NAV_MORE = [
  { label: "Transactions", suffix: "/transactions" },
  { label: "Rules", suffix: "/rules" },
  { label: "Vendors", suffix: "/vendors" },
  { label: "Classes", suffix: "/classes" },
];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const [client, setClient] = useState<Client | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    const clientId = Number(id);
    getClient(clientId).then(setClient).catch(() => {});
    getTransactionsWithEntries(clientId, "pending")
      .then((items) => setPendingCount(items.length))
      .catch(() => {});
  }, [id]);

  const base = `/clients/${id}`;

  // Auto-expand "More" if the current page is one of the hidden items
  const isMoreActive = NAV_MORE.some(({ suffix }) => pathname.startsWith(`${base}${suffix}`));

  function NavLink({ label, suffix }: { label: string; suffix: string }) {
    const href = `${base}${suffix}`;
    const active = suffix === "" ? pathname === base : pathname.startsWith(href);
    const isReview = suffix === "/review";
    return (
      <Link
        href={href}
        className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          active ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`}
      >
        {label}
        {isReview && pendingCount !== null && pendingCount > 0 && (
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full min-w-[20px] text-center ${
            active ? "bg-white/20 text-white" : "bg-indigo-600 text-white"
          }`}>
            {pendingCount}
          </span>
        )}
      </Link>
    );
  }

  return (
    <ChatContextProvider>
    <div className="flex min-h-[calc(100vh-49px)]">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <Link
            href="/clients"
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            All Clients
          </Link>
        </div>

        <div className="px-4 py-4 border-b border-gray-800">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Client</p>
          <p className="text-sm font-semibold text-white truncate">
            {client?.name ?? "Loading…"}
          </p>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {NAV_MAIN.map(({ label, suffix }) => (
            <NavLink key={suffix} label={label} suffix={suffix} />
          ))}

          {/* More toggle */}
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              isMoreActive ? "text-white" : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            <span>More</span>
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${moreOpen || isMoreActive ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* More items */}
          {(moreOpen || isMoreActive) && (
            <div className="pl-3 space-y-0.5 border-l border-gray-800 ml-3">
              {NAV_MORE.map(({ label, suffix }) => (
                <NavLink key={suffix} label={label} suffix={suffix} />
              ))}
            </div>
          )}
        </nav>
      </aside>

      {/* Page content */}
      <main className="flex-1 p-8 overflow-auto min-w-0">
        {children}
      </main>

      {client && <ChatPanel clientId={client.id} clientName={client.name} />}
    </div>
    </ChatContextProvider>
  );
}
