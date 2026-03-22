"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getTransactions, getJournalEntries, updateTransactionStatus, deleteTransaction, clearAllTransactions, Transaction, JournalEntry } from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

function formatCategory(cat: string | null): string {
  if (!cat) return "—";
  // Split camelCase / PascalCase into words, then title-case
  return cat
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

const CATEGORY_COLOR: Record<string, string> = {
  Software:           "text-blue-400",
  Grocery:            "text-green-400",
  Restaurants:        "text-orange-400",
  Retail:             "text-yellow-400",
  "Office Supplies":  "text-purple-400",
  "Professional Services": "text-indigo-400",
  "Expense Reimbursement": "text-teal-400",
  "Outgoing Payment": "text-red-400",
  "Treasury Transfer":"text-cyan-400",
};

const STATUS_BADGE: Record<string, string> = {
  pending:  "bg-yellow-900 text-yellow-300 border border-yellow-700",
  reviewed: "bg-blue-900 text-blue-300 border border-blue-700",
  approved: "bg-green-900 text-green-300 border border-green-700",
  exported: "bg-purple-900 text-purple-300 border border-purple-700",
  rejected: "bg-red-900 text-red-300 border border-red-700",
};

const STATUS_OPTIONS: Transaction["status"][] = ["pending", "reviewed", "approved", "exported", "rejected"];

const BANK_CARD_KEYWORDS = ["mercury", "checking", "savings", "credit", "cash"];

function isPurchaseEntry(je: JournalEntry, tx: Transaction | null): boolean {
  if (je.qbo_object_type) return je.qbo_object_type === "Purchase";
  const credit = (je.credit_account || "").toLowerCase();
  return !!tx?.counterparty_name && BANK_CARD_KEYWORDS.some((k) => credit.includes(k));
}

function entryLabel(je: JournalEntry, tx: Transaction | null): string {
  return isPurchaseEntry(je, tx) ? "Expense" : "Journal Entry";
}

export default function ClientTransactionsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setPageContext, setCurrentPage } = useChatContext();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [jeLoading, setJeLoading] = useState(false);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  useEffect(() => {
    setCurrentPage("transactions");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

  useEffect(() => {
    getTransactions(clientId)
      .then((txns) => {
        setTransactions(txns);
        const summary = txns.map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amount: t.amount,
          status: t.status,
          account: t.mercury_account_name,
        }));
        setPageContext(JSON.stringify(summary));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [clientId, setPageContext]);

  async function handleStatusChange(tx: Transaction, newStatus: Transaction["status"]) {
    try {
      const updated = await updateTransactionStatus(tx.id, newStatus);
      setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      if (selectedTx?.id === tx.id) setSelectedTx(updated);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Status update failed");
    }
  }

  async function handleDelete(tx: Transaction, e: React.MouseEvent) {
    e.stopPropagation();
    setDeletingId(tx.id);
    try {
      await deleteTransaction(tx.id);
      setTransactions((prev) => prev.filter((t) => t.id !== tx.id));
      if (selectedTx?.id === tx.id) setSelectedTx(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleClearAll() {
    if (!confirm(`Delete all ${transactions.length} transactions? This cannot be undone.`)) return;
    setClearingAll(true);
    try {
      await clearAllTransactions(clientId);
      setTransactions([]);
      setSelectedTx(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setClearingAll(false);
    }
  }

  function openJe(tx: Transaction) {
    setSelectedTx(tx);
    setJeLoading(true);
    getJournalEntries(tx.id)
      .then(setJournalEntries)
      .catch(() => setJournalEntries([]))
      .finally(() => setJeLoading(false));
  }

  return (
    <div className="flex gap-6 min-h-0">
      <div className="flex-1 min-w-0">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Transactions</h1>
            <p className="text-gray-500 mt-1 text-xs">{transactions.length} total · Click a row to view journal entries</p>
          </div>
          {transactions.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={clearingAll}
              className="text-xs text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {clearingAll ? "Clearing…" : "Clear All"}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-6 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center h-40 items-center">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-20 text-gray-500">No transactions yet. Use Sync Mercury on the Overview page.</div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
            <table className="w-full text-sm min-w-[960px]">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Invoice #</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Change</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    onClick={() => openJe(tx)}
                    className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/40 cursor-pointer ${
                      selectedTx?.id === tx.id ? "bg-gray-800/60" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {new Date(tx.date).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 max-w-[220px]">
                      <p className="text-white text-xs truncate">{tx.description}</p>
                      {tx.counterparty_name && tx.counterparty_name !== tx.description && (
                        <p className="text-gray-500 text-xs truncate">{tx.counterparty_name}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {tx.mercury_account_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {tx.payment_method ? (
                        <span className="text-gray-300">{tx.payment_method}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {tx.invoice_number || "—"}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-medium whitespace-nowrap text-xs ${
                      tx.amount < 0 ? "text-red-400" : "text-green-400"
                    }`}>
                      {tx.amount < 0 ? "-" : "+"}${Math.abs(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      {tx.mercury_category ? (
                        <span className={CATEGORY_COLOR[formatCategory(tx.mercury_category)] ?? "text-gray-400"}>
                          {formatCategory(tx.mercury_category)}
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_BADGE[tx.status] ?? ""}`}>
                        {tx.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={tx.status}
                        onChange={(e) => handleStatusChange(tx, e.target.value as Transaction["status"])}
                        className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => handleDelete(tx, e)}
                        disabled={deletingId === tx.id}
                        className="text-gray-600 hover:text-red-400 transition-colors text-base leading-none disabled:opacity-30"
                        title="Delete transaction"
                      >
                        {deletingId === tx.id ? "…" : "×"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Journal entries drawer */}
      {selectedTx && (
        <div className="w-72 shrink-0 bg-gray-900 border border-gray-800 rounded-xl p-5 self-start sticky top-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              {journalEntries.length === 1
                ? entryLabel(journalEntries[0], selectedTx)
                : "Accounting Entries"}
            </h2>
            <button onClick={() => setSelectedTx(null)} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>

          {/* Transaction detail */}
          <div className="mb-4 p-3 bg-gray-800 rounded-lg space-y-1">
            <p className="text-sm text-white font-medium truncate">{selectedTx.description}</p>
            <p className="text-xs text-gray-400">{new Date(selectedTx.date).toLocaleDateString()}</p>
            <p className={`text-xs font-mono font-medium ${selectedTx.amount < 0 ? "text-red-400" : "text-green-400"}`}>
              {selectedTx.amount < 0 ? "-" : "+"}${Math.abs(selectedTx.amount).toFixed(2)}
            </p>
            {selectedTx.mercury_account_name && (
              <p className="text-xs text-gray-500">{selectedTx.mercury_account_name}</p>
            )}
            {selectedTx.payment_method && (
              <p className="text-xs text-gray-500">via {selectedTx.payment_method}</p>
            )}
            {selectedTx.invoice_number && (
              <p className="text-xs text-gray-500">Invoice #{selectedTx.invoice_number}</p>
            )}
            {selectedTx.mercury_category && (
              <p className="text-xs text-gray-500">
                Category: <span className={CATEGORY_COLOR[formatCategory(selectedTx.mercury_category)] ?? "text-gray-300"}>
                  {formatCategory(selectedTx.mercury_category)}
                </span>
              </p>
            )}
          </div>

          {jeLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : journalEntries.length === 0 ? (
            <p className="text-gray-500 text-xs text-center py-6">No journal entries yet.</p>
          ) : (
            <ul className="space-y-2">
              {journalEntries.map((je) => {
                const isPurchase = isPurchaseEntry(je, selectedTx);
                return (
                  <li key={je.id} className="bg-gray-800 rounded-lg p-3 text-xs space-y-1">
                    {isPurchase ? (
                      <>
                        {selectedTx?.counterparty_name && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Vendor: <span className="text-white">{selectedTx.counterparty_name}</span></span>
                            <span className="text-green-400 font-mono">${je.amount.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="text-gray-400">Category: <span className="text-white">{je.debit_account}</span></div>
                        <div className="text-gray-400">CR: <span className="text-white">{je.credit_account}</span></div>
                      </>
                    ) : (
                      <>
                        <div className="flex justify-between text-gray-400">
                          <span>DR: <span className="text-white">{je.debit_account}</span></span>
                          <span className="text-green-400 font-mono">${je.amount.toFixed(2)}</span>
                        </div>
                        <div className="text-gray-400">CR: <span className="text-white">{je.credit_account}</span></div>
                      </>
                    )}
                    {je.memo && <p className="text-gray-500 italic">{je.memo}</p>}
                    {je.ai_confidence !== null && (
                      <p className="text-indigo-400">AI Confidence: {(je.ai_confidence * 100).toFixed(0)}%</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
