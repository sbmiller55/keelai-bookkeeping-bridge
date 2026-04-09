"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getClient, getTransactions, syncMercury, getCloseChecklist,
  Client, Transaction, MercurySyncResult, DateRangeOption, CloseChecklistItem,
} from "@/lib/api";

// ── Due date helpers (mirrors close/page.tsx) ─────────────────────────────────

function getNthBusinessDay(year: number, month: number, n: number): Date {
  const result: Date[] = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    if (d.getDay() !== 0 && d.getDay() !== 6) result.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return result[n - 1] ?? result[result.length - 1];
}

function getLastBusinessDay(year: number, month: number): Date {
  const d = new Date(year, month + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

function calcDueDate(due_rule: string, workingYear: number, workingMonth: number): Date {
  const m0 = workingMonth - 1;
  const lastDay = new Date(workingYear, m0 + 1, 0);
  switch (due_rule) {
    case "2nd_biz_day": return getNthBusinessDay(workingYear, m0, 2);
    case "last_biz_day": return getLastBusinessDay(workingYear, m0);
    case "day_1_next_month": {
      const nm = workingMonth === 12 ? 1 : workingMonth + 1;
      const ny = workingMonth === 12 ? workingYear + 1 : workingYear;
      return new Date(ny, nm - 1, 1);
    }
    default: {
      const match = due_rule.match(/^day_(\d+)$/);
      if (match) {
        const n = parseInt(match[1]);
        if (n >= 29) return lastDay;
        return new Date(workingYear, m0, n);
      }
      return new Date(workingYear, m0, 5);
    }
  }
}

function getCloseMonthStr(now: Date): string {
  const prev = now.getMonth() === 0 ? 12 : now.getMonth();
  const yr = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return `${yr}-${String(prev).padStart(2, "0")}`;
}

// ── Sync detail panel ─────────────────────────────────────────────────────────

function SyncDetail({ result }: { result: MercurySyncResult }) {
  return (
    <div className="mb-6 bg-gray-900 border border-gray-700 rounded-xl p-5 text-sm space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-green-400 font-semibold">Sync complete</span>
        <span className="text-gray-600">·</span>
        <span className="text-white">{result.imported} transactions imported</span>
        {result.je_created > 0 && (
          <><span className="text-gray-600">·</span>
          <span className="text-indigo-400">{result.je_created} journal entries coded by AI</span></>
        )}
        {result.skipped > 0 && (
          <><span className="text-gray-600">·</span>
          <span className="text-gray-400">{result.skipped} duplicates skipped</span></>
        )}
      </div>
      {result.errors.length > 0 && (
        <ul className="text-yellow-400 text-xs list-disc list-inside space-y-0.5">
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

// ── Date range options ────────────────────────────────────────────────────────

const DATE_RANGE_OPTIONS: { value: DateRangeOption; label: string }[] = [
  { value: "since_last_sync", label: "Since last sync" },
  { value: "last_30",         label: "Last 30 days" },
  { value: "last_90",         label: "Last 90 days" },
  { value: "last_180",        label: "Last 6 months" },
  { value: "last_365",        label: "Last 12 months" },
  { value: "custom",          label: "Custom range…" },
];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ClientOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const clientId = Number(id);

  const now = new Date();
  const closeMonthStr = getCloseMonthStr(now);
  const workingYear = now.getFullYear();
  const workingMonth = now.getMonth() + 1;

  const [client, setClient] = useState<Client | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [checklistItems, setChecklistItems] = useState<CloseChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [syncPhase, setSyncPhase] = useState<"importing" | "coding" | null>(null);
  const [syncResult, setSyncResult] = useState<MercurySyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [dateRange, setDateRange] = useState<DateRangeOption>("since_last_sync");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  async function loadData() {
    setLoading(true);
    try {
      const [c, t, cl] = await Promise.all([
        getClient(clientId),
        getTransactions(clientId),
        getCloseChecklist(clientId, closeMonthStr).catch(() => [] as CloseChecklistItem[]),
      ]);
      setClient(c);
      setTransactions(t);
      setChecklistItems(cl);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [clientId]);

  async function handleSync() {
    setSyncing(true);
    setSyncPhase("importing");
    setSyncResult(null);
    setSyncError(null);
    try {
      const phaseTimer = setTimeout(() => setSyncPhase("coding"), 3000);
      const result = await syncMercury(
        clientId, dateRange,
        dateRange === "custom" ? customStart : undefined,
        dateRange === "custom" ? customEnd : undefined,
      );
      clearTimeout(phaseTimer);
      setSyncResult(result.results[0]);
      if (result.total_imported > 0) {
        router.push(`/clients/${clientId}/review`);
      } else {
        const [c, t] = await Promise.all([getClient(clientId), getTransactions(clientId)]);
        setClient(c);
        setTransactions(t);
      }
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
      setSyncPhase(null);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const pending  = transactions.filter((t) => t.status === "pending").length;
  const approved = transactions.filter((t) => t.status === "approved").length;

  const today = new Date(); today.setHours(0, 0, 0, 0);

  const incompleteTodos = checklistItems
    .filter((i) => !i.completed_at)
    .map((i) => ({ ...i, dueDate: calcDueDate(i.due_rule, workingYear, workingMonth) }))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const remainingCount = incompleteTodos.length;
  const closeMonthLabel = new Date(
    Number(closeMonthStr.split("-")[0]),
    Number(closeMonthStr.split("-")[1]) - 1,
    1
  ).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">{client?.name}</h1>
        <p className="text-gray-500 mt-1 text-xs">
          Last synced: {client?.last_sync_at ? new Date(client.last_sync_at).toLocaleString() : "Never"}
        </p>
      </div>

      {/* Sync controls */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <p className="text-sm font-medium text-gray-300 mb-3">Sync Mercury Transactions</p>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date range</label>
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateRangeOption)}
              className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {DATE_RANGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {dateRange === "custom" && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">From</label>
                <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">To</label>
                <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </>
          )}
          <button
            onClick={handleSync}
            disabled={syncing || (dateRange === "custom" && (!customStart || !customEnd))}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors min-w-[160px] justify-center"
          >
            {syncing ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0" />
                {syncPhase === "coding" ? "AI coding JEs…" : "Importing…"}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync &amp; Code
              </>
            )}
          </button>
        </div>
        {dateRange === "since_last_sync" && (
          <p className="text-xs text-gray-600 mt-2">
            {client?.last_sync_at
              ? `Will fetch transactions since ${new Date(client.last_sync_at).toLocaleString()}`
              : "No prior sync — will fetch the last 90 days as a starting point"}
          </p>
        )}
      </div>

      {syncError && (
        <div className="mb-6 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
          Sync failed: {syncError}
        </div>
      )}
      {syncResult && <SyncDetail result={syncResult} />}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <Link href={`/clients/${clientId}/review`} className="block bg-yellow-950 border border-yellow-700 hover:border-yellow-500 rounded-xl p-5 transition-colors">
          <p className="text-sm text-yellow-300 font-medium">Pending Review</p>
          <p className="text-4xl font-bold text-yellow-200 mt-1">{pending}</p>
        </Link>
        <Link href={`/clients/${clientId}/export`} className="block bg-green-950 border border-green-700 hover:border-green-500 rounded-xl p-5 transition-colors">
          <p className="text-sm text-green-300 font-medium">Ready to Export</p>
          <p className="text-4xl font-bold text-green-200 mt-1">{approved}</p>
        </Link>
<Link href={`/clients/${clientId}/close`} className="block bg-indigo-950 border border-indigo-700 hover:border-indigo-500 rounded-xl p-5 transition-colors">
          <p className="text-sm text-indigo-300 font-medium">Remaining To-Dos</p>
          <p className="text-4xl font-bold text-indigo-200 mt-1">{remainingCount}</p>
          <p className="text-xs text-indigo-400 mt-1 truncate">{closeMonthLabel} close</p>
        </Link>
      </div>

      {/* Upcoming To-Dos */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Upcoming To-Dos</h2>
          <Link href={`/clients/${clientId}/close`} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            View all →
          </Link>
        </div>

        {incompleteTodos.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-2xl mb-2">🎉</p>
            <p className="text-gray-400 font-medium text-sm">All caught up!</p>
            <p className="text-gray-600 text-xs mt-1">{closeMonthLabel} close is complete.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-800">
            {incompleteTodos.map((item) => {
              const isOverdue = item.dueDate < today;
              return (
                <li key={item.id} className="px-6 py-4 flex items-start gap-4 hover:bg-gray-800/40 transition-colors">
                  {/* Due date column */}
                  <div className={`text-center shrink-0 w-12 ${isOverdue ? "text-red-400" : "text-gray-400"}`}>
                    <p className="text-xs font-medium uppercase">
                      {item.dueDate.toLocaleDateString("en-US", { month: "short" })}
                    </p>
                    <p className="text-xl font-bold leading-tight">
                      {item.dueDate.getDate()}
                    </p>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{item.title}</p>
                    {item.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{item.description}</p>
                    )}
                    {item.milestone && (
                      <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400 border border-emerald-800">
                        → {item.milestone}
                      </span>
                    )}
                  </div>

                  {/* Overdue badge */}
                  {isOverdue && (
                    <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-red-900/50 text-red-400 border border-red-800 font-medium">
                      Overdue
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
