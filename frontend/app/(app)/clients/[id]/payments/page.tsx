"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getPayments, syncMercury, refreshMercuryInvoices, getInboundEmailAddress, PaymentTransaction,
  getAccruals, createAccrual, updateAccrual, deleteAccrual, analyzeForAccruals, releaseAccrual,
  getStandingRules, createStandingRule, updateStandingRule, deleteStandingRule,
  generateFromStandingRules, getAccrualSetupContext, setupAccrualPayment,
  AccruedExpense, AccrualSummary, AccrualSuggestion, StandingAccrualRule, AccrualSetupContext,
  getInvoices, updateInvoice, exportPrepaidSchedule, InvoiceListRow,
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

const DERIVED_STATUS_BADGE: Record<string, string> = {
  recognized: "bg-green-900 text-green-300 border border-green-700",
  pending:    "bg-yellow-900 text-yellow-300 border border-yellow-700",
  upcoming:   "bg-indigo-900 text-indigo-300 border border-indigo-700",
  cleared:    "bg-emerald-900 text-emerald-300 border border-emerald-700",
  overdue:    "bg-red-900 text-red-300 border border-red-700",
};

const DERIVED_STATUS_LABEL: Record<string, string> = {
  recognized: "Recognized",
  pending:    "Pending",
  upcoming:   "Upcoming",
  cleared:    "Cleared",
  overdue:    "Overdue",
};

const DERIVED_STATUS_DESC: Record<string, string> = {
  recognized: "Expense JE approved + sent to QBO",
  pending:    "JE in Review Queue, not yet approved",
  upcoming:   "Future month — JE not yet generated",
  cleared:    "Cash payment matched and posted",
  overdue:    "Past month — not yet recognized",
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

// Client-side fallback for derived status when the backend hasn't been deployed
// with the new logic yet. Uses only the fields that the old API returns.
function clientDerivedStatus(ae: AccruedExpense, thisMonth: string): "recognized" | "pending" | "upcoming" | "cleared" | "overdue" {
  if (ae.status === "cleared") return "cleared";
  if (ae.accrual_je_id) {
    // Has a JE in the queue. We can't tell from this endpoint whether the JE is
    // approved/exported, so default to "recognized" for past months (the common
    // case: monthly standing accruals already pushed through), "pending" otherwise.
    return ae.service_period <= thisMonth ? "recognized" : "pending";
  }
  if (ae.service_period > thisMonth) return "upcoming";
  if (ae.service_period < thisMonth) return "overdue";
  return "upcoming";
}

function clientKind(ae: AccruedExpense): "accrual" | "prepaid" {
  if (ae.kind) return ae.kind;
  return (ae.credit_account || "").toLowerCase().includes("prepaid") ? "prepaid" : "accrual";
}

type Tab = "invoices" | "payments" | "accruals" | "prepaid-expenses" | "standing-rules";

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setCurrentPage, setPageContext } = useChatContext();

  const [tab, setTab] = useState<Tab>("invoices");

  useEffect(() => {
    setCurrentPage("payments");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

  return (
    <div className="max-w-6xl">
      {/* Tabs */}
      <div className="mb-6 border-b border-gray-800">
        <nav className="flex gap-1">
          {(["invoices", "payments", "accruals", "prepaid-expenses", "standing-rules"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors capitalize ${
                tab === t
                  ? "bg-gray-900 border border-b-gray-900 border-gray-700 text-white -mb-px"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t === "standing-rules" ? "Standing Rules"
                : t === "prepaid-expenses" ? "Prepaid Expenses"
                : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {tab === "invoices" && <InvoicesTab clientId={clientId} />}
      {tab === "payments" && <PaymentsTab clientId={clientId} setPageContext={setPageContext} />}
      {tab === "accruals" && <AccrualsTab clientId={clientId} />}
      {tab === "prepaid-expenses" && <PrepaidExpensesTab clientId={clientId} />}
      {tab === "standing-rules" && <StandingRulesTab clientId={clientId} />}
    </div>
  );
}

// ── Invoices Tab (NEW) ────────────────────────────────────────────────────────

const INVOICE_STATUS_BADGE: Record<string, string> = {
  unpaid:  "bg-yellow-900 text-yellow-300 border border-yellow-700",
  partial: "bg-blue-900 text-blue-300 border border-blue-700",
  paid:    "bg-green-900 text-green-300 border border-green-700",
};

const INVOICE_TYPE_BADGE: Record<string, string> = {
  one_time:    "bg-gray-800 text-gray-300 border border-gray-700",
  accrual:     "bg-amber-900/60 text-amber-300 border border-amber-700",
  prepaid:     "bg-indigo-900 text-indigo-300 border border-indigo-700",
  fixed_asset: "bg-purple-900 text-purple-300 border border-purple-700",
};

const INVOICE_TYPE_LABEL: Record<string, string> = {
  one_time:    "One-time",
  accrual:     "Accrual",
  prepaid:     "Prepaid",
  fixed_asset: "Fixed Asset",
};

function InvoicesTab({ clientId }: { clientId: number }) {
  const [rows, setRows] = useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "unpaid" | "partial" | "paid">("all");

  useEffect(() => { load(); }, [clientId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await getInvoices(clientId);
      setRows(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }

  async function setStatus(id: number, status: "unpaid" | "partial" | "paid") {
    await updateInvoice(id, { bill_status: status });
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, bill_status: status } : r)));
  }

  const filtered = statusFilter === "all" ? rows : rows.filter((r) => r.bill_status === statusFilter);
  const unpaidTotal = rows.filter((r) => r.bill_status !== "paid").reduce((s, r) => s + r.amount, 0);

  if (loading) return (
    <div className="flex justify-center h-40 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Invoices</h1>
          <p className="text-gray-500 mt-1 text-xs">
            Vendor invoices · {rows.length} total · {formatAmount(unpaidTotal)} outstanding
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">All statuses</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partially paid</option>
            <option value="paid">Paid</option>
          </select>
          <Link
            href={`/clients/${clientId}/invoices`}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-3-3m3 3l3-3" />
            </svg>
            Invoice Upload
          </Link>
        </div>
      </div>

      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          {rows.length === 0
            ? "No invoices yet — click Invoice Upload to add one."
            : "No invoices match this filter."}
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Service Period</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatDate(r.date)}</td>
                  <td className="px-4 py-3 text-white text-xs font-medium max-w-[180px] truncate">{r.vendor || "—"}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs font-mono">{r.invoice_number || "—"}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{r.description}</td>
                  <td className="px-4 py-3 text-right font-mono font-medium text-red-400 text-xs whitespace-nowrap">{formatAmount(r.amount)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono whitespace-nowrap">
                    {r.service_period_start && r.service_period_end
                      ? `${r.service_period_start.slice(0, 7)} → ${r.service_period_end.slice(0, 7)}`
                      : r.service_period_start
                        ? r.service_period_start.slice(0, 7)
                        : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${INVOICE_TYPE_BADGE[r.invoice_type]}`}>
                      {INVOICE_TYPE_LABEL[r.invoice_type] || r.invoice_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={r.bill_status}
                      onChange={(e) => setStatus(r.id, e.target.value as "unpaid" | "partial" | "paid")}
                      className={`text-xs rounded-full px-2 py-0.5 border font-medium bg-transparent cursor-pointer ${INVOICE_STATUS_BADGE[r.bill_status]}`}
                    >
                      <option value="unpaid">Unpaid</option>
                      <option value="partial">Partial</option>
                      <option value="paid">Paid</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700 capitalize">
                      {r.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/clients/${clientId}/invoices?tx=${r.id}`}
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Edit
                    </Link>
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
  const [standingRules, setStandingRules] = useState<StandingAccrualRule[]>([]);
  const [setupTxId, setSetupTxId] = useState<number | null>(null);

  useEffect(() => {
    loadPayments();
    getInboundEmailAddress().then((r) => setInboundEmail(r.address || null)).catch(() => {});
    getStandingRules(clientId).then(setStandingRules).catch(() => {});
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

  async function handleRefreshInvoices() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await refreshMercuryInvoices(clientId);
      setSyncMsg(`Mercury invoice refresh: scanned ${r.scanned}, pulled ${r.fetched} invoice${r.fetched === 1 ? "" : "s"}.${r.errors.length ? ` ${r.errors.length} error(s).` : ""}`);
      loadPayments();
    } catch (err: unknown) {
      setSyncMsg(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setSyncing(false);
    }
  }

  function isAccrualVendor(p: PaymentTransaction): boolean {
    const vendor = (p.counterparty_name || p.description || "").toLowerCase();
    return standingRules.some(
      (r) => vendor.includes(r.vendor_name.toLowerCase()) || r.vendor_name.toLowerCase().includes(vendor)
    );
  }

  const sentPayments = payments.filter((p) => p.mercury_status !== "pending");
  const pendingPayments = payments.filter((p) => p.mercury_status === "pending");

  return (
    <>
      {setupTxId !== null && (
        <AccrualSetupModal
          clientId={clientId}
          transactionId={setupTxId}
          onClose={() => setSetupTxId(null)}
          onDone={() => { setSetupTxId(null); loadPayments(); }}
        />
      )}
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
            onClick={handleRefreshInvoices}
            disabled={syncing}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 text-gray-200 text-sm font-medium rounded-lg transition-colors"
            title="Re-pull invoice attachments from Mercury for any payment missing one"
          >
            Refresh Invoices
          </button>
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
              <PaymentsTable payments={pendingPayments} expanded={expanded} setExpanded={setExpanded} isAccrualVendor={isAccrualVendor} onSetupAccrual={setSetupTxId} />
            </section>
          )}
          {sentPayments.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-green-400 uppercase tracking-wider mb-3">
                Sent Payments ({sentPayments.length})
              </h2>
              <PaymentsTable payments={sentPayments} expanded={expanded} setExpanded={setExpanded} isAccrualVendor={isAccrualVendor} onSetupAccrual={setSetupTxId} />
            </section>
          )}
        </div>
      )}
    </>
  );
}

function PaymentsTable({ payments, expanded, setExpanded, isAccrualVendor, onSetupAccrual }: {
  payments: PaymentTransaction[];
  expanded: number | null;
  setExpanded: (id: number | null) => void;
  isAccrualVendor: (p: PaymentTransaction) => boolean;
  onSetupAccrual: (txId: number) => void;
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
                  {p.matched_invoice ? (
                    <div className="text-xs">
                      <p className="text-amber-300 font-medium">🔗 Matched: {p.matched_invoice.vendor}</p>
                      <p className="text-gray-500 font-mono">
                        {p.matched_invoice.invoice_number ? `#${p.matched_invoice.invoice_number} · ` : ""}
                        ${p.matched_invoice.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  ) : p.invoice_text ? (
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
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${p.je_count > 0 ? "bg-indigo-900 text-indigo-300 border border-indigo-700" : "bg-gray-800 text-gray-500 border border-gray-700"}`}>
                      {p.je_count > 0 ? `${p.je_count} JE${p.je_count > 1 ? "s" : ""}` : "Uncoded"}
                    </span>
                    {isAccrualVendor(p) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onSetupAccrual(p.id); }}
                        className="px-2 py-0.5 text-xs bg-amber-900/60 hover:bg-amber-800 text-amber-300 border border-amber-700 rounded-full transition-colors whitespace-nowrap"
                      >
                        Set Up Accrual
                      </button>
                    )}
                  </div>
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

// ── Accrual Setup Modal ───────────────────────────────────────────────────────

function AccrualSetupModal({ clientId, transactionId, onClose, onDone }: {
  clientId: number;
  transactionId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [ctx, setCtx] = useState<AccrualSetupContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Clearing amounts keyed by accrual id
  const [clearingAmounts, setClearingAmounts] = useState<Record<number, string>>({});
  const [selectedAccruals, setSelectedAccruals] = useState<Set<number>>(new Set());

  // Prepaid config
  const [hasPrepaid, setHasPrepaid] = useState(false);
  const [prepaid, setPrepaid] = useState({
    account: "Prepaid Insurance",
    monthly_amount: "",
    start_period: currentMonth(),
    end_period: "",
    description: "",
    expense_account: "",
  });

  const [bankAccount, setBankAccount] = useState("Mercury Checking");

  useEffect(() => {
    setLoading(true);
    getAccrualSetupContext(clientId, transactionId)
      .then((data) => {
        setCtx(data);
        // Pre-select all open accruals and pre-fill their amounts
        const sel = new Set<number>();
        const amounts: Record<number, string> = {};
        for (const ae of data.open_accruals) {
          sel.add(ae.id);
          amounts[ae.id] = String(ae.amount);
        }
        setSelectedAccruals(sel);
        setClearingAmounts(amounts);
        // Pre-fill prepaid description from vendor
        setPrepaid((p) => ({ ...p, description: `Prepaid: ${data.transaction.vendor}` }));
        // Pre-fill expense account from matching rule if available
        if (data.matching_rules.length > 0) {
          setPrepaid((p) => ({ ...p, expense_account: data.matching_rules[0].expense_account }));
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clientId, transactionId]);

  const txAmount = ctx ? Math.abs(ctx.transaction.amount) : 0;
  const clearingTotal = Array.from(selectedAccruals).reduce((sum, id) => {
    return sum + (parseFloat(clearingAmounts[id] || "0") || 0);
  }, 0);
  const prepaidAmount = hasPrepaid ? (txAmount - clearingTotal) : 0;
  const remainder = txAmount - clearingTotal - (hasPrepaid ? prepaidAmount : 0);
  const isBalanced = Math.abs(remainder) < 0.02;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setSaving(true);
    setError(null);
    try {
      const clearings = Array.from(selectedAccruals).map((id) => ({
        accrual_id: id,
        amount: parseFloat(clearingAmounts[id] || "0"),
      }));

      const payload: Parameters<typeof setupAccrualPayment>[1] = {
        transaction_id: transactionId,
        clearings,
        bank_account: bankAccount,
      };

      if (hasPrepaid && prepaidAmount > 0) {
        payload.prepaid = {
          account: prepaid.account,
          amount: prepaidAmount,
          monthly_amount: parseFloat(prepaid.monthly_amount || "0"),
          start_period: prepaid.start_period,
          end_period: prepaid.end_period,
          description: prepaid.description,
          expense_account: prepaid.expense_account,
        };
      }

      await setupAccrualPayment(clientId, payload);
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Setup failed");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Accrual Payment Setup</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-40">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !ctx ? (
          <div className="p-6 text-red-400 text-sm">{error || "Failed to load context"}</div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* Transaction summary */}
            <div className="bg-gray-800 rounded-xl p-4 text-xs">
              <p className="text-gray-400 mb-1">Payment</p>
              <p className="text-white font-medium">{ctx.transaction.vendor}</p>
              <p className="text-red-400 font-mono text-lg font-bold mt-1">{formatAmount(ctx.transaction.amount)}</p>
              <p className="text-gray-500 mt-0.5">{formatDate(ctx.transaction.date)} · {ctx.transaction.mercury_account_name || "Mercury"}</p>
            </div>

            {/* Open accruals to clear */}
            <div>
              <h3 className="text-sm font-semibold text-white mb-3">Clear Accruals</h3>
              {ctx.open_accruals.length === 0 ? (
                <p className="text-gray-500 text-xs">No open accruals found for this vendor.</p>
              ) : (
                <div className="space-y-2">
                  {ctx.open_accruals.map((ae) => (
                    <div key={ae.id} className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selectedAccruals.has(ae.id)}
                        onChange={(e) => {
                          const next = new Set(selectedAccruals);
                          if (e.target.checked) next.add(ae.id); else next.delete(ae.id);
                          setSelectedAccruals(next);
                        }}
                        className="w-4 h-4 accent-indigo-500"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-medium">{ae.vendor_name} <span className="text-gray-500 font-mono ml-1">{ae.service_period}</span></p>
                        <p className="text-gray-500 text-xs truncate">{ae.description || ""}</p>
                      </div>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${ACCRUAL_STATUS_BADGE[ae.status] ?? "text-gray-400 border-gray-700"}`}>
                        {ae.status}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        value={clearingAmounts[ae.id] ?? ""}
                        onChange={(e) => setClearingAmounts({ ...clearingAmounts, [ae.id]: e.target.value })}
                        disabled={!selectedAccruals.has(ae.id)}
                        className="w-28 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                        placeholder="Amount"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Prepaid split */}
            <div>
              <label className="flex items-center gap-2 text-sm font-semibold text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasPrepaid}
                  onChange={(e) => setHasPrepaid(e.target.checked)}
                  className="w-4 h-4 accent-indigo-500"
                />
                Book remainder as Prepaid Expense
              </label>
              {hasPrepaid && (
                <div className="mt-3 space-y-3 bg-gray-800/60 rounded-xl p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Prepaid Account</label>
                      <input
                        value={prepaid.account}
                        onChange={(e) => setPrepaid({ ...prepaid, account: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                        placeholder="Prepaid Insurance"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Expense Account (monthly DR)</label>
                      <input
                        value={prepaid.expense_account}
                        onChange={(e) => setPrepaid({ ...prepaid, expense_account: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                        placeholder="Officers' life insurance"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Monthly Amortization Amount</label>
                      <input
                        type="number" step="0.01"
                        value={prepaid.monthly_amount}
                        onChange={(e) => setPrepaid({ ...prepaid, monthly_amount: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                        placeholder="372.29"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Description</label>
                      <input
                        value={prepaid.description}
                        onChange={(e) => setPrepaid({ ...prepaid, description: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                        placeholder="Prepaid Insurance premium"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Start Period (YYYY-MM)</label>
                      <input
                        type="month"
                        value={prepaid.start_period}
                        onChange={(e) => setPrepaid({ ...prepaid, start_period: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">End Period (YYYY-MM)</label>
                      <input
                        type="month"
                        value={prepaid.end_period}
                        onChange={(e) => setPrepaid({ ...prepaid, end_period: e.target.value })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                  {prepaidAmount > 0 && (
                    <p className="text-xs text-amber-400 font-mono">Prepaid amount: {formatAmount(prepaidAmount)}</p>
                  )}
                </div>
              )}
            </div>

            {/* Bank account */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Bank / Credit Account</label>
              <input
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Balance check */}
            <div className={`rounded-lg px-4 py-3 text-xs font-mono ${isBalanced ? "bg-green-950 border border-green-800 text-green-300" : "bg-red-950 border border-red-800 text-red-300"}`}>
              {isBalanced
                ? `Balanced: ${formatAmount(txAmount)} = ${formatAmount(clearingTotal)} cleared${hasPrepaid && prepaidAmount > 0 ? ` + ${formatAmount(prepaidAmount)} prepaid` : ""}`
                : `Unbalanced: ${formatAmount(clearingTotal + (hasPrepaid ? prepaidAmount : 0))} allocated of ${formatAmount(txAmount)} (${formatAmount(Math.abs(remainder))} ${remainder > 0 ? "under" : "over"})`
              }
            </div>

            {error && <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-xs">{error}</div>}

            <div className="flex gap-3 justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
              <button
                type="submit"
                disabled={saving || !isBalanced}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? "Saving…" : "Save Journal Entries"}
              </button>
            </div>
          </form>
        )}
      </div>
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
  const [editing, setEditing] = useState<AccruedExpense | null>(null);

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
          <h1 className="text-2xl font-bold text-white">Accruals</h1>
          <p className="text-gray-500 mt-1 text-xs">Expenses incurred but not yet cash-paid</p>
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

      {/* Status legend */}
      <div className="mb-4 bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Status legend</p>
        <div className="flex flex-wrap gap-3">
          {(["recognized", "pending", "upcoming", "cleared", "overdue"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-medium ${DERIVED_STATUS_BADGE[s]}`}>{DERIVED_STATUS_LABEL[s]}</span>
              <span className="text-gray-500">{DERIVED_STATUS_DESC[s]}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Summary Cards — accrual-only totals (client-side) */}
      {(() => {
        const thisMonth = currentMonth();
        // Filter to accrual rows only (this tab is now accruals-only)
        const accrualRows = accruals.filter((a) => clientKind(a) === "accrual");
        let outstanding = 0, overdueAmt = 0, clearedThisMonthCount = 0, clearedThisMonthAmt = 0;
        for (const a of accrualRows) {
          const d = a.derived_status ?? clientDerivedStatus(a, thisMonth);
          if (d === "recognized") outstanding += a.amount;
          if (d === "overdue") overdueAmt += a.amount;
          if (d === "cleared" && a.service_period === thisMonth) {
            clearedThisMonthCount += 1;
            clearedThisMonthAmt += a.amount;
          }
        }
        return (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <p className="text-xs text-gray-500 mb-1">Outstanding Accruals</p>
              <p className="text-2xl font-bold text-white">{formatAmount(outstanding)}</p>
              <p className="text-xs text-gray-500 mt-0.5">Recognized but not yet Cleared</p>
            </div>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <p className="text-xs text-gray-500 mb-1">Overdue</p>
              <p className="text-2xl font-bold text-red-400">{formatAmount(overdueAmt)}</p>
              <p className="text-xs text-gray-500 mt-0.5">Past-period entries not yet Recognized</p>
            </div>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <p className="text-xs text-gray-500 mb-1">Cleared This Month</p>
              <p className="text-2xl font-bold text-green-400">{clearedThisMonthCount}</p>
              {clearedThisMonthCount > 0 && (
                <p className="text-xs text-gray-500 mt-0.5">{formatAmount(clearedThisMonthAmt)}</p>
              )}
            </div>
          </div>
        );
      })()}

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

      {/* Accruals table (kind=accrual only — prepaid items live on the Prepaid Expenses tab) */}
      {(() => {
        const accrualRows = accruals.filter((a) => clientKind(a) === "accrual");
        if (accrualRows.length === 0) {
          return (
            <div className="text-center py-20 text-gray-500">
              No accruals yet. Use AI Analyze to detect them from payments, or add one manually.
            </div>
          );
        }
        const thisMonth = currentMonth();
        return (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
            <table className="w-full text-sm min-w-[1000px]">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Linked Invoice</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accrualRows.map((ae) => {
                  const derived = ae.derived_status ?? clientDerivedStatus(ae, thisMonth);
                  return (
                    <tr key={ae.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 text-white text-xs font-medium">{ae.vendor_name}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{ae.description || "—"}</td>
                      <td className="px-4 py-3 text-gray-300 text-xs font-mono">{ae.service_period}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono font-medium text-red-400">{formatAmount(ae.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${DERIVED_STATUS_BADGE[derived]}`}>
                          {DERIVED_STATUS_LABEL[derived]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {ae.source_transaction_id ? (
                          <span className="font-mono">#{ae.source_transaction_id}</span>
                        ) : "—"}
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
                          {ae.status !== "cleared" && (
                            <button onClick={() => setEditing(ae)} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Edit</button>
                          )}
                          <button onClick={() => handleDelete(ae.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Edit modal */}
      {editing && (
        <EditAccrualModal
          accrual={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await updateAccrual(clientId, editing.id, patch);
            setEditing(null);
            loadAccruals();
          }}
        />
      )}
    </>
  );
}

// ── Prepaid Expenses Tab ──────────────────────────────────────────────────────

function PrepaidExpensesTab({ clientId }: { clientId: number }) {
  const [accruals, setAccruals] = useState<AccruedExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccruedExpense | null>(null);
  const [subTab, setSubTab] = useState<"all" | "prepaid">("all");
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { load(); }, [clientId]);

  function load() {
    setLoading(true);
    getAccruals(clientId)
      .then(({ accruals: a }) => setAccruals(a))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this prepaid entry?")) return;
    await deleteAccrual(clientId, id);
    load();
  }

  async function handleRelease(id: number) {
    await releaseAccrual(clientId, id);
    load();
  }

  async function handleExport() {
    setExporting(true);
    setMsg(null);
    try {
      const blob = await exportPrepaidSchedule(clientId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prepaid-schedule-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  if (loading) return (
    <div className="flex justify-center h-40 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const thisMonth = currentMonth();
  const prepaidRows = accruals.filter((a) => clientKind(a) === "prepaid");

  // Group by vendor + description so "Fully Amortized" counts complete schedules
  const schedules = new Map<string, AccruedExpense[]>();
  for (const a of prepaidRows) {
    const key = `${a.vendor_name}::${a.description || ""}`;
    const list = schedules.get(key) || [];
    list.push(a);
    schedules.set(key, list);
  }
  let prepaidBalance = 0;
  let upcomingThisMonth = 0;
  let fullyAmortized = 0;
  Array.from(schedules.values()).forEach((list: AccruedExpense[]) => {
    const allCleared = list.every((a) => {
      const d = a.derived_status ?? clientDerivedStatus(a, thisMonth);
      return d === "cleared" || d === "recognized";
    });
    if (allCleared) fullyAmortized += 1;
  });
  for (const a of prepaidRows) {
    const d = a.derived_status ?? clientDerivedStatus(a, thisMonth);
    if (d === "upcoming" || d === "pending") prepaidBalance += a.amount;
    if (d === "upcoming" && a.service_period === thisMonth) upcomingThisMonth += a.amount;
  }

  return (
    <>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Prepaid Expenses</h1>
          <p className="text-gray-500 mt-1 text-xs">Expenses paid upfront, amortized monthly</p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 rounded-lg transition-colors disabled:opacity-50"
        >
          {exporting ? "Exporting…" : "Export Prepaid Schedule"}
        </button>
      </div>

      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}
      {msg && <div className="mb-4 bg-indigo-950 border border-indigo-800 text-indigo-300 rounded-lg px-4 py-3 text-sm">{msg}</div>}

      {/* Status legend */}
      <div className="mb-4 bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Status legend</p>
        <div className="flex flex-wrap gap-3">
          {(["recognized", "pending", "upcoming", "cleared", "overdue"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-medium ${DERIVED_STATUS_BADGE[s]}`}>{DERIVED_STATUS_LABEL[s]}</span>
              <span className="text-gray-500">{DERIVED_STATUS_DESC[s]}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Prepaid Balance</p>
          <p className="text-2xl font-bold text-indigo-400">{formatAmount(prepaidBalance)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Total remaining not yet amortized</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Upcoming This Month</p>
          <p className="text-2xl font-bold text-yellow-400">{formatAmount(upcomingThisMonth)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Need to be generated and approved</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Fully Amortized</p>
          <p className="text-2xl font-bold text-green-400">{fullyAmortized}</p>
          <p className="text-xs text-gray-500 mt-0.5">Completed prepaid items</p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="mb-4 border-b border-gray-800">
        <nav className="flex gap-1">
          {(["all", "prepaid"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                subTab === t
                  ? "bg-gray-900 border border-b-gray-900 border-gray-700 text-white -mb-px"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t === "all" ? "All Entries" : "Prepaid Schedule"}
            </button>
          ))}
        </nav>
      </div>

      {/* All Entries */}
      {subTab === "all" && (
        prepaidRows.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            No prepaid expenses yet. Upload a multi-month invoice on the Invoices tab to create one.
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
            <table className="w-full text-sm min-w-[1000px]">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Linked Invoice</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {prepaidRows.map((ae) => {
                  const derived = ae.derived_status ?? clientDerivedStatus(ae, thisMonth);
                  return (
                    <tr key={ae.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 text-white text-xs font-medium">{ae.vendor_name}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{ae.description || "—"}</td>
                      <td className="px-4 py-3 text-gray-300 text-xs font-mono">{ae.service_period}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono font-medium text-red-400">{formatAmount(ae.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${DERIVED_STATUS_BADGE[derived]}`}>
                          {DERIVED_STATUS_LABEL[derived]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {ae.source_transaction_id ? <span className="font-mono">#{ae.source_transaction_id}</span> : "—"}
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
                          {ae.accrual_je_id && <span className="text-xs text-green-500">In Queue</span>}
                          {ae.status !== "cleared" && (
                            <button onClick={() => setEditing(ae)} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Edit</button>
                          )}
                          <button onClick={() => handleDelete(ae.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Prepaid Schedule */}
      {subTab === "prepaid" && <PrepaidScheduleView accruals={accruals} />}

      {/* Edit modal */}
      {editing && (
        <EditAccrualModal
          accrual={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await updateAccrual(clientId, editing.id, patch);
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function PrepaidScheduleView({ accruals }: { accruals: AccruedExpense[] }) {
  const prepaid = accruals.filter((a) => a.kind === "prepaid" || (a.credit_account || "").toLowerCase().includes("prepaid"));

  if (prepaid.length === 0) {
    return (
      <div className="text-center py-20 text-gray-500 bg-gray-900 rounded-xl border border-gray-800">
        No prepaid amortization schedules yet. Upload a multi-month invoice on the Invoices tab to create one.
      </div>
    );
  }

  // Build vendor × month grid
  const months = Array.from(new Set(prepaid.map((a) => a.service_period))).sort();
  type Row = { vendor: string; description: string; cells: Record<string, AccruedExpense | undefined> };
  const rowMap = new Map<string, Row>();
  for (const a of prepaid) {
    const key = `${a.vendor_name}::${a.description || ""}`;
    let r = rowMap.get(key);
    if (!r) {
      r = { vendor: a.vendor_name, description: a.description || "", cells: {} };
      rowMap.set(key, r);
    }
    r.cells[a.service_period] = a;
  }
  const rows = Array.from(rowMap.values()).sort((a, b) => a.vendor.localeCompare(b.vendor));

  const thisMonth = currentMonth();
  function statusIcon(ae: AccruedExpense | undefined) {
    if (!ae) return <span className="text-gray-700">—</span>;
    const s = ae.derived_status ?? clientDerivedStatus(ae, thisMonth);
    if (s === "recognized" || s === "cleared") {
      return <span className="text-green-400" title={DERIVED_STATUS_LABEL[s]}>✓</span>;
    }
    if (s === "overdue") {
      return <span className="text-red-400" title="Overdue">!</span>;
    }
    return <span className="text-indigo-400" title="Upcoming/Pending">◷</span>;
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800 text-left text-gray-400 font-medium">
            <th className="px-3 py-2 sticky left-0 bg-gray-900 z-10">Vendor</th>
            <th className="px-3 py-2 sticky left-[140px] bg-gray-900 z-10">Description</th>
            {months.map((m) => (
              <th key={m} className="px-2 py-2 text-center font-mono whitespace-nowrap">{m}</th>
            ))}
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const total = Object.values(r.cells).reduce((s, c) => s + (c ? c.amount : 0), 0);
            return (
              <tr key={`${r.vendor}-${r.description}`} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                <td className="px-3 py-2 text-white font-medium whitespace-nowrap sticky left-0 bg-gray-900 z-10">{r.vendor}</td>
                <td className="px-3 py-2 text-gray-400 truncate max-w-[200px] sticky left-[140px] bg-gray-900 z-10">{r.description}</td>
                {months.map((m) => {
                  const c = r.cells[m];
                  return (
                    <td key={m} className="px-2 py-2 text-center whitespace-nowrap">
                      {c ? (
                        <div className="flex flex-col items-center">
                          {statusIcon(c)}
                          <span className="text-gray-500 font-mono">{formatAmount(c.amount)}</span>
                        </div>
                      ) : <span className="text-gray-700">·</span>}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-mono font-medium text-red-400 whitespace-nowrap">{formatAmount(total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EditAccrualModal({
  accrual, onClose, onSave,
}: {
  accrual: AccruedExpense;
  onClose: () => void;
  onSave: (patch: Partial<AccruedExpense>) => Promise<void>;
}) {
  const [vendor_name, setVendorName] = useState(accrual.vendor_name);
  const [description, setDescription] = useState(accrual.description ?? "");
  const [service_period, setServicePeriod] = useState(accrual.service_period);
  const [amount, setAmount] = useState(String(accrual.amount));
  const [debit_account, setDebitAccount] = useState(accrual.debit_account ?? "");
  const [credit_account, setCreditAccount] = useState(accrual.credit_account ?? "");
  const [expected_payment_date, setExpectedPaymentDate] = useState(
    accrual.expected_payment_date ? accrual.expected_payment_date.slice(0, 10) : ""
  );
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        vendor_name,
        description: description || undefined,
        service_period,
        amount: parseFloat(amount),
        debit_account: debit_account || undefined,
        credit_account: credit_account || undefined,
        expected_payment_date: expected_payment_date || undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Edit Accrual / Prepaid</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-gray-400 col-span-2">
            Vendor
            <input
              type="text" value={vendor_name} onChange={(e) => setVendorName(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400 col-span-2">
            Description
            <input
              type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Service Period (YYYY-MM)
            <input
              type="text" value={service_period} onChange={(e) => setServicePeriod(e.target.value)}
              placeholder="2026-04" pattern="\d{4}-\d{2}"
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Amount
            <input
              type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Debit Account (Expense)
            <input
              type="text" value={debit_account} onChange={(e) => setDebitAccount(e.target.value)}
              placeholder="e.g. Business insurance"
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Credit Account (Liability or Asset)
            <input
              type="text" value={credit_account} onChange={(e) => setCreditAccount(e.target.value)}
              placeholder="e.g. Accrued Expenses or Prepaid expenses"
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs text-gray-400 col-span-2">
            Expected Payment Date
            <input
              type="date" value={expected_payment_date} onChange={(e) => setExpectedPaymentDate(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            type="submit" disabled={saving}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
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
