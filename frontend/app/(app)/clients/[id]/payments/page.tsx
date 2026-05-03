"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getPayments, syncMercury, getInboundEmailAddress, PaymentTransaction,
  getAccruals, createAccrual, updateAccrual, deleteAccrual, analyzeForAccruals, releaseAccrual,
  getStandingRules, createStandingRule, updateStandingRule, deleteStandingRule,
  generateFromStandingRules,
  AccruedExpense, AccrualSummary, AccrualSuggestion, StandingAccrualRule,
} from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

const MERCURY_STATUS_BADGE: Record<string, string> = {
  pending:   "bg-yellow-900 text-yellow-300 border border-yellow-700",
  scheduled: "bg-blue-900 text-blue-300 border border-blue-700",
  sent:      "bg-green-900 text-green-300 border border-green-700",
  failed:    "bg-red-900 text-red-300 border border-red-700",
  cancelled: "bg-gray-800 text-gray-400 border border-gray-700",
};

const ACCRUAL_STATUS_BADGE: Record<string, string> = {
  accrued:         "bg-yellow-900 text-yellow-300 border border-yellow-700",
  partially_paid:  "bg-blue-900 text-blue-300 border border-blue-700",
  cleared:         "bg-green-900 text-green-300 border border-green-700",
};

function formatAmount(amount: number): string {
  return `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

type Tab = "payments" | "accruals" | "standing-rules";

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setCurrentPage, setPageContext } = useChatContext();

  const [tab, setTab] = useState<Tab>("payments");

  useEffect(() => {
    setCurrentPage("payments");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

  return (
    <div className="max-w-6xl">
      {/* Tabs */}
      <div className="mb-6 border-b border-gray-800">
        <nav className="flex gap-1">
          {(["payments", "accruals", "standing-rules"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors capitalize ${
                tab === t
                  ? "bg-gray-900 border border-b-gray-900 border-gray-700 text-white -mb-px"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t === "standing-rules" ? "Standing Rules" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {tab === "payments" && <PaymentsTab clientId={clientId} setPageContext={setPageContext} />}
      {tab === "accruals" && <AccrualsTab clientId={clientId} />}
      {tab === "standing-rules" && <StandingRulesTab clientId={clientId} />}
    </div>
  );
}

// ── Payments Tab (original content) ──────────────────────────────────────────

function PaymentsTab({ clientId, setPageContext }: { clientId: number; setPageContext: (ctx: string | null) => void }) {
  const [payments, setPayments] = useState<PaymentTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [inboundEmail, setInboundEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadPayments();
    getInboundEmailAddress().then((r) => setInboundEmail(r.address || null)).catch(() => {});
  }, [clientId]);

  function loadPayments() {
    setLoading(true);
    setError(null);
    getPayments(clientId)
      .then((data) => {
        setPayments(data);
        const summary = data.map((p) => ({
          id: p.id, date: p.date, vendor: p.counterparty_name,
          amount: p.amount, mercury_status: p.mercury_status, je_count: p.je_count,
        }));
        setPageContext(JSON.stringify(summary));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  async function handleSyncPayments() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await syncMercury(clientId, "since_last_sync");
      const r = result.results[0];
      setSyncMsg(`Sync complete: ${r?.imported ?? 0} imported, ${r?.je_created ?? 0} JEs created.`);
      loadPayments();
    } catch (err: unknown) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const sentPayments = payments.filter((p) => p.mercury_status !== "pending");
  const pendingPayments = payments.filter((p) => p.mercury_status === "pending");

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Payments</h1>
          <p className="text-gray-500 mt-1 text-xs">
            Mercury outgoing payments · {sentPayments.length} sent · {pendingPayments.length} pending
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/clients/${clientId}/invoices`}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-3-3m3 3l3-3" />
            </svg>
            Invoice Upload
          </Link>
          <button
            onClick={handleSyncPayments}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {syncing ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />Syncing…</>
            ) : "Sync Payments"}
          </button>
        </div>
      </div>

      {inboundEmail && (
        <div className="mb-4 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-400 font-medium mb-0.5">Forward invoices to</p>
            <p className="text-sm text-white font-mono">{inboundEmail}</p>
          </div>
          <button
            onClick={() => { navigator.clipboard.writeText(inboundEmail); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700 transition-colors whitespace-nowrap"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {syncMsg && <div className="mb-4 bg-indigo-950 border border-indigo-800 text-indigo-300 rounded-lg px-4 py-3 text-sm">{syncMsg}</div>}
      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : payments.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          No outgoing payments found. Sync Mercury to import payment transactions.
        </div>
      ) : (
        <div className="space-y-8">
          {pendingPayments.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-yellow-400 uppercase tracking-wider mb-3">
                Pending / Scheduled ({pendingPayments.length})
              </h2>
              <PaymentsTable payments={pendingPayments} expanded={expanded} setExpanded={setExpanded} />
            </section>
          )}
          {sentPayments.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-green-400 uppercase tracking-wider mb-3">
                Sent Payments ({sentPayments.length})
              </h2>
              <PaymentsTable payments={sentPayments} expanded={expanded} setExpanded={setExpanded} />
            </section>
          )}
        </div>
      )}
    </>
  );
}

function PaymentsTable({ payments, expanded, setExpanded }: {
  payments: PaymentTransaction[];
  expanded: number | null;
  setExpanded: (id: number | null) => void;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
      <table className="w-full text-sm min-w-[900px]">
        <thead>
          <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Vendor / Counterparty</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3">Invoice Preview</th>
            <th className="px-4 py-3">Mercury Status</th>
            <th className="px-4 py-3">JE Status</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <>
              <tr
                key={p.id}
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/40 cursor-pointer transition-colors ${expanded === p.id ? "bg-gray-800/60" : ""}`}
              >
                <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">{formatDate(p.date)}</td>
                <td className="px-4 py-3 max-w-[200px]">
                  <p className="text-white text-xs font-medium truncate">{p.counterparty_name || p.description || "—"}</p>
                  {p.payment_method && <p className="text-gray-500 text-xs">{p.payment_method}</p>}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-red-400 whitespace-nowrap text-xs">{formatAmount(p.amount)}</td>
                <td className="px-4 py-3 max-w-[260px]">
                  {p.invoice_text ? (
                    <p className="text-gray-400 text-xs truncate italic">{p.invoice_text.slice(0, 100)}</p>
                  ) : (
                    <span className="text-gray-600 text-xs">No invoice attached</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${MERCURY_STATUS_BADGE[p.mercury_status ?? ""] ?? "bg-gray-800 text-gray-400 border border-gray-700"}`}>
                    {p.mercury_status || "unknown"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${p.je_count > 0 ? "bg-indigo-900 text-indigo-300 border border-indigo-700" : "bg-gray-800 text-gray-500 border border-gray-700"}`}>
                    {p.je_count > 0 ? `${p.je_count} JE${p.je_count > 1 ? "s" : ""}` : "Uncoded"}
                  </span>
                </td>
              </tr>
              {expanded === p.id && (
                <tr key={`${p.id}-exp`} className="bg-gray-800/30 border-b border-gray-800">
                  <td colSpan={6} className="px-6 py-4">
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div><span className="text-gray-500">Mercury ID:</span> <span className="text-gray-300 font-mono">{p.mercury_transaction_id || "—"}</span></div>
                      <div><span className="text-gray-500">Account:</span> <span className="text-gray-300">{p.mercury_account_name || "—"}</span></div>
                      <div><span className="text-gray-500">Method:</span> <span className="text-gray-300">{p.payment_method || "—"}</span></div>
                      <div><span className="text-gray-500">Invoice #:</span> <span className="text-gray-300">{p.invoice_number || "—"}</span></div>
                      {p.invoice_text && (
                        <div className="col-span-2">
                          <span className="text-gray-500">Invoice:</span>
                          <p className="text-gray-300 mt-1 whitespace-pre-wrap">{p.invoice_text.slice(0, 400)}</p>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Accruals Tab ──────────────────────────────────────────────────────────────

function AccrualsTab({ clientId }: { clientId: number }) {
  const [accruals, setAccruals] = useState<AccruedExpense[]>([]);
  const [summary, setSummary] = useState<AccrualSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<AccrualSuggestion[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Add form state
  const [form, setForm] = useState({
    vendor_name: "", description: "", service_period: currentMonth(),
    amount: "", expense_account: "Professional Services", accrued_account: "Accrued Expenses",
  });

  useEffect(() => { loadAccruals(); }, [clientId]);

  function loadAccruals() {
    setLoading(true);
    getAccruals(clientId)
      .then(({ summary: s, accruals: a }) => { setSummary(s); setAccruals(a); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setAnalyzeMsg(null);
    setSuggestions([]);
    try {
      const { suggestions: s } = await analyzeForAccruals(clientId);
      setSuggestions(s);
      setAnalyzeMsg(s.length > 0 ? `Found ${s.length} suggested accrual${s.length > 1 ? "s" : ""}.` : "No new accruals suggested from recent payments.");
    } catch (e: unknown) {
      setAnalyzeMsg(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function acceptSuggestion(s: AccrualSuggestion, amount: number) {
    await createAccrual(clientId, {
      vendor_name: s.vendor_name,
      description: s.description,
      service_period: s.service_period,
      amount,
      source_transaction_id: s.transaction_id,
      expense_account: s.expense_account,
      accrued_account: s.accrued_account,
    });
    setSuggestions((prev) => prev.filter((x) => x.transaction_id !== s.transaction_id));
    loadAccruals();
  }

  async function handleAddManual(e: React.FormEvent) {
    e.preventDefault();
    await createAccrual(clientId, {
      ...form,
      amount: parseFloat(form.amount),
    });
    setForm({ vendor_name: "", description: "", service_period: currentMonth(), amount: "", expense_account: "Professional Services", accrued_account: "Accrued Expenses" });
    setShowAddForm(false);
    loadAccruals();
  }

  async function handleStatusChange(ae: AccruedExpense, status: string) {
    await updateAccrual(clientId, ae.id, { status });
    loadAccruals();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this accrual entry?")) return;
    await deleteAccrual(clientId, id);
    loadAccruals();
  }

  async function handleRelease(id: number) {
    await releaseAccrual(clientId, id);
    loadAccruals();
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const r = await generateFromStandingRules(clientId);
      loadAccruals();
      setAnalyzeMsg(`Generated ${r.generated.length} accrual${r.generated.length !== 1 ? "s" : ""} from standing rules for ${r.month}.`);
    } catch (e: unknown) {
      setAnalyzeMsg(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return (
    <div className="flex justify-center h-40 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Accrued Expenses</h1>
          <p className="text-gray-500 mt-1 text-xs">Track expenses incurred but not yet paid</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate from Rules"}
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {analyzing ? (
              <><span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin inline-block mr-1" />Analyzing…</>
            ) : "AI Analyze Payments"}
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            + Add Accrual
          </button>
        </div>
      </div>

      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}
      {analyzeMsg && <div className="mb-4 bg-indigo-950 border border-indigo-800 text-indigo-300 rounded-lg px-4 py-3 text-sm">{analyzeMsg}</div>}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Total Accrued (Outstanding)</p>
            <p className="text-2xl font-bold text-white">{formatAmount(summary.total_accrued)}</p>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Items Pending Payment</p>
            <p className="text-2xl font-bold text-yellow-400">{summary.pending_payment_count}</p>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Cleared This Month</p>
            <p className="text-2xl font-bold text-green-400">{summary.cleared_this_month}</p>
            {summary.cleared_this_month > 0 && (
              <p className="text-xs text-gray-500 mt-0.5">{formatAmount(summary.cleared_this_month_amount)}</p>
            )}
          </div>
        </div>
      )}

      {/* AI Suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-6 bg-indigo-950/40 border border-indigo-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-indigo-300 mb-3">AI Suggestions — Review & Accept</h3>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <SuggestionRow key={s.transaction_id} suggestion={s} onAccept={acceptSuggestion} onDismiss={() => setSuggestions((prev) => prev.filter((x) => x.transaction_id !== s.transaction_id))} />
            ))}
          </div>
        </div>
      )}

      {/* Add Form */}
      {showAddForm && (
        <div className="mb-6 bg-gray-900 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Add Accrual Entry</h3>
          <form onSubmit={handleAddManual} className="grid grid-cols-2 gap-3">
            <input required placeholder="Vendor name" value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input required type="month" value={form.service_period} onChange={(e) => setForm({ ...form, service_period: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500" />
            <input required type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input required placeholder="Expense account" value={form.expense_account} onChange={(e) => setForm({ ...form, expense_account: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input required placeholder="Accrued account" value={form.accrued_account} onChange={(e) => setForm({ ...form, accrued_account: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <div className="col-span-2 flex gap-2 justify-end">
              <button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">Add Accrual</button>
            </div>
          </form>
        </div>
      )}

      {/* Schedule Table */}
      {accruals.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          No accrued expenses yet. Use AI Analyze to detect accruals from your payments, or add one manually.
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Service Period</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Exp. Payment</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accruals.map((ae) => (
                <tr key={ae.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 text-white text-xs font-medium">{ae.vendor_name}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{ae.description || "—"}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs font-mono">{ae.service_period}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono font-medium text-red-400">{formatAmount(ae.amount)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">{formatDate(ae.expected_payment_date)}</td>
                  <td className="px-4 py-3">
                    <select
                      value={ae.status}
                      onChange={(e) => handleStatusChange(ae, e.target.value)}
                      className={`text-xs rounded-full px-2 py-0.5 border font-medium bg-transparent cursor-pointer ${ACCRUAL_STATUS_BADGE[ae.status] ?? "text-gray-400 border-gray-700"}`}
                    >
                      <option value="accrued">Accrued</option>
                      <option value="partially_paid">Partially Paid</option>
                      <option value="cleared">Cleared</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {!ae.accrual_je_id && ae.debit_account && (
                        <button
                          onClick={() => handleRelease(ae.id)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors whitespace-nowrap"
                        >
                          + Review Queue
                        </button>
                      )}
                      {ae.accrual_je_id && (
                        <span className="text-xs text-green-500">In Queue</span>
                      )}
                      <button onClick={() => handleDelete(ae.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SuggestionRow({ suggestion: s, onAccept, onDismiss }: {
  suggestion: AccrualSuggestion;
  onAccept: (s: AccrualSuggestion, amount: number) => Promise<void>;
  onDismiss: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [amount, setAmount] = useState(String(s.amount ?? ""));

  async function handle() {
    const parsed = parseFloat(amount);
    if (!parsed || isNaN(parsed)) return;
    setAccepting(true);
    try { await onAccept(s, parsed); } finally { setAccepting(false); }
  }

  return (
    <div className="flex items-center gap-3 bg-indigo-950/60 rounded-lg p-3 text-xs">
      <div className="flex-1 min-w-0">
        <p className="text-white font-medium">{s.vendor_name} <span className="text-indigo-400 font-mono ml-1">{s.service_period}</span></p>
        <p className="text-gray-400 truncate">{s.expense_account} → {s.accrued_account}</p>
        <p className="text-gray-500 truncate">{s.description}</p>
      </div>
      <input
        type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount"
        className="w-28 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-indigo-500"
      />
      <div className="flex gap-1.5">
        <button onClick={handle} disabled={accepting || !amount}
          className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors">
          {accepting ? "…" : "Accept"}
        </button>
        <button onClick={onDismiss} className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors">Dismiss</button>
      </div>
    </div>
  );
}

// ── Standing Rules Tab ────────────────────────────────────────────────────────

function StandingRulesTab({ clientId }: { clientId: number }) {
  const [rules, setRules] = useState<StandingAccrualRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    vendor_name: "", description: "", expense_account: "",
    accrued_account: "Accrued Expenses", amount: "",
  });

  useEffect(() => { loadRules(); }, [clientId]);

  function loadRules() {
    setLoading(true);
    getStandingRules(clientId)
      .then(setRules)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createStandingRule(clientId, {
      ...form,
      amount: form.amount ? parseFloat(form.amount) : undefined,
    });
    setForm({ vendor_name: "", description: "", expense_account: "", accrued_account: "Accrued Expenses", amount: "" });
    setShowForm(false);
    loadRules();
  }

  async function handleToggle(rule: StandingAccrualRule) {
    await updateStandingRule(clientId, rule.id, { active: !rule.active });
    loadRules();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this standing rule?")) return;
    await deleteStandingRule(clientId, id);
    loadRules();
  }

  if (loading) return (
    <div className="flex justify-center h-40 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Standing Accrual Rules</h1>
          <p className="text-gray-500 mt-1 text-xs">Recurring expenses that accrue each month (rent, subscriptions, etc.)</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
        >
          + New Rule
        </button>
      </div>

      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}

      {showForm && (
        <div className="mb-6 bg-gray-900 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3">New Standing Rule</h3>
          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-3">
            <input required placeholder="Vendor name" value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input required placeholder="Expense account" value={form.expense_account} onChange={(e) => setForm({ ...form, expense_account: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input required placeholder="Accrued liability account" value={form.accrued_account} onChange={(e) => setForm({ ...form, accrued_account: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <input type="number" step="0.01" placeholder="Fixed amount (blank = variable)" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <div className="flex items-center gap-2 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">Create Rule</button>
            </div>
          </form>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          No standing rules yet. Add recurring expenses like rent or subscriptions here.
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Expense Account</th>
                <th className="px-4 py-3">Accrued Account</th>
                <th className="px-4 py-3 text-right">Monthly Amount</th>
                <th className="px-4 py-3">Last Generated</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors ${!rule.active ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3 text-white text-xs font-medium">{rule.vendor_name}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{rule.description || "—"}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{rule.expense_account}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{rule.accrued_account}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-gray-300">
                    {rule.amount != null ? formatAmount(rule.amount) : <span className="text-gray-500 italic">variable</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono">{rule.last_generated || "—"}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleToggle(rule)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${rule.active ? "bg-indigo-600" : "bg-gray-700"}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${rule.active ? "translate-x-4" : "translate-x-1"}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleDelete(rule.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
