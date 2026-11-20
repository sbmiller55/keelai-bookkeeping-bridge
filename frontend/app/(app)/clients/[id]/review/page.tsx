"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useAccounts } from "@/lib/useAccounts";
import { AccountSelect } from "@/components/AccountSelect";
import { useCustomers } from "@/lib/useCustomers";
import {
  getTransactionsWithEntries,
  updateTransactionStatus,
  updateJournalEntry,
  createJournalEntry,
  deleteJournalEntry,
  createRule,
  applyRule,
  codePending,
  syncMercury,
  suggestFixedAsset,
  createFixedAsset,
  codeAsPrepaidSchedule,
  getClient,
  TransactionWithEntries,
  JournalEntry,
  DateRangeOption,
  FixedAssetSuggestion,
} from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

// ── Column widths (resizable, persisted) ──────────────────────────────────────

const DEFAULT_COL_WIDTHS = {
  date: 120, description: 180, amount: 110, category: 110,
  debit: 200, credit: 200, customer: 160, jeAmt: 150, memo: 180,
  conf: 70, reasoning: 160, actions: 110,
};
type ColKey = keyof typeof DEFAULT_COL_WIDTHS;
const COL_WIDTHS_KEY = "bb-review-col-widths";
const HIDDEN_COLS_KEY = "bb-review-hidden-cols";

// What each column is called in the Columns menu, in table order.
const COL_LABELS: Record<ColKey, string> = {
  date: "Date", description: "Description", amount: "Amount", category: "Category",
  debit: "Debit account", credit: "Credit account", customer: "Customer",
  jeAmt: "JE amount", memo: "Memo", conf: "Confidence",
  reasoning: "Reasoning", actions: "Actions",
};

// Description and Actions always stay: one identifies the row, the other is
// how you act on it, and a queue with neither cannot be worked.
const ALWAYS_SHOWN: ColKey[] = ["description", "actions"];

// What each Pull-from option is called, in menu order.
const DATE_RANGE_LABELS: Record<DateRangeOption, string> = {
  last_month: "Last month", this_month: "This month", since_last_sync: "Since last sync",
  last_30: "Last 30 days", last_90: "Last 90 days", last_180: "Last 6 months",
  last_365: "Last 12 months", custom: "Custom",
};

// The dates a Pull-from option covers, worked out the same way the backend
// does (routers/mercury.py _compute_date_range), so the label beside the
// option is what Sync will actually fetch. Null when it cannot be known here.
function pullRange(opt: DateRangeOption, lastSyncAt: Date | null): [Date, Date] | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysAgo = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  switch (opt) {
    case "last_month":
      return [new Date(today.getFullYear(), today.getMonth() - 1, 1),
              new Date(today.getFullYear(), today.getMonth(), 0)];
    case "this_month":
      return [new Date(today.getFullYear(), today.getMonth(), 1), today];
    case "since_last_sync":
      return [lastSyncAt ?? daysAgo(90), today];
    case "last_30": return [daysAgo(30), today];
    case "last_90": return [daysAgo(90), today];
    case "last_180": return [daysAgo(180), today];
    case "last_365": return [daysAgo(365), today];
    default: return null;
  }
}

// "Oct 1 – 31, 2026", "Sep 20 – Oct 19, 2026", "Dec 1, 2025 – Jan 5, 2026".
function formatRange(start: Date, end: Date): string {
  const mon = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${mon(start)} ${start.getDate()}, ${start.getFullYear()} – ${mon(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  const endPart = start.getMonth() === end.getMonth() ? `${end.getDate()}` : `${mon(end)} ${end.getDate()}`;
  return `${mon(start)} ${start.getDate()} – ${endPart}, ${end.getFullYear()}`;
}

function timeAgo(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The backend stores last_sync_at in UTC without saying so; read it as UTC.
function parseUtc(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function loadHiddenCols(): ColKey[] {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(HIDDEN_COLS_KEY) : null;
    const parsed: ColKey[] = raw ? JSON.parse(raw) : [];
    return parsed.filter((c) => c in DEFAULT_COL_WIDTHS && !ALWAYS_SHOWN.includes(c));
  } catch { return []; }
}

function loadColWidths(): typeof DEFAULT_COL_WIDTHS {
  try {
    const s = typeof window !== "undefined" ? localStorage.getItem(COL_WIDTHS_KEY) : null;
    return s ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_COL_WIDTHS;
  } catch { return DEFAULT_COL_WIDTHS; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCategory(cat: string | null): string | null {
  if (!cat || cat.toLowerCase() === "other") return null;
  return cat;
}

// ── Customer dropdown ─────────────────────────────────────────────────────────
// Like AccountSelect, but for QBO customers. Unlike accounts, a typed name that
// isn't in the list is ALLOWED — it gets created in QBO at sync time. Clearing
// the field removes the customer from the entry.
function CustomerSelect({
  value,
  onChange,
  customers,
  placeholder = "Customer…",
}: {
  value: string;
  onChange: (v: string) => void;
  customers: string[];
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setInputValue(value); }, [value]);

  // Resolve to canonical casing if the typed name matches an existing customer;
  // otherwise keep the typed name verbatim (a new customer to be created).
  const canonicalize = (raw: string): string => {
    const t = raw.trim();
    if (!t) return "";
    const match = customers.find((c) => c.toLowerCase() === t.toLowerCase());
    return match ?? t;
  };

  const commitTyped = () => {
    const next = canonicalize(inputValue);
    if (next !== value) onChange(next);
    setInputValue(next);
  };

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        commitTyped();
        setOpen(false);
        setIsTyping(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, value, onChange, customers]);

  const filtered = (isTyping && inputValue)
    ? customers.filter((c) => c.toLowerCase().includes(inputValue.toLowerCase()))
    : customers;

  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  function commit(val: string) {
    const next = canonicalize(val);
    if (next !== value) onChange(next);
    setInputValue(next);
    setOpen(false);
    setIsTyping(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) { if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isTyping && !filtered[activeIdx]) commit(inputValue);   // new customer
      else if (filtered[activeIdx]) commit(filtered[activeIdx]);
      else commit(inputValue);
    } else if (e.key === "Escape") {
      setInputValue(value);
      setOpen(false);
      setIsTyping(false);
    }
  }

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <div ref={ref} className="relative w-full">
      <input
        type="text"
        value={inputValue}
        placeholder={placeholder}
        onChange={(e) => { setInputValue(e.target.value); setIsTyping(true); setOpen(true); setActiveIdx(0); }}
        onFocus={(e) => { setOpen(true); setIsTyping(false); e.target.select(); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setTimeout(() => {
            if (ref.current && !ref.current.contains(document.activeElement)) {
              commitTyped();
              setOpen(false);
              setIsTyping(false);
            }
          }, 150);
        }}
        className="w-full bg-transparent border border-transparent hover:border-gray-600 focus:border-indigo-500 focus:outline-none text-white rounded px-2 py-1 text-xs placeholder-gray-500"
      />

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          <div ref={listRef} className="max-h-56 overflow-y-auto">
            {filtered.map((c, i) => (
              <button
                key={c}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); commit(c); }}
                className={`w-full text-left px-3 py-1.5 text-xs ${i === activeIdx ? "bg-indigo-600 text-white" : c === value ? "text-indigo-400 bg-gray-800/50" : "text-gray-200 hover:bg-gray-800"}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function ConfBadge({ score, reasoning }: { score: number | null; reasoning?: string | null }) {
  const [show, setShow] = useState(false);
  if (score === null) return <span className="text-gray-600 text-xs">—</span>;
  const pct = Math.round(score * 100);
  const cls = score >= 0.85 ? "text-green-400" : score >= 0.6 ? "text-yellow-400" : "text-red-400";
  const showTooltip = pct < 100 && !!reasoning;
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => showTooltip && setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span className={`text-xs font-mono ${cls} ${showTooltip ? "cursor-help underline decoration-dotted" : ""}`}>{pct}%</span>
      {show && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-lg bg-gray-900 border border-gray-700 text-gray-200 text-xs p-2.5 shadow-xl pointer-events-none whitespace-normal text-left">
          {reasoning}
        </span>
      )}
    </span>
  );
}

// ── Fixed Asset Panel ─────────────────────────────────────────────────────────

const FA_TANGIBLE_CATS = ["Equipment", "Furniture", "Leasehold Improvements", "Vehicles", "Other"];
const FA_INTANGIBLE_CATS = ["Capitalized Software", "Licenses", "Patents", "Trademarks", "Customer Lists", "Non-Compete Agreements", "Goodwill", "Other Intangibles"];
const FA_INTANGIBLE_SET = new Set(FA_INTANGIBLE_CATS);
const FA_INTANGIBLE_LIFE: Record<string, number> = {
  "Capitalized Software": 36, "Licenses": 36, "Patents": 240,
  "Trademarks": 120, "Customer Lists": 60, "Non-Compete Agreements": 36,
  "Other Intangibles": 60, "Goodwill": 0,
};
const FA_DEP_METHODS = [
  { value: "straight_line", label: "Straight-Line" },
  { value: "double_declining", label: "Double-Declining Balance" },
];

function PrepaidPanel({
  tx, clientId, accounts, onConfirm, onClose,
}: {
  tx: TransactionWithEntries;
  clientId: number;
  accounts: string[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [prepaidAcct, setPrepaidAcct] = useState("Prepaid expenses");
  const [expenseAcct, setExpenseAcct] = useState("");
  const [startMonth, setStartMonth] = useState(
    (tx.date ?? "").slice(0, 7) || new Date().toISOString().slice(0, 7)
  );
  const [numMonths, setNumMonths] = useState("12");
  const [description, setDescription] = useState(tx.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = Math.abs(tx.amount);
  const n = Math.max(1, parseInt(numMonths) || 1);
  const monthly = Math.round((total / n) * 100) / 100;
  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500";

  async function handleConfirm() {
    setSaving(true); setError(null);
    try {
      await codeAsPrepaidSchedule(clientId, {
        transaction_id: tx.id,
        prepaid_account: prepaidAcct,
        expense_account: expenseAcct,
        service_start: startMonth,
        num_months: n,
        description: description || undefined,
      });
      onConfirm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create prepaid schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Code as Prepaid Expense</h2>
            <p className="text-xs text-gray-500 mt-0.5">{tx.description}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none ml-4">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="bg-indigo-950/40 border border-indigo-800/50 rounded-lg px-3 py-2 text-xs text-indigo-300">
            Capitalizes ${total.toFixed(2)} to the prepaid account, then amortizes ~${monthly.toFixed(2)}/mo over {n} months. Each month appears in the Prepaid Expenses tab and releases to the Review Queue on its month-end.
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Description (groups the schedule)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Prepaid asset account</label>
              <AccountSelect value={prepaidAcct} onChange={setPrepaidAcct} accounts={accounts} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Expense account (amortization)</label>
              <AccountSelect value={expenseAcct} onChange={setExpenseAcct} accounts={accounts} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Start month</label>
              <input type="month" value={startMonth} onChange={e => setStartMonth(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1"># of months</label>
              <input type="number" min={1} value={numMonths} onChange={e => setNumMonths(e.target.value)} className={inputCls} />
            </div>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-300 hover:text-white">Cancel</button>
            <button onClick={handleConfirm} disabled={saving || !expenseAcct || !prepaidAcct}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg">
              {saving ? "Creating…" : "Create prepaid schedule"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FixedAssetPanel({
  tx, jeId, clientId, accounts, onConfirm, onClose,
}: {
  tx: TransactionWithEntries;
  jeId: number;
  clientId: number;
  accounts: string[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [suggestion, setSuggestion] = useState<FixedAssetSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(tx.description);
  const [category, setCategory] = useState("Equipment");
  const [purchaseDate, setPurchaseDate] = useState(tx.date?.slice(0, 10) ?? "");
  const [purchasePrice, setPurchasePrice] = useState(String(Math.abs(tx.amount)));
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLife, setUsefulLife] = useState("60");
  const [method, setMethod] = useState("straight_line");
  const [assetAcct, setAssetAcct] = useState("");
  const [accumAcct, setAccumAcct] = useState("");
  const [expAcct, setExpAcct] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isIntangible = FA_INTANGIBLE_SET.has(category);
  const isGoodwill = category === "Goodwill";
  const term = isIntangible ? "Amortization" : "Depreciation";

  function handleCategoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const cat = e.target.value;
    const intangible = FA_INTANGIBLE_SET.has(cat);
    setCategory(cat);
    if (intangible) {
      setMethod("straight_line");
      setSalvageValue("0");
      setUsefulLife(String(FA_INTANGIBLE_LIFE[cat] ?? 60));
    } else if (usefulLife === "0") {
      setUsefulLife("60");
    }
  }

  useEffect(() => {
    suggestFixedAsset(clientId, tx.id)
      .then((s) => {
        setSuggestion(s);
        setName(s.name);
        setCategory(s.category);
        setPurchaseDate(s.purchase_date);
        setPurchasePrice(String(s.purchase_price));
        setSalvageValue(String(s.salvage_value));
        setUsefulLife(String(s.useful_life_months));
        setMethod(s.depreciation_method);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [clientId, tx.id]);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    try {
      await createFixedAsset(clientId, {
        transaction_id: tx.id,
        je_id: jeId,
        name,
        category,
        purchase_date: purchaseDate,
        purchase_price: parseFloat(purchasePrice),
        salvage_value: isIntangible ? 0 : (parseFloat(salvageValue) || 0),
        useful_life_months: isGoodwill ? 0 : parseInt(usefulLife),
        depreciation_method: isIntangible ? "straight_line" : method,
        asset_type: isIntangible ? "intangible" : "tangible",
        is_indefinite_life: isGoodwill,
        qbo_asset_account: assetAcct || undefined,
        qbo_accum_dep_account: accumAcct || undefined,
        qbo_dep_expense_account: expAcct || undefined,
      });
      onConfirm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create asset");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg overflow-y-auto max-h-[90vh] shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Mark as Fixed Asset</h2>
            <p className="text-xs text-gray-500 mt-0.5">{tx.description}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none ml-4">×</button>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-32">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            {suggestion && (
              <div className="bg-indigo-950/40 border border-indigo-800/50 rounded-lg px-3 py-2 text-xs text-indigo-300">
                ✦ AI pre-filled based on transaction description — review and adjust as needed
              </div>
            )}

            {isIntangible && (
              <div className="bg-violet-950/40 border border-violet-800/50 rounded-lg px-3 py-2 text-xs text-violet-300">
                {isGoodwill
                  ? "Goodwill has an indefinite useful life — no amortization is recorded. Annual impairment testing required."
                  : `Intangible asset — straight-line amortization only, no salvage value (GAAP ASC 350).`}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Asset Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Category</label>
                <select value={category} onChange={handleCategoryChange} className={inputCls}>
                  <optgroup label="Tangible Assets">
                    {FA_TANGIBLE_CATS.map(c => <option key={c}>{c}</option>)}
                  </optgroup>
                  <optgroup label="Intangible Assets">
                    {FA_INTANGIBLE_CATS.map(c => <option key={c}>{c}</option>)}
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Purchase Date</label>
                <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
                <input type="number" step="0.01" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} className={inputCls} />
              </div>
              {!isIntangible && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Salvage Value ($)</label>
                  <input type="number" step="0.01" value={salvageValue} onChange={e => setSalvageValue(e.target.value)} className={inputCls} />
                </div>
              )}
              {!isGoodwill && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Useful Life (months)</label>
                  <input type="number" min="1" value={usefulLife} onChange={e => setUsefulLife(e.target.value)} className={inputCls} />
                </div>
              )}
              {!isIntangible && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Depreciation Method</label>
                  <select value={method} onChange={e => setMethod(e.target.value)} className={inputCls}>
                    {FA_DEP_METHODS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-3 pt-1 border-t border-gray-800">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">QBO Accounts</p>
              {[
                { label: "Asset Account", value: assetAcct, set: setAssetAcct },
                { label: `Accumulated ${term} Account`, value: accumAcct, set: setAccumAcct },
                { label: `${term} Expense Account`, value: expAcct, set: setExpAcct },
              ].map(({ label, value, set }) => (
                <div key={label}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <AccountSelect
                    value={value}
                    onChange={set}
                    accounts={accounts}
                    placeholder="Type to search COA…"
                    className={inputCls}
                  />
                </div>
              ))}
            </div>

            <p className="text-xs text-gray-500 bg-gray-800 rounded-lg px-3 py-2">
              {isGoodwill
                ? "This will recode the transaction JE to debit the Goodwill asset account and approve the transaction. No amortization JEs will be generated."
                : `This will recode the transaction JE to debit the asset account, approve the transaction, and generate all historical ${term.toLowerCase()} journal entries.`}
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleConfirm}
                disabled={saving || !name || (!isGoodwill && !usefulLife)}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                {saving ? "Creating Asset…" : `Confirm — Create ${isIntangible ? "Intangible" : "Fixed"} Asset`}
              </button>
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── JE Row (always editable) ──────────────────────────────────────────────────

type RulePrompt = {
  matchType: "counterparty_contains" | "description_contains";
  matchValue: string;
  debit: string;
  credit: string;
};

function JeRow({
  je,
  tx,
  accounts,
  customers,
  isFirst,
  txRowCount,
  clientId,
  onUpdate,
  onDelete,
  onApprove,
  onReject,
  onSplit,
  onMarkAsFixedAsset,
  onMarkAsPrepaid,
}: {
  je: JournalEntry;
  tx: TransactionWithEntries;
  accounts: string[];
  customers: string[];
  isFirst: boolean;
  txRowCount: number;
  clientId: number;
  onUpdate: (je: JournalEntry) => void;
  onDelete: (jeId: number) => void;
  onApprove: (txId: number) => Promise<void>;
  onReject: (txId: number) => Promise<void>;
  onSplit: (txId: number) => Promise<void>;
  onMarkAsFixedAsset: (tx: TransactionWithEntries, jeId: number) => void;
  onMarkAsPrepaid: (tx: TransactionWithEntries) => void;
}) {
  const [debit, setDebit] = useState(je.debit_account);
  const [credit, setCredit] = useState(je.credit_account);
  const [amount, setAmount] = useState(String(je.amount));
  const [memo, setMemo] = useState(je.memo ?? "");
  const [customer, setCustomer] = useState(je.customer_name ?? "");
  const [jeDate, setJeDate] = useState(je.je_date?.slice(0, 10) ?? tx.date?.slice(0, 10) ?? "");
  const [amountFocused, setAmountFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | "split" | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleSaved, setRuleSaved] = useState(false);
  const [ruleAppliedCount, setRuleAppliedCount] = useState(0);
  // AI-matched override warning state
  const [pendingDebitOverride, setPendingDebitOverride] = useState<string | null>(null);

  const latestRef = useRef({ debit: je.debit_account, credit: je.credit_account, amount: String(je.amount), memo: je.memo ?? "" });

  useEffect(() => {
    setDebit(je.debit_account);
    setCredit(je.credit_account);
    setAmount(String(je.amount));
    setMemo(je.memo ?? "");
    setCustomer(je.customer_name ?? "");
    setJeDate(je.je_date?.slice(0, 10) ?? tx.date?.slice(0, 10) ?? "");
    setDirty(false);
    setRulePrompt(null);
    latestRef.current = { debit: je.debit_account, credit: je.credit_account, amount: String(je.amount), memo: je.memo ?? "" };
  }, [je, tx.date]);

  async function saveFields(fields: { debit: string; credit: string; amount: string; memo: string }): Promise<void> {
    setSaving(true);
    try {
      const updated = await updateJournalEntry(je.id, {
        debit_account: fields.debit,
        credit_account: fields.credit,
        amount: parseFloat(fields.amount) || je.amount,
        memo: fields.memo,
      });
      onUpdate(updated);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCustomerChange(v: string) {
    if (v === customer) return;
    setCustomer(v);
    updateJournalEntry(je.id, { customer_name: v }).then(onUpdate);
  }

  function showRulePrompt(newDebit: string, newCredit: string) {
    const matchValue = tx.counterparty_name || tx.description;
    const matchType = tx.counterparty_name ? "counterparty_contains" : "description_contains";
    setRulePrompt({ matchType, matchValue, debit: newDebit, credit: newCredit });
  }

  function handleDebitChange(v: string) {
    const oldDebit = latestRef.current.debit;
    // If this JE was AI-matched (DR Accrued / CR Bank) and the user is changing
    // the debit account AWAY from an accrued account, warn about double-booking.
    const wasAccrued = oldDebit.toLowerCase().includes("accrued");
    const isNowAccrued = v.toLowerCase().includes("accrued");
    if (je.is_ai_matched && wasAccrued && !isNowAccrued && v !== oldDebit) {
      setPendingDebitOverride(v);
      // revert visually until user confirms
      setDebit(oldDebit);
      return;
    }
    latestRef.current = { ...latestRef.current, debit: v };
    setDebit(v);
    saveFields(latestRef.current).then(() => {
      if (v !== oldDebit) showRulePrompt(v, latestRef.current.credit);
    });
  }

  function confirmDebitOverride() {
    if (!pendingDebitOverride) return;
    const v = pendingDebitOverride;
    const oldDebit = latestRef.current.debit;
    latestRef.current = { ...latestRef.current, debit: v };
    setDebit(v);
    setPendingDebitOverride(null);
    saveFields(latestRef.current).then(() => {
      if (v !== oldDebit) showRulePrompt(v, latestRef.current.credit);
    });
  }
  function handleCreditChange(v: string) {
    const oldCredit = latestRef.current.credit;
    latestRef.current = { ...latestRef.current, credit: v };
    setCredit(v);
    saveFields(latestRef.current).then(() => {
      if (v !== oldCredit) showRulePrompt(latestRef.current.debit, v);
    });
  }
  function handleAmountChange(v: string) {
    latestRef.current = { ...latestRef.current, amount: v };
    setAmount(v);
    setDirty(true);
  }
  function handleMemoChange(v: string) {
    latestRef.current = { ...latestRef.current, memo: v };
    setMemo(v);
    setDirty(true);
  }

  async function saveOnBlur() {
    if (!dirty) return;
    await saveFields(latestRef.current);
  }

  async function doApprove() {
    if (dirty) await saveFields(latestRef.current);
    setActing("approve");
    try { await onApprove(tx.id); } finally { setActing(null); }
  }
  async function doReject() {
    setActing("reject");
    try { await onReject(tx.id); } finally { setActing(null); }
  }
  async function doSplit() {
    setActing("split");
    try { await onSplit(tx.id); } finally { setActing(null); }
  }

  async function handleSaveRule() {
    if (!rulePrompt) return;
    setSavingRule(true);
    try {
      const saved = await createRule({
        client_id: clientId,
        match_type: rulePrompt.matchType,
        match_value: rulePrompt.matchValue,
        debit_account: rulePrompt.debit,
        credit_account: rulePrompt.credit,
        created_from_transaction_id: tx.id,
      });
      setRulePrompt(null);
      const applyRes = await applyRule(saved.id).catch(() => ({ applied: 0 }));
      setRuleAppliedCount(applyRes.applied);
      setRuleSaved(true);
      setTimeout(() => setRuleSaved(false), 4000);
    } catch {
      setRulePrompt(null);
    } finally {
      setSavingRule(false);
    }
  }

  const canDelete = txRowCount > 1;
  // Customer tagging applies to money-in / income lines: deposits (positive
  // amount) plus interest-earned entries regardless of sign.
  const showCustomer =
    tx.amount >= 0 ||
    credit.toLowerCase().includes("interest earned") ||
    debit.toLowerCase().includes("interest earned");
  const cellBase = "px-3 py-2 text-xs align-middle";
  const inputCls = "w-full bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-500 font-mono";

  const matchedInv = je.matched_invoice;

  return (
    <>
    {je.is_ai_matched && matchedInv && (
      <tr className="bg-amber-950/30 border-b border-amber-900/30">
        <td colSpan={12} className="px-4 py-1.5">
          <div className="flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-700/40 text-amber-200 border border-amber-700 font-medium">
              🔗 AI Matched
              {je.match_confidence != null && (
                <span className="text-amber-300/80 font-mono">{Math.round((je.match_confidence ?? 0) * 100)}%</span>
              )}
            </span>
            <span className="text-amber-100/90">
              Matched to:{" "}
              <span className="text-white font-medium">{matchedInv.vendor || "vendor"}</span>{" "}
              {matchedInv.invoice_number && (
                <>invoice <span className="font-mono">#{matchedInv.invoice_number}</span> </>
              )}
              for ${matchedInv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              {matchedInv.date && (
                <> dated <span className="font-mono">{matchedInv.date.slice(0, 10)}</span></>
              )}
            </span>
          </div>
        </td>
      </tr>
    )}
    <tr className={`border-b border-gray-800 ${isFirst && !je.is_ai_matched ? "border-t border-t-gray-700" : ""} hover:bg-gray-800/20 transition-colors`}>
      {/* Date — per JE row */}
      <td data-col="date" className={`${cellBase} whitespace-nowrap`}>
        <input
          type="date"
          value={jeDate}
          onChange={(e) => setJeDate(e.target.value)}
          onBlur={(e) => {
            const val = e.target.value;
            if (val && val !== (je.je_date?.slice(0, 10) ?? tx.date?.slice(0, 10))) {
              updateJournalEntry(je.id, { je_date: val }).then(onUpdate);
            }
          }}
          className="bg-transparent border border-transparent hover:border-gray-600 focus:border-indigo-500 text-gray-400 rounded px-1 py-0.5 text-xs focus:outline-none focus:text-white w-full"
        />
      </td>

      {/* Description — only on first row */}
      {isFirst ? (
        <td data-col="description" className={`${cellBase}`} rowSpan={txRowCount}>
          <div className="truncate text-white font-medium">{tx.description}</div>
          {tx.counterparty_name && tx.counterparty_name !== tx.description && (
            <div className="truncate text-gray-500 text-xs">{tx.counterparty_name}</div>
          )}
          {tx.mercury_account_name && (
            <div className="text-gray-600 text-xs truncate">{tx.mercury_account_name}</div>
          )}
        </td>
      ) : null}

      {/* TX Amount — only on first row */}
      {isFirst ? (
        <td data-col="amount" className={`${cellBase} text-right whitespace-nowrap font-mono`} rowSpan={txRowCount}>
          <span className={tx.amount < 0 ? "text-red-400" : "text-green-400"}>
            {tx.amount < 0 ? "-" : "+"}${Math.abs(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        </td>
      ) : null}

      {/* Category — only on first row */}
      {isFirst ? (
        <td data-col="category" className={`${cellBase} whitespace-nowrap`} rowSpan={txRowCount}>
          {formatCategory(tx.mercury_category) ? (
            <span className="text-gray-400 text-xs truncate block">{formatCategory(tx.mercury_category)}</span>
          ) : null}
        </td>
      ) : null}

      {/* Debit account */}
      <td data-col="debit" className={`${cellBase}`}>
        <AccountSelect value={debit} onChange={handleDebitChange} accounts={accounts} />
      </td>

      {/* Credit account */}
      <td data-col="credit" className={`${cellBase}`}>
        <AccountSelect value={credit} onChange={handleCreditChange} accounts={accounts} />
      </td>

      {/* Customer — only for money-in / income (deposits + interest earned) */}
      <td data-col="customer" className={`${cellBase}`}>
        {showCustomer ? (
          <CustomerSelect value={customer} onChange={handleCustomerChange} customers={customers} />
        ) : (
          <span className="text-gray-700 text-xs px-2">—</span>
        )}
      </td>

      {/* JE Amount */}
      <td data-col="jeAmt" className={`${cellBase} text-right whitespace-nowrap`}>
        <input
          type="text"
          inputMode="decimal"
          value={amountFocused ? amount : Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          onFocus={() => setAmountFocused(true)}
          onChange={(e) => handleAmountChange(e.target.value)}
          onBlur={() => { setAmountFocused(false); saveOnBlur(); }}
          className={`${inputCls} text-right`}
        />
      </td>

      {/* Memo */}
      <td data-col="memo" className={`${cellBase}`}>
        <input
          value={memo}
          onChange={(e) => handleMemoChange(e.target.value)}
          onBlur={saveOnBlur}
          placeholder="Memo…"
          className={`${inputCls} font-sans`}
        />
      </td>

      {/* Confidence */}
      <td data-col="conf" className={`${cellBase} text-center`}>
        {saving ? (
          <span className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin inline-block" />
        ) : (
          <ConfBadge score={je.ai_confidence} reasoning={je.ai_reasoning} />
        )}
        {je.rule_applied && <span className="block text-blue-400 text-xs">rule</span>}
      </td>

      {/* AI Reasoning */}
      <td data-col="reasoning" className={`${cellBase}`}>
        {je.ai_reasoning ? (
          <span className="text-gray-600 text-xs line-clamp-2 cursor-help" title={je.ai_reasoning}>
            {je.ai_reasoning}
          </span>
        ) : (
          <span className="text-gray-700 text-xs">—</span>
        )}
      </td>

      {/* Actions */}
      <td data-col="actions" className={`${cellBase} whitespace-nowrap`}>
        <div className="flex items-center gap-1">
          {isFirst && (
            <button
              onClick={doSplit}
              disabled={acting === "split"}
              className="px-2 py-1 text-gray-400 hover:text-indigo-300 hover:bg-gray-700 text-xs rounded transition-colors disabled:opacity-50"
              title="Add a split journal entry"
            >
              Split
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(je.id)}
              className="px-2 py-1 text-gray-600 hover:text-red-400 hover:bg-gray-700 text-xs rounded transition-colors"
              title="Remove this split"
            >
              ✕
            </button>
          )}
          {isFirst && (
            <>
              <button
                onClick={doApprove}
                disabled={!!acting}
                className="px-2 py-1 bg-green-800 hover:bg-green-700 text-green-200 text-xs rounded transition-colors disabled:opacity-50"
                title="Approve transaction"
              >
                {acting === "approve" ? "…" : "✓"}
              </button>
              <button
                onClick={doReject}
                disabled={!!acting}
                className="px-2 py-1 text-gray-500 hover:text-red-400 hover:bg-gray-700 text-xs rounded transition-colors disabled:opacity-50"
                title="Reject transaction"
              >
                {acting === "reject" ? "…" : "✗"}
              </button>
              <button
                onClick={() => onMarkAsFixedAsset(tx, je.id)}
                disabled={!!acting}
                className="px-2 py-1 text-gray-500 hover:text-amber-400 hover:bg-gray-700 text-xs rounded transition-colors disabled:opacity-50"
                title="Mark as Fixed Asset"
              >
                🏗
              </button>
              <button
                onClick={() => onMarkAsPrepaid(tx)}
                disabled={!!acting}
                className="px-2 py-1 text-gray-500 hover:text-indigo-400 hover:bg-gray-700 text-xs rounded transition-colors disabled:opacity-50"
                title="Code as Prepaid Expense"
              >
                🗓
              </button>
            </>
          )}
        </div>
      </td>
    </tr>

    {rulePrompt && (
      <tr className="bg-amber-950/30 border-b border-amber-900/20">
        <td colSpan={12} className="px-4 py-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-amber-400 shrink-0">⊕ Rule</span>
            <span className="text-gray-300">
              Save{" "}
              <span className="text-white font-medium">
                &ldquo;{rulePrompt.debit} / {rulePrompt.credit}&rdquo;
              </span>{" "}
              as a permanent rule for{" "}
              <span className="text-white font-medium">&ldquo;{rulePrompt.matchValue}&rdquo;</span>?
            </span>
            <button
              onClick={handleSaveRule}
              disabled={savingRule}
              className="shrink-0 px-2.5 py-0.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-amber-100 rounded text-xs font-medium transition-colors"
            >
              {savingRule ? "Saving…" : "Save Rule"}
            </button>
            <button
              onClick={() => setRulePrompt(null)}
              className="shrink-0 text-gray-500 hover:text-gray-300 text-xs transition-colors"
            >
              Dismiss
            </button>
          </div>
        </td>
      </tr>
    )}

    {ruleSaved && !rulePrompt && (
      <tr className="bg-green-950/20 border-b border-green-900/20">
        <td colSpan={12} className="px-4 py-1.5">
          <span className="text-green-400 text-xs">
            ✓ Rule saved
            {ruleAppliedCount > 0 ? ` — applied to ${ruleAppliedCount} additional pending transaction${ruleAppliedCount !== 1 ? "s" : ""}` : " — future transactions from this vendor will be coded automatically"}
          </span>
        </td>
      </tr>
    )}

    {pendingDebitOverride && (
      <DoubleBookWarning
        vendor={matchedInv?.vendor || tx.counterparty_name || tx.description}
        amount={matchedInv?.amount || Math.abs(tx.amount)}
        newDebit={pendingDebitOverride}
        onCancel={() => setPendingDebitOverride(null)}
        onConfirm={confirmDebitOverride}
      />
    )}
    </>
  );
}

function DoubleBookWarning({
  vendor, amount, newDebit, onCancel, onConfirm,
}: {
  vendor: string;
  amount: number;
  newDebit: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <tr>
      <td colSpan={12} className="p-0">
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-gray-900 border border-amber-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-amber-800/40">
              <h2 className="text-base font-semibold text-amber-300">⚠ Double-booking risk</h2>
            </div>
            <div className="px-6 py-5 space-y-3 text-sm text-gray-300">
              <p>
                This transaction was AI-matched to an existing accrual for{" "}
                <span className="text-white font-medium">{vendor}</span> (${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}).
              </p>
              <p>
                Changing the debit account to{" "}
                <span className="text-white font-medium">&ldquo;{newDebit}&rdquo;</span> (instead of an accrual liability) may result in
                double-booking the expense in QBO — once at invoice time, again at payment.
              </p>
              <p className="text-gray-400 text-xs">Are you sure you want to override the AI match?</p>
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">
                Keep AI coding
              </button>
              <button onClick={onConfirm} className="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium rounded-lg transition-colors">
                Override anyway
              </button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── No-JE Row ─────────────────────────────────────────────────────────────────

function NoJeRow({ tx }: { tx: TransactionWithEntries }) {
  const cellBase = "px-3 py-2 text-xs align-middle";
  return (
    <tr className="border-t border-gray-700 border-b border-gray-800 bg-red-950/10">
      <td data-col="date" className={`${cellBase} text-gray-400 whitespace-nowrap`}>
        {tx.date ? new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
      </td>
      <td data-col="description" className={`${cellBase}`}>
        <div className="truncate text-white font-medium">{tx.description}</div>
        {tx.counterparty_name && <div className="truncate text-gray-500 text-xs">{tx.counterparty_name}</div>}
      </td>
      <td data-col="amount" className={`${cellBase} text-right whitespace-nowrap font-mono`}>
        <span className={tx.amount < 0 ? "text-red-400" : "text-green-400"}>
          {tx.amount < 0 ? "-" : "+"}${Math.abs(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </span>
      </td>
      <td colSpan={9} className={cellBase}>
        <span className="text-red-400 text-xs">No journal entry — click &ldquo;Run AI Coding&rdquo; to generate</span>
      </td>
    </tr>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ReviewQueuePage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setPageContext, setCurrentPage } = useChatContext();

  const [items, setItems] = useState<TransactionWithEntries[]>([]);
  const { accounts } = useAccounts(clientId);
  const { customers } = useCustomers(clientId);
  const [loading, setLoading] = useState(true);
  const [coding, setCoding] = useState(false);
  const [codingProgress, setCodingProgress] = useState<{ done: number; total: number } | null>(null);
  const [codingError, setCodingError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeOption>("last_month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [sortBy, setSortBy] = useState<"standard" | "amount" | "confidence" | "debit" | "credit">("standard");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(loadColWidths);
  const [hiddenCols, setHiddenCols] = useState<ColKey[]>([]);
  // "all", or a "YYYY-MM" to work one month at a time.
  const [monthFilter, setMonthFilter] = useState<string>("all");
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [colMenuOpen, setColMenuOpen] = useState(false);

  // Read on mount rather than seeding state from localStorage during render:
  // the server has none, so the first client render would disagree with the
  // server's and React throws the tree away.
  useEffect(() => { setHiddenCols(loadHiddenCols()); }, []);

  function toggleCol(col: ColKey) {
    if (ALWAYS_SHOWN.includes(col)) return;
    setHiddenCols((prev) => {
      const next = prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col];
      try { localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function showAllCols() {
    setHiddenCols([]);
    try { localStorage.setItem(HIDDEN_COLS_KEY, "[]"); } catch {}
  }
  const [fixedAssetTarget, setFixedAssetTarget] = useState<{ tx: TransactionWithEntries; jeId: number } | null>(null);
  const [prepaidTarget, setPrepaidTarget] = useState<TransactionWithEntries | null>(null);

  // Resize drag logic
  function startResize(col: ColKey, e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidths[col];

    function onMove(ev: MouseEvent) {
      const newW = Math.max(50, startW + ev.clientX - startX);
      setColWidths((prev) => ({ ...prev, [col]: newW }));
    }
    function onUp(ev: MouseEvent) {
      const newW = Math.max(50, startW + ev.clientX - startX);
      setColWidths((prev) => {
        const next = { ...prev, [col]: newW };
        localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(next));
        return next;
      });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    setCurrentPage("review_queue");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

  useEffect(() => {
    if (items.length === 0) return;
    const summary = items.map((tx) => ({
      id: tx.id,
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      account: tx.mercury_account_name,
      journal_entries: tx.journal_entries.map((je) => ({
        debit: je.debit_account,
        credit: je.credit_account,
        amount: je.amount,
        memo: je.memo,
        confidence: je.ai_confidence,
        reasoning: je.ai_reasoning,
      })),
    }));
    setPageContext(JSON.stringify(summary));
  }, [items, setPageContext]);

  const reload = useCallback(() => {
    setLoading(true);
    getTransactionsWithEntries(clientId, "pending", true)
      .then(setItems)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    reload();
  }, [clientId, reload]);

  const reloadLastSync = useCallback(() => {
    getClient(clientId).then((c) => setLastSyncAt(parseUtc(c.last_sync_at))).catch(() => {});
  }, [clientId]);

  useEffect(() => { reloadLastSync(); }, [reloadLastSync]);

  useEffect(() => {
    window.addEventListener("bb-data-changed", reload);
    return () => window.removeEventListener("bb-data-changed", reload);
  }, [reload]);

  // Chunk through all pending transactions so a large backlog (e.g. 100+)
  // never hits Railway's per-request HTTP timeout. Returns total JEs created.
  let lastRemainingOut = 0;

  async function runCodingLoop(opts?: { onProgress?: (done: number, total: number) => void }): Promise<number> {
    const CHUNK = 5;
    const MAX_ROUNDS = 200; // safety stop (~1000 transactions)
    let totalCreated = 0;
    let initialRemaining: number | null = null;
    let lastRemaining: number | null = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await codePending(clientId, CHUNK);
      totalCreated += result.je_created;
      const remaining = result.remaining_uncoded ?? 0;
      if (initialRemaining === null) initialRemaining = remaining + (result.je_created > 0 ? CHUNK : 0);
      const done = Math.max(0, (initialRemaining ?? 0) - remaining);
      opts?.onProgress?.(done, initialRemaining ?? done);
      if (remaining === 0) break;
      // Stop when a round stops reducing the backlog, not merely when it
      // creates nothing. A transaction coded against an account that no longer
      // exists in QBO is recoded to the same name every round, so je_created
      // stays positive while `remaining` never moves — which span the full 200
      // rounds reporting entries created and changing nothing.
      if (result.je_created === 0) break;
      if (lastRemaining !== null && remaining >= lastRemaining) break;
      lastRemaining = remaining;
    }
    lastRemainingOut = lastRemaining ?? 0;
    return totalCreated;
  }

  async function handleRunCoding() {
    setCoding(true);
    setCodingError(null);
    setCodingProgress(null);
    try {
      const totalCreated = await runCodingLoop({
        onProgress: (done, total) => setCodingProgress({ done, total }),
      });
      const remainingAfter = lastRemainingOut;
      if (totalCreated === 0) {
        setCodingError("AI coding ran but created 0 journal entries.");
      } else if (remainingAfter > 0) {
        // Honest about the stuck remainder rather than reporting success: these
        // are almost always transactions coded to an account name that is not
        // in the live QBO chart, which recoding cannot fix on its own.
        setCodingError(
          `Coded what it could. ${remainingAfter} transaction${remainingAfter !== 1 ? "s" : ""} ` +
          `still need attention — usually an account name that no longer exists in QuickBooks. ` +
          `Check the Debit/Credit columns on those rows.`,
        );
      }
      reload();
    } catch (err: unknown) {
      setCodingError(err instanceof Error ? err.message : "Coding failed");
    } finally {
      setCoding(false);
      setCodingProgress(null);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setCodingError(null);
    try {
      await syncMercury(
        clientId, dateRange,
        dateRange === "custom" ? customStart : undefined,
        dateRange === "custom" ? customEnd : undefined,
      );
      // Re-code any pending transactions still left with Uncoded JEs. The
      // import already committed, so a coding failure isn't a failed sync —
      // but it does need saying out loud (a lapsed QBO connection lands here).
      try {
        await runCodingLoop();
      } catch (codeErr) {
        console.error("Post-sync coding failed:", codeErr);
        setCodingError(
          codeErr instanceof Error
            ? `Transactions imported, but AI coding failed: ${codeErr.message}`
            : "Transactions imported, but AI coding failed.",
        );
      }
      reload();
      reloadLastSync();
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleApprove(txId: number) {
    try {
      await updateTransactionStatus(txId, "approved");
      setItems((prev) => prev.filter((t) => t.id !== txId));
    } catch (err: unknown) {
      // Backend rejects (422) when a JE references a non-QBO account.
      // Surface the message so the user knows what to fix.
      alert(err instanceof Error ? err.message : "Approve failed");
    }
  }

  async function handleReject(txId: number) {
    await updateTransactionStatus(txId, "rejected");
    setItems((prev) => prev.filter((t) => t.id !== txId));
  }

  function handleJeUpdate(txId: number, je: JournalEntry) {
    setItems((prev) =>
      prev.map((tx) =>
        tx.id === txId
          ? { ...tx, journal_entries: tx.journal_entries.map((j) => (j.id === je.id ? je : j)) }
          : tx
      )
    );
  }

  async function handleDelete(jeId: number) {
    await deleteJournalEntry(jeId);
    setItems((prev) =>
      prev.map((tx) => ({
        ...tx,
        journal_entries: tx.journal_entries.filter((j) => j.id !== jeId),
      }))
    );
  }

  async function handleSplit(txId: number) {
    const tx = items.find((t) => t.id === txId);
    if (!tx) return;
    const existing = tx.journal_entries[0];
    const newJe = await createJournalEntry({
      transaction_id: txId,
      debit_account: existing?.debit_account ?? "",
      credit_account: existing?.credit_account ?? "",
      amount: 0,
      memo: "",
    });
    setItems((prev) =>
      prev.map((t) =>
        t.id === txId ? { ...t, journal_entries: [...t.journal_entries, newJe] } : t
      )
    );
  }

  async function approveAll() {
    // What is on screen, not everything loaded. With a month filter active the
    // two differ, and approving rows the user cannot see — November's, while
    // they are closing October — is not something to do quietly.
    const approvable = visibleItems.filter((t) => t.journal_entries.length > 0);
    setApprovingAll(true);
    try {
      // Run sequentially so we can collect per-tx COA-validation failures.
      const succeeded: number[] = [];
      const failures: string[] = [];
      for (const tx of approvable) {
        try {
          await updateTransactionStatus(tx.id, "approved");
          succeeded.push(tx.id);
        } catch (err: unknown) {
          const label = tx.counterparty_name || tx.description || `txn ${tx.id}`;
          failures.push(`${label}: ${err instanceof Error ? err.message : "approve failed"}`);
        }
      }
      const ids = new Set(succeeded);
      setItems((prev) => prev.filter((t) => !ids.has(t.id)));
      if (failures.length > 0) {
        alert(
          `${succeeded.length} approved, ${failures.length} failed.\n\n` +
          failures.slice(0, 10).join("\n\n") +
          (failures.length > 10 ? `\n\n…and ${failures.length - 10} more` : ""),
        );
      }
    } finally {
      setApprovingAll(false);
    }
  }

  // Months present in the queue, newest first, each with how many rows it holds.
  // Built from what is actually loaded rather than a fixed range, so a month
  // with nothing in it never appears as an empty choice.
  const availableMonths = (() => {
    const counts = new Map<string, number>();
    for (const t of items) {
      if (!t.date) continue;
      const d = new Date(t.date);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([value, count]) => {
        const [y, m] = value.split("-").map(Number);
        return {
          value,
          count,
          label: new Date(y, m - 1, 1).toLocaleDateString("en-US",
            { month: "short", year: "numeric" }),
        };
      });
  })();

  // "Last month" and "This month" resolve against today, not against what the
  // queue happens to contain. A month with nothing in it still has to be
  // selectable — otherwise the way you discover October is empty is that the
  // option for it is missing, which reads as a bug.
  function resolveMonthFilter(value: string): string | null {
    if (value === "all") return null;
    const now = new Date();
    if (value === "rel:this") {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
    if (value === "rel:last") {
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const m = now.getMonth() === 0 ? 12 : now.getMonth();
      return `${y}-${String(m).padStart(2, "0")}`;
    }
    return value;
  }

  const monthOf = (t: { date?: string | null }) => {
    if (!t.date) return null;
    const d = new Date(t.date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const relMonthCounts = {
    last: items.filter((t) => monthOf(t) === resolveMonthFilter("rel:last")).length,
    this: items.filter((t) => monthOf(t) === resolveMonthFilter("rel:this")).length,
  };

  // Filter before sorting, so the counts below the heading describe what is
  // actually on screen.
  const activeMonth = resolveMonthFilter(monthFilter);
  const visibleItems = activeMonth === null
    ? items
    : items.filter((t) => monthOf(t) === activeMonth);

  const sortedItems = [...visibleItems].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "amount") {
      cmp = Math.abs(a.amount) - Math.abs(b.amount);
    } else if (sortBy === "confidence") {
      const ca = a.journal_entries[0]?.ai_confidence ?? -1;
      const cb = b.journal_entries[0]?.ai_confidence ?? -1;
      cmp = ca - cb;
    } else if (sortBy === "debit") {
      cmp = (a.journal_entries[0]?.debit_account ?? "").localeCompare(b.journal_entries[0]?.debit_account ?? "");
    } else if (sortBy === "credit") {
      cmp = (a.journal_entries[0]?.credit_account ?? "").localeCompare(b.journal_entries[0]?.credit_account ?? "");
    }
    return sortBy === "standard" ? 0 : sortDir === "desc" ? -cmp : cmp;
  });

  const coded = sortedItems.filter((t) => t.journal_entries.length > 0);

  const pullDates = pullRange(dateRange, lastSyncAt);
  const pullRangeText = pullDates ? formatRange(pullDates[0], pullDates[1]) : null;
  const monthFilterLabel =
    monthFilter === "all" ? "All months"
    : monthFilter === "rel:last" ? "Last month"
    : monthFilter === "rel:this" ? "This month"
    : availableMonths.find((m) => m.value === monthFilter)?.label ?? monthFilter;
  const uncoded = sortedItems.filter((t) => t.journal_entries.length === 0);

  const isHidden = (c: ColKey) => hiddenCols.includes(c);

  // A hidden column keeps its cell and loses its width. Dropping the cells
  // instead would be simpler to read but wrong: the first four columns use
  // rowSpan across a transaction's entries and the empty-state rows use
  // colSpan, so removing cells pulls those rows out of alignment. Collapsing
  // to zero and clipping leaves every row structurally identical.
  const hiddenColCss = hiddenCols.length === 0 ? "" : hiddenCols
    .map((c) => `[data-col="${c}"]{padding-left:0!important;padding-right:0!important;` +
                `overflow:hidden!important;white-space:nowrap!important;` +
                `border-left-width:0!important;border-right-width:0!important}`)
    .join("");

  // Hide this one column, from its own header. The Columns menu still exists
  // for turning several back on at once, but reaching for a menu to remove the
  // column you are looking at is a detour.
  const hideBtn = (col: ColKey) =>
    ALWAYS_SHOWN.includes(col) ? null : (
      <button
        onClick={(e) => { e.stopPropagation(); toggleCol(col); }}
        onMouseDown={(e) => e.stopPropagation()}
        title={`Hide ${COL_LABELS[col]}`}
        aria-label={`Hide ${COL_LABELS[col]}`}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded
                   text-gray-600 hover:text-white hover:bg-gray-700
                   opacity-0 group-hover/th:opacity-100 focus:opacity-100 transition-opacity"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    );

  // Resize handle rendered inside each <th>
  const handle = (col: ColKey) => (
    <div
      onMouseDown={(e) => startResize(col, e)}
      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-indigo-500/40 active:bg-indigo-500/70 select-none"
    />
  );

  return (
    <div className="w-full">
      {hiddenColCss && <style>{hiddenColCss}</style>}
      {fixedAssetTarget && (
        <FixedAssetPanel
          tx={fixedAssetTarget.tx}
          jeId={fixedAssetTarget.jeId}
          clientId={clientId}
          accounts={accounts}
          onConfirm={() => {
            setFixedAssetTarget(null);
            reload();
          }}
          onClose={() => setFixedAssetTarget(null)}
        />
      )}
      {prepaidTarget && (
        <PrepaidPanel
          tx={prepaidTarget}
          clientId={clientId}
          accounts={accounts}
          onConfirm={() => {
            setPrepaidTarget(null);
            reload();
          }}
          onClose={() => setPrepaidTarget(null)}
        />
      )}

      {/* Header: title on the left, the two whole-queue actions on the right */}
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white leading-tight">Review Queue</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {items.length} pending
            {uncoded.length > 0 && ` · ${uncoded.length} need coding`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={handleRunCoding}
            disabled={coding || loading}
            className="flex items-center gap-2 bg-gray-950 hover:bg-gray-900 border border-gray-700 disabled:opacity-50 text-gray-200 hover:text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            {coding ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                {codingProgress && codingProgress.total > 0
                  ? `Coding ${codingProgress.done}/${codingProgress.total}…`
                  : "Coding…"}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3z" />
                </svg>
                AI Code
              </>
            )}
          </button>
          {coded.length > 0 && (
            <button
              onClick={approveAll}
              disabled={approvingAll}
              className="flex items-center gap-2 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-gray-950 text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              {approvingAll ? "Approving…" : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.25} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Approve all ({coded.length})
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Pull bar: what to fetch from Mercury. Its own tinted panel so it reads
          as a different kind of action from the filter below, which only
          narrows what is already on screen. */}
      <div className="mb-5 flex items-center gap-3 flex-wrap bg-indigo-950/30 border border-indigo-900/70 rounded-xl px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-300 whitespace-nowrap">
          <svg className="w-4 h-4 text-indigo-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Pull from
        </span>
        {/* A styled face over a transparent native select: the look of the
            mockup, the keyboard and mobile behaviour of a real select. */}
        <div className="relative flex items-center gap-2 bg-gray-950 border border-gray-700 hover:border-gray-600 rounded-lg pl-3 pr-2.5 py-2 text-sm">
          <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <rect x="3.5" y="5" width="17" height="15" rx="2" />
            <path strokeLinecap="round" d="M3.5 10h17M8 3v4M16 3v4" />
          </svg>
          <span className="font-semibold text-white whitespace-nowrap">{DATE_RANGE_LABELS[dateRange]}</span>
          {pullRangeText && (
            <span className="text-gray-400 whitespace-nowrap">
              <span className="text-gray-600 mx-1">·</span>{pullRangeText}
            </span>
          )}
          <svg className="w-4 h-4 text-gray-500 ml-1 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeOption)}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
            aria-label="Date range to pull from Mercury"
          >
            {(Object.keys(DATE_RANGE_LABELS) as DateRangeOption[]).map((k) => (
              <option key={k} value={k}>{DATE_RANGE_LABELS[k]}</option>
            ))}
          </select>
        </div>
        {dateRange === "custom" && (
          <div className="flex items-center gap-1.5">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
              className="bg-gray-950 border border-gray-700 text-gray-300 text-sm rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <span className="text-gray-600 text-sm">→</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
              className="bg-gray-950 border border-gray-700 text-gray-300 text-sm rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
          </div>
        )}
        <button
          onClick={handleSync}
          disabled={syncing || coding || loading || (dateRange === "custom" && (!customStart || !customEnd))}
          className="flex items-center gap-2 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          {syncing ? (
            <><span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Syncing…</>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync &amp; Code
            </>
          )}
        </button>
        <span className="ml-auto text-xs text-gray-500 whitespace-nowrap">
          {lastSyncAt ? `Last synced ${timeAgo(lastSyncAt)}` : "Never synced"}
        </span>
      </div>

      {/* Show only one month — for closing October while November's
          transactions are already arriving. Filters what is on screen; it
          does not change what has been imported. Tints when a filter is on so
          the state is visible without reading it. */}
      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <span className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 8.5V19l-4 2v-8.5L3 4z" />
          </svg>
          Showing
        </span>
        <div className={`relative flex items-center gap-2 border rounded-lg pl-3 pr-2.5 py-1.5 text-sm ${
          monthFilter === "all"
            ? "bg-gray-950 border-gray-700 hover:border-gray-600"
            : "bg-indigo-950/60 border-indigo-700"}`}>
          <span className={`font-semibold whitespace-nowrap ${monthFilter === "all" ? "text-white" : "text-indigo-200"}`}>
            {monthFilterLabel}
          </span>
          <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
            title="Show only transactions dated in one month"
            aria-label="Show only transactions dated in one month"
          >
            <option value="all">All months</option>
            {/* Relative options first: the month you are closing is the one you
                want nine times out of ten, and naming it by number means
                working out which month that is every time. */}
            <option value="rel:last">
              Last month{relMonthCounts.last !== null ? ` (${relMonthCounts.last})` : ""}
            </option>
            <option value="rel:this">
              This month{relMonthCounts.this !== null ? ` (${relMonthCounts.this})` : ""}
            </option>
            {availableMonths.length > 0 && <option disabled>──────────</option>}
            {availableMonths.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label} ({m.count})
              </option>
            ))}
          </select>
        </div>
        <span className="text-sm text-gray-500">
          {visibleItems.length} {visibleItems.length === 1 ? "entry" : "entries"}
          {monthFilter !== "all" && (
            <>
              {" of "}{items.length}{" · "}
              <button onClick={() => setMonthFilter("all")}
                className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
                show all
              </button>
            </>
          )}
        </span>

        {/* Columns */}
        <div className="relative ml-auto">
          <button
            onClick={() => setColMenuOpen((o) => !o)}
            className={`flex items-center gap-2 border text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${
              hiddenCols.length > 0
                ? "bg-indigo-950 border-indigo-600 text-indigo-200"
                : "bg-gray-950 border-gray-700 text-gray-200 hover:border-gray-600"}`}
            title="Show or hide columns. Drag a column edge to resize."
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
              <path strokeLinecap="round" d="M9.5 4.5v15M14.5 4.5v15" />
            </svg>
            Columns{hiddenCols.length > 0 && ` (${hiddenCols.length} hidden)`}
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {colMenuOpen && (
            <>
              {/* Click anywhere else to close */}
              <div className="fixed inset-0 z-40" onClick={() => setColMenuOpen(false)} />
              <div className="absolute right-0 mt-1 z-50 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1">
                <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500">
                  Show columns
                </p>
                {(Object.keys(COL_LABELS) as ColKey[]).map((c) => {
                  const locked = ALWAYS_SHOWN.includes(c);
                  return (
                    <label
                      key={c}
                      className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                        locked ? "text-gray-600 cursor-default" : "text-gray-300 hover:bg-gray-800 cursor-pointer"}`}
                      title={locked ? "Always shown" : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={!isHidden(c)}
                        disabled={locked}
                        onChange={() => toggleCol(c)}
                        className="accent-indigo-500"
                      />
                      {COL_LABELS[c]}
                    </label>
                  );
                })}
                <div className="border-t border-gray-800 mt-1 pt-1 px-3 pb-1">
                  <button
                    onClick={showAllCols}
                    disabled={hiddenCols.length === 0}
                    className="text-[11px] text-gray-400 hover:text-white disabled:opacity-40 disabled:hover:text-gray-400"
                  >
                    Show all
                  </button>
                  <p className="text-[10px] text-gray-600 mt-1">Drag a column edge to resize.</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {(codingError || syncError) && (
        <div className="mb-3 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-2.5 text-xs">
          {codingError || syncError}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-7 h-7 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-24 text-gray-500">
          <p className="text-4xl mb-4">✓</p>
          <p className="text-lg font-medium text-gray-400">Queue is empty</p>
          <p className="text-sm mt-1">Sync Mercury to import new transactions.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="border-collapse text-sm table-fixed" style={{ width: (Object.keys(colWidths) as ColKey[])
              .reduce((a, k) => a + (isHidden(k) ? 0 : colWidths[k]), 0) }}>
            <colgroup>
              <col style={{ width: isHidden("date") ? 0 : colWidths.date }} />
              <col style={{ width: isHidden("description") ? 0 : colWidths.description }} />
              <col style={{ width: isHidden("amount") ? 0 : colWidths.amount }} />
              <col style={{ width: isHidden("category") ? 0 : colWidths.category }} />
              <col style={{ width: isHidden("debit") ? 0 : colWidths.debit }} />
              <col style={{ width: isHidden("credit") ? 0 : colWidths.credit }} />
              <col style={{ width: isHidden("customer") ? 0 : colWidths.customer }} />
              <col style={{ width: isHidden("jeAmt") ? 0 : colWidths.jeAmt }} />
              <col style={{ width: isHidden("memo") ? 0 : colWidths.memo }} />
              <col style={{ width: isHidden("conf") ? 0 : colWidths.conf }} />
              <col style={{ width: isHidden("reasoning") ? 0 : colWidths.reasoning }} />
              <col style={{ width: isHidden("actions") ? 0 : colWidths.actions }} />
            </colgroup>
            <thead>
              <tr className="bg-gray-900 text-gray-500 text-xs uppercase tracking-wider">
                <th data-col="date" className="group/th pr-7 px-3 py-2.5 text-left font-medium whitespace-nowrap relative select-none">Date{hideBtn("date")}{handle("date")}</th>
                <th data-col="description" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Description{hideBtn("description")}{handle("description")}</th>
                <th data-col="amount" className="group/th pr-7 px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">
                  <button onClick={() => { if (sortBy === "amount") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("amount"); setSortDir("desc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Amount <span className={sortBy === "amount" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "amount" && sortDir === "asc" ? "↑" : "↓"}</span>
                  </button>
                  {hideBtn("amount")}{handle("amount")}
                </th>
                <th data-col="category" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Category{hideBtn("category")}{handle("category")}</th>
                <th data-col="debit" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "debit") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("debit"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Debit Account <span className={sortBy === "debit" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "debit" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {hideBtn("debit")}{handle("debit")}
                </th>
                <th data-col="credit" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "credit") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("credit"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Credit Account <span className={sortBy === "credit" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "credit" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {hideBtn("credit")}{handle("credit")}
                </th>
                <th data-col="customer" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Customer{hideBtn("customer")}{handle("customer")}</th>
                <th data-col="jeAmt" className="group/th pr-7 px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">JE Amt{hideBtn("jeAmt")}{handle("jeAmt")}</th>
                <th data-col="memo" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Memo{hideBtn("memo")}{handle("memo")}</th>
                <th data-col="conf" className="group/th pr-7 px-3 py-2.5 text-center font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "confidence") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("confidence"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Conf <span className={sortBy === "confidence" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "confidence" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {hideBtn("conf")}{handle("conf")}
                </th>
                <th data-col="reasoning" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Reasoning{hideBtn("reasoning")}{handle("reasoning")}</th>
                <th data-col="actions" className="group/th pr-7 px-3 py-2.5 text-left font-medium relative select-none">Actions{hideBtn("actions")}{handle("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((tx) =>
                tx.journal_entries.length === 0 ? (
                  <NoJeRow key={tx.id} tx={tx} />
                ) : (
                  tx.journal_entries.map((je, idx) => (
                    <JeRow
                      key={je.id}
                      je={je}
                      tx={tx}
                      accounts={accounts}
                      customers={customers}
                      isFirst={idx === 0}
                      txRowCount={tx.journal_entries.length}
                      clientId={clientId}
                      onUpdate={(updated) => handleJeUpdate(tx.id, updated)}
                      onDelete={handleDelete}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onSplit={handleSplit}
                      onMarkAsFixedAsset={(t, jeId) => setFixedAssetTarget({ tx: t, jeId })}
                      onMarkAsPrepaid={(t) => setPrepaidTarget(t)}
                    />
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
