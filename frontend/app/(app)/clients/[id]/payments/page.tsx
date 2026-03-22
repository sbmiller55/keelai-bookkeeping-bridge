"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getPayments, syncMercury, getInboundEmailAddress, PaymentTransaction } from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

const MERCURY_STATUS_BADGE: Record<string, string> = {
  pending:   "bg-yellow-900 text-yellow-300 border border-yellow-700",
  scheduled: "bg-blue-900 text-blue-300 border border-blue-700",
  sent:      "bg-green-900 text-green-300 border border-green-700",
  failed:    "bg-red-900 text-red-300 border border-red-700",
  cancelled: "bg-gray-800 text-gray-400 border border-gray-700",
};

const JE_STATUS_BADGE: Record<string, string> = {
  coded:    "bg-indigo-900 text-indigo-300 border border-indigo-700",
  uncoded:  "bg-gray-800 text-gray-500 border border-gray-700",
};

function formatAmount(amount: number): string {
  return `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PaymentsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setCurrentPage, setPageContext } = useChatContext();

  const [payments, setPayments] = useState<PaymentTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [inboundEmail, setInboundEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCurrentPage("payments");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

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
          id: p.id,
          date: p.date,
          vendor: p.counterparty_name,
          amount: p.amount,
          mercury_status: p.mercury_status,
          je_count: p.je_count,
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
      setSyncMsg(
        `Sync complete: ${r?.imported ?? 0} imported, ${r?.je_created ?? 0} JEs created.`
      );
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
    <div className="max-w-6xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Payments</h1>
          <p className="text-gray-500 mt-1 text-xs">
            Mercury outgoing payments with invoice accrual tracking ·{" "}
            {sentPayments.length} sent · {pendingPayments.length} pending
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
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                Syncing…
              </>
            ) : (
              "Sync Payments"
            )}
          </button>
        </div>
      </div>

      {/* Inbound email address */}
      {inboundEmail && (
        <div className="mb-4 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-400 font-medium mb-0.5">Forward invoices to</p>
            <p className="text-sm text-white font-mono">{inboundEmail}</p>
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(inboundEmail);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700 transition-colors whitespace-nowrap"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {syncMsg && (
        <div className="mb-4 bg-indigo-950 border border-indigo-800 text-indigo-300 rounded-lg px-4 py-3 text-sm">
          {syncMsg}
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

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
          {/* Pending / Scheduled Payments */}
          {pendingPayments.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-yellow-400 uppercase tracking-wider mb-3">
                Pending / Scheduled ({pendingPayments.length})
              </h2>
              <PaymentsTable
                payments={pendingPayments}
                expanded={expanded}
                setExpanded={setExpanded}
              />
            </section>
          )}

          {/* Sent Payments */}
          {sentPayments.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-green-400 uppercase tracking-wider mb-3">
                Sent Payments ({sentPayments.length})
              </h2>
              <PaymentsTable
                payments={sentPayments}
                expanded={expanded}
                setExpanded={setExpanded}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentsTable({
  payments,
  expanded,
  setExpanded,
}: {
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
                className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/40 cursor-pointer transition-colors ${
                  expanded === p.id ? "bg-gray-800/60" : ""
                }`}
              >
                <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                  {formatDate(p.date)}
                </td>
                <td className="px-4 py-3 max-w-[200px]">
                  <p className="text-white text-xs font-medium truncate">
                    {p.counterparty_name || p.description || "—"}
                  </p>
                  {p.payment_method && (
                    <p className="text-gray-500 text-xs">{p.payment_method}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-red-400 whitespace-nowrap text-xs">
                  {formatAmount(p.amount)}
                </td>
                <td className="px-4 py-3 max-w-[260px]">
                  {p.invoice_text ? (
                    <p className="text-gray-400 text-xs truncate italic">
                      {p.invoice_text.slice(0, 100)}
                    </p>
                  ) : (
                    <span className="text-gray-600 text-xs">No invoice attached</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                      MERCURY_STATUS_BADGE[p.mercury_status ?? ""] ??
                      "bg-gray-800 text-gray-400 border border-gray-700"
                    }`}
                  >
                    {p.mercury_status || "unknown"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.je_count > 0 ? JE_STATUS_BADGE.coded : JE_STATUS_BADGE.uncoded
                    }`}
                  >
                    {p.je_count > 0 ? `${p.je_count} JE${p.je_count > 1 ? "s" : ""}` : "Uncoded"}
                  </span>
                </td>
              </tr>

              {/* Expanded invoice preview row */}
              {expanded === p.id && p.invoice_text && (
                <tr key={`${p.id}-expanded`} className="bg-gray-950">
                  <td colSpan={6} className="px-6 py-4">
                    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                      <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider mb-2">
                        Invoice Text
                      </p>
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-auto">
                        {p.invoice_text}
                      </pre>
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
