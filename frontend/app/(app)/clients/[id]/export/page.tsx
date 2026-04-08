"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getTransactionsWithEntries,
  getChartOfAccounts,
  getQboStatus,
  getQboAccounts,
  syncToQbo,
  updateTransactionStatus,
  TransactionWithEntries,
  QboSyncResult,
} from "@/lib/api";
import * as XLSX from "xlsx";

// ── Helpers ───────────────────────────────────────────────────────────────────

function q(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

function fmtDate(dateStr: string) {
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function triggerDownload(content: string, type: string, filename: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Mercury account name normalization ───────────────────────────────────────
// Mercury API sometimes returns account names with bullet characters (••) instead
// of the parenthetical format used in QBO. Normalize to the QBO COA name.
const MERCURY_NAME_MAP: Record<string, string> = {
  "Mercury Checking ••9882": "Mercury Checking (9882) - 1",
  "Mercury Savings ••3117":  "Mercury Savings (3117) - 1",
  "Mercury Treasury":        "Mercury Treasury - 1",
};

function normalizeMercuryName(name: string): string {
  return MERCURY_NAME_MAP[name] ?? name;
}

// ── QBO sub-account parent map ────────────────────────────────────────────────
// QBO journal entry import requires sub-accounts in "Parent:Child" colon format.
// Top-level accounts work with just their name; sub-accounts must include parent.
// NOTE: Mercury bank accounts (Checking, Savings, Treasury) are top-level in QBO
//       and must NOT use the Cash: parent prefix.
const QBO_PARENT: Record<string, string> = {
  // Cash sub-accounts
  "Mercury Checking (9882) - 1":            "Cash",
  "Mercury Savings (3117) - 1":             "Cash",
  "Mercury Treasury - 1":                   "Cash",
  // Professional services sub-accounts
  "Accounting, Tax & Finance fees":         "Legal, Finance & Accounting services",
  "Legal Fees":                             "Legal, Finance & Accounting services",
  // Loan sub-accounts
  "Bridge Loan from Founder":               "Short-term business loans",
  // Payroll liability sub-accounts
  "Payroll Liabilities - Rippling":         "Payroll wages and tax to pay",
  "Payroll taxes Payable":                  "Payroll wages and tax to pay",
  // Fixed asset sub-accounts
  "Long-term office equipment":             "Fixed Assets",
  "Domain Name":                            "Intangible Asset",
  "Accumulated Amortization - Domain Name": "Accumulated amortization",
  // Employee benefits sub-accounts
  "Employee retirement plans":              "Employee benefits",
  "Group term life insurance":              "Employee benefits",
  "Health insurance & accident plans":      "Employee benefits",
  "Officers' life insurance":               "Employee benefits",
  "Workers' compensation insurance":        "Employee benefits",
  // Insurance sub-accounts
  "Business insurance":                     "Insurance",
  "Liability insurance":                    "Insurance",
  // Travel sub-accounts
  "Airfare":                                "Travel",
  "Hotels":                                 "Travel",
  "Taxis or shared rides":                  "Travel",
  "Travel meals":                           "Travel",
  "Vehicle rental":                         "Travel",
  // Equity sub-accounts
  "Series Seed":                            "Preferred stock",
};

function qboAccount(name: string): string {
  const normalized = normalizeMercuryName(name);
  const parent = QBO_PARENT[normalized];
  return parent ? `${parent}:${normalized}` : normalized;
}

// ── COA validation ────────────────────────────────────────────────────────────

type AccountError = {
  rawName: string;       // as stored in DB
  normalizedName: string; // after Mercury normalization
  jeNumbers: string[];   // je_number or id strings that use this account
};

function validateAccounts(
  rows: TransactionWithEntries[],
  coa: Set<string>,
): AccountError[] {
  // Map: normalizedName → { rawName, jeNumbers[] }
  const bad = new Map<string, AccountError>();

  for (const tx of rows) {
    for (const je of tx.journal_entries) {
      const jeRef = String(je.je_number ?? je.id);
      for (const raw of [je.debit_account, je.credit_account]) {
        const normalized = normalizeMercuryName(raw);
        if (!coa.has(normalized)) {
          if (!bad.has(normalized)) {
            bad.set(normalized, { rawName: raw, normalizedName: normalized, jeNumbers: [] });
          }
          const entry = bad.get(normalized)!;
          if (!entry.jeNumbers.includes(jeRef)) entry.jeNumbers.push(jeRef);
        }
      }
    }
  }

  return Array.from(bad.values()).sort((a, b) =>
    a.normalizedName.localeCompare(b.normalizedName)
  );
}

// ── QBO Journal Entry rows ────────────────────────────────────────────────────

type QboRow = {
  "Journal No.": string;
  "Journal Date": string;
  "Account Name": string;
  "Debits": string;
  "Credits": string;
  "Journal Entry Description": string;
  "Name": string;
  "Memo": string;
};

function buildQboRows(rows: TransactionWithEntries[]): QboRow[] {
  const result: QboRow[] = [];

  for (const tx of rows) {
    for (const je of tx.journal_entries) {
      const date = fmtDate(je.je_date ?? tx.date);
      const desc = je.memo || tx.description;
      const amt = Math.abs(je.amount).toFixed(2);
      const no = String(je.je_number ?? je.id);

      const vendor = tx.counterparty_name ?? "";
      result.push({
        "Journal No.": no,
        "Journal Date": date,
        "Account Name": qboAccount(je.debit_account),
        "Debits": amt,
        "Credits": "",
        "Journal Entry Description": desc,
        "Name": vendor,
        "Memo": desc,
      });
      result.push({
        "Journal No.": no,
        "Journal Date": date,
        "Account Name": qboAccount(je.credit_account),
        "Debits": "",
        "Credits": amt,
        "Journal Entry Description": desc,
        "Name": "",
        "Memo": desc,
      });
    }
  }
  return result;
}

function downloadQboCsv(rows: TransactionWithEntries[]) {
  const data = buildQboRows(rows);
  const headers: (keyof QboRow)[] = [
    "Journal No.", "Journal Date", "Account Name", "Debits", "Credits",
    "Journal Entry Description", "Name", "Memo",
  ];
  const lines = [headers.map(q).join(",")];
  for (const row of data) {
    lines.push(headers.map((h) => q(String(row[h]))).join(","));
  }
  triggerDownload(lines.join("\n"), "text/csv", `qbo-journal-entries-${today()}.csv`);
}

function downloadQboXlsx(rows: TransactionWithEntries[]) {
  const data = buildQboRows(rows);
  const ws = XLSX.utils.json_to_sheet(data, {
    header: [
      "Journal No.", "Journal Date", "Account Name", "Debits", "Credits",
      "Journal Entry Description", "Name", "Memo",
    ],
  });
  const colWidths = [12, 14, 40, 12, 12, 40, 30, 40];
  ws["!cols"] = colWidths.map((w) => ({ wch: w }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Journal Entries");
  XLSX.writeFile(wb, `qbo-journal-entries-${today()}.xlsx`);
}

// ── Internal review CSV ───────────────────────────────────────────────────────

function downloadReviewCsv(rows: TransactionWithEntries[]) {
  const headers = [
    "Date", "Transaction Description", "Counterparty", "Account",
    "Debit Account", "Credit Account", "Amount", "Memo", "AI Confidence", "Payment Method",
  ];
  const lines = [headers.map(q).join(",")];
  for (const tx of rows) {
    for (const je of tx.journal_entries) {
      lines.push([
        q(new Date(tx.date).toLocaleDateString()),
        q(tx.description),
        q(tx.counterparty_name ?? ""),
        q(tx.mercury_account_name ?? ""),
        q(je.debit_account),
        q(je.credit_account),
        q(je.amount.toFixed(2)),
        q(je.memo ?? ""),
        q(je.ai_confidence !== null ? (je.ai_confidence * 100).toFixed(0) + "%" : ""),
        q(tx.payment_method ?? ""),
      ].join(","));
    }
  }
  triggerDownload(lines.join("\n"), "text/csv", `journal-entries-review-${today()}.csv`);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ExportPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [approved, setApproved] = useState<TransactionWithEntries[]>([]);
  const [coaSet, setCoaSet] = useState<Set<string>>(new Set());
  const [coaLoaded, setCoaLoaded] = useState(false);
  const [coaError, setCoaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [markingExported, setMarkingExported] = useState(false);
  const [selectedTxIds, setSelectedTxIds] = useState<Set<number>>(new Set());

  const [qboConnected, setQboConnected] = useState(false);
  const [qboSyncing, setQboSyncing] = useState(false);
  const [qboResult, setQboResult] = useState<QboSyncResult | null>(null);
  const [qboError, setQboError] = useState<string | null>(null);
  const [qboMarkExported, setQboMarkExported] = useState(true);
  const [qboForce, setQboForce] = useState(false);

  useEffect(() => {
    setLoading(true);

    const txPromise = getTransactionsWithEntries(clientId, "approved")
      .then((items) => setApproved(items.filter((t) => t.journal_entries.length > 0)));

    // Check QBO connection status (for showing the Sync button)
    getQboStatus(clientId).then((s) => setQboConnected(s.connected)).catch(() => {});

    // Always use the uploaded COA for validation
    const coaPromise = getChartOfAccounts(clientId)
      .then((accounts) => {
        setCoaSet(new Set(accounts));
        setCoaLoaded(true);
      })
      .catch((err) => {
        setCoaError(err?.message ?? "Failed to load Chart of Accounts");
        setCoaLoaded(true);
      });

    Promise.all([txPromise, coaPromise]).finally(() => setLoading(false));
  }, [clientId]);

  async function handleQboSync() {
    setQboSyncing(true);
    setQboResult(null);
    setQboError(null);
    try {
      const result = await syncToQbo(clientId, qboMarkExported, qboForce);
      setQboResult(result);
      if (result.synced > 0) {
        const fresh = await getTransactionsWithEntries(clientId, "approved");
        setApproved(fresh.filter((t) => t.journal_entries.length > 0));
      }
    } catch (err: unknown) {
      setQboError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setQboSyncing(false);
    }
  }

  async function markSelectedExported() {
    if (selectedTxIds.size === 0) return;
    setMarkingExported(true);
    try {
      await Promise.all(
        approved
          .filter((tx) => selectedTxIds.has(tx.id))
          .map((tx) => updateTransactionStatus(tx.id, "exported"))
      );
      setApproved((prev) => prev.filter((tx) => !selectedTxIds.has(tx.id)));
      setSelectedTxIds(new Set());
    } finally {
      setMarkingExported(false);
    }
  }

  function toggleTx(id: number) {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const totalJes = approved.reduce((n, tx) => n + tx.journal_entries.length, 0);
  const totalAmount = approved.reduce(
    (sum, tx) => sum + tx.journal_entries.reduce((s, je) => s + je.amount, 0),
    0
  );

  // Only validate if COA loaded successfully (non-empty set means real data)
  const accountErrors = (coaLoaded && coaSet.size > 0) ? validateAccounts(approved, coaSet) : [];
  const hasErrors = accountErrors.length > 0;

  // Set of bad normalized names for highlight in preview
  const badNames = new Set(accountErrors.map((e) => e.normalizedName));

  const DownloadIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Export</h1>
        <p className="text-gray-500 mt-1 text-xs">
          Download approved journal entries for import into QuickBooks Online
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : approved.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-3xl mb-3">📭</p>
          <p className="text-gray-400 font-medium">Nothing to export</p>
          <p className="text-sm mt-1">Approve journal entries in the Review Queue first.</p>
        </div>
      ) : (
        <div className="space-y-6">

          {/* COA load error */}
          {coaError && (
            <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-4 text-xs text-yellow-300">
              <span className="font-semibold">Could not load Chart of Accounts:</span> {coaError}. Account name validation is disabled — download with caution.
            </div>
          )}

          {/* COA Validation errors */}
          {hasErrors && (
            <div className="bg-red-950 border border-red-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <h2 className="text-sm font-semibold text-red-300">
                  {accountErrors.length} account name{accountErrors.length > 1 ? "s" : ""} not found in Chart of Accounts
                </h2>
              </div>
              <p className="text-xs text-red-400 mb-3">
                QBO will reject the import if account names don't match exactly. Fix these in the Review Queue before downloading.
              </p>
              <div className="space-y-2">
                {accountErrors.map((err) => (
                  <div key={err.normalizedName} className="bg-red-900/40 rounded-lg px-3 py-2 flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-mono text-red-200">&quot;{err.normalizedName}&quot;</p>
                      {err.rawName !== err.normalizedName && (
                        <p className="text-xs text-red-500 mt-0.5">stored as: <span className="font-mono">&quot;{err.rawName}&quot;</span></p>
                      )}
                    </div>
                    <p className="text-xs text-red-500 whitespace-nowrap">
                      JE {err.jeNumbers.join(", ")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">Transactions</p>
              <p className="text-3xl font-bold text-white">{approved.length}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">Line Items</p>
              <p className="text-3xl font-bold text-white">{totalJes}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">Total Amount</p>
              <p className="text-3xl font-bold text-white">
                ${totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </p>
            </div>
          </div>

          {/* Direct QBO Sync */}
          {qboConnected && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                  <h2 className="text-sm font-semibold text-white">Sync to QuickBooks Online</h2>
                </div>
                <p className="text-xs text-gray-500">
                  Push transactions directly to QBO as Purchases (vendor expenses) or Journal Entries. New vendors are created automatically.
                  The CSV/Excel export below is always available as a backup.
                </p>
              </div>

              {qboResult && (
                <div className={`rounded-lg px-4 py-3 text-xs space-y-1 ${qboResult.errors.length > 0 ? "bg-yellow-950 border border-yellow-700" : "bg-green-950 border border-green-700"}`}>
                  <p className={qboResult.errors.length > 0 ? "text-yellow-300" : "text-green-300"}>
                    {qboResult.synced} {qboResult.synced === 1 ? "transaction" : "transactions"} synced to QBO
                    {qboResult.created_vendors.length > 0 && ` · ${qboResult.created_vendors.length} new vendor${qboResult.created_vendors.length > 1 ? "s" : ""} created`}
                  </p>
                  {qboResult.created_vendors.length > 0 && (
                    <p className="text-gray-400">New vendors: {qboResult.created_vendors.join(", ")}</p>
                  )}
                  {qboResult.errors.map((e, i) => (
                    <p key={i} className="text-yellow-400">{e}</p>
                  ))}
                </div>
              )}

              {qboError && (
                <div className="bg-red-950 border border-red-700 rounded-lg px-4 py-3 text-xs text-red-300">
                  {qboError}
                </div>
              )}

              <div className="flex items-center gap-4 flex-wrap">
              <button
                onClick={handleQboSync}
                disabled={qboSyncing || hasErrors}
                className="flex items-center gap-2 bg-[#2CA01C] hover:bg-[#248017] text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {qboSyncing ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0" />
                    Syncing to QBO…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Sync to QuickBooks Online
                  </>
                )}
              </button>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={qboMarkExported}
                  onChange={(e) => setQboMarkExported(e.target.checked)}
                  className="w-4 h-4 rounded accent-indigo-500"
                />
                <span className="text-xs text-gray-400">Mark as exported after sync</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={qboForce}
                  onChange={(e) => setQboForce(e.target.checked)}
                  className="w-4 h-4 rounded accent-indigo-500"
                />
                <span className="text-xs text-gray-400">Force re-sync (clears existing QBO IDs)</span>
              </label>
              </div>
              {hasErrors && (
                <p className="text-xs text-red-400">Fix the account errors above before syncing.</p>
              )}
            </div>
          )}

          {/* QBO Import */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-white">QuickBooks Online Import (CSV/Excel)</h2>
              <p className="text-xs text-gray-500 mt-1">
                Settings → Import Data → Journal Entries. Account names must exactly match your QBO Chart of Accounts (spelling, capitalization, spacing).
              </p>
            </div>
            {hasErrors && (
              <p className="text-xs text-red-400 font-medium">
                Fix the {accountErrors.length} account error{accountErrors.length > 1 ? "s" : ""} above before downloading.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => downloadQboXlsx(approved)}
                disabled={hasErrors}
                className="flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <DownloadIcon />
                Download Excel (.xlsx)
              </button>
              <button
                onClick={() => downloadQboCsv(approved)}
                disabled={hasErrors}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <DownloadIcon />
                Download CSV
              </button>
            </div>
            <div className="text-xs text-gray-600 space-y-0.5">
              <p>Columns: Journal No. · Journal Date · Account Name · Debits · Credits · Journal Entry Description · Name · Memo</p>
              <p className="text-amber-700">Note: Turn off account numbers in QBO (Settings → Chart of Accounts) before importing, then re-enable after.</p>
            </div>
          </div>

          {/* Review CSV */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Internal Review</h2>
              <p className="text-xs text-gray-500 mt-1">Full detail export for your own records — includes AI confidence, payment method, counterparty.</p>
            </div>
            <button
              onClick={() => downloadReviewCsv(approved)}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              <DownloadIcon />
              Download Review CSV
            </button>
          </div>

          {/* Mark exported */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">After importing</h2>
              <div className="flex gap-3 text-xs text-indigo-400">
                <button onClick={() => setSelectedTxIds(new Set(approved.map((t) => t.id)))}>
                  Select all
                </button>
                <button onClick={() => setSelectedTxIds(new Set())}>
                  Deselect all
                </button>
              </div>
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {approved.map((tx) => (
                <label key={tx.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedTxIds.has(tx.id)}
                    onChange={() => toggleTx(tx.id)}
                    className="w-4 h-4 rounded accent-purple-500 shrink-0"
                  />
                  <span className="text-xs text-gray-400 w-24 shrink-0">{new Date(tx.date).toLocaleDateString()}</span>
                  <span className="text-xs text-white truncate">{tx.description}</span>
                  <span className="text-xs text-gray-500 ml-auto shrink-0">
                    ${tx.journal_entries.reduce((s, je) => s + je.amount, 0).toFixed(2)}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={markSelectedExported}
                disabled={markingExported || selectedTxIds.size === 0}
                className="bg-purple-700 hover:bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {markingExported ? "Marking…" : `Mark Selected as Imported (${selectedTxIds.size})`}
              </button>
              <p className="text-xs text-gray-600">This cannot be undone.</p>
            </div>
          </div>

          {/* Preview */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-auto">
            <div className="px-5 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">Preview</h2>
            </div>
            <table className="w-full text-xs min-w-[800px]">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 font-medium text-left">
                  <th className="px-4 py-3">Journal No.</th>
                  <th className="px-4 py-3">Journal Date</th>
                  <th className="px-4 py-3">Account Name</th>
                  <th className="px-4 py-3 text-right">Debits</th>
                  <th className="px-4 py-3 text-right">Credits</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Description</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const qboRows = buildQboRows(approved);
                  return qboRows.map((row, i) => {
                    // Strip parent prefix to check base name against bad set
                    const baseName = row["Account Name"].includes(":")
                      ? row["Account Name"].split(":").slice(1).join(":")
                      : row["Account Name"];
                    const isInvalid = badNames.has(baseName);
                    return (
                      <tr key={i} className={`border-b border-gray-800 last:border-0 ${isInvalid ? "bg-red-950/40" : "hover:bg-gray-800/20"}`}>
                        <td className="px-4 py-2.5 text-gray-500 font-mono">{row["Journal No."]}</td>
                        <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{row["Journal Date"]}</td>
                        <td className={`px-4 py-2.5 font-mono ${isInvalid ? "text-red-400" : "text-white"}`}>
                          {row["Account Name"]}
                          {isInvalid && <span className="ml-2 text-red-500 text-xs">✗ not in COA</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right text-green-400 font-mono">
                          {row["Debits"] ? `$${row["Debits"]}` : ""}
                        </td>
                        <td className="px-4 py-2.5 text-right text-red-400 font-mono">
                          {row["Credits"] ? `$${row["Credits"]}` : ""}
                        </td>
                        <td className="px-4 py-2.5 text-gray-300 truncate max-w-[160px]">
                          {row["Name"]}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 italic truncate max-w-[200px]">
                          {row["Journal Entry Description"]}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
