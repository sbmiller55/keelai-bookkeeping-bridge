"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  getTransactionsWithEntries,
  getChartOfAccounts,
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
  TransactionWithEntries,
  JournalEntry,
  DateRangeOption,
  FixedAssetSuggestion,
} from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

// ── Column widths (resizable, persisted) ──────────────────────────────────────

const DEFAULT_COL_WIDTHS = {
  date: 120, description: 180, amount: 110, category: 110,
  debit: 200, credit: 200, jeAmt: 150, memo: 180,
  conf: 70, reasoning: 160, actions: 110,
};
type ColKey = keyof typeof DEFAULT_COL_WIDTHS;
const COL_WIDTHS_KEY = "bb-review-col-widths";

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

// ── Account dropdown ──────────────────────────────────────────────────────────

function AccountSelect({
  value,
  onChange,
  accounts,
  placeholder = "Select account…",
}: {
  value: string;
  onChange: (v: string) => void;
  accounts: string[];
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep input in sync when value changes externally
  useEffect(() => { setInputValue(value); }, [value]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Commit whatever is typed if it's a valid account or non-empty
        if (inputValue !== value) {
          onChange(inputValue);
        }
        setOpen(false);
        setIsTyping(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [inputValue, value, onChange]);

  // Show all accounts when just opened; filter only once user starts typing
  const filtered = (isTyping && inputValue)
    ? accounts.filter((a) => a.toLowerCase().includes(inputValue.toLowerCase()))
    : accounts;

  // Reset active index when suggestions change
  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputValue(e.target.value);
    setIsTyping(true);
    setOpen(true);
    setActiveIdx(0);
  }

  function commit(val: string) {
    setInputValue(val);
    onChange(val);
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
      if (filtered[activeIdx]) commit(filtered[activeIdx]);
      else if (inputValue) commit(inputValue);
    } else if (e.key === "Escape") {
      setInputValue(value);
      setOpen(false);
      setIsTyping(false);
    }
  }

  // Scroll active item into view
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
        onChange={handleInputChange}
        onFocus={(e) => { setOpen(true); setIsTyping(false); e.target.select(); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Small delay so click on dropdown item fires first
          setTimeout(() => {
            if (ref.current && !ref.current.contains(document.activeElement)) {
              if (inputValue !== value) onChange(inputValue);
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
            {filtered.map((a, i) => (
              <button
                key={a}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); commit(a); }}
                className={`w-full text-left px-3 py-1.5 text-xs ${i === activeIdx ? "bg-indigo-600 text-white" : a === value ? "text-indigo-400 bg-gray-800/50" : "text-gray-200 hover:bg-gray-800"}`}
              >
                {a}
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

const FA_CATEGORIES = ["Equipment", "Furniture", "Leasehold Improvements", "Vehicles", "Other"];
const FA_DEP_METHODS = [
  { value: "straight_line", label: "Straight-Line" },
  { value: "double_declining", label: "Double-Declining Balance" },
];

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
        salvage_value: parseFloat(salvageValue) || 0,
        useful_life_months: parseInt(usefulLife),
        depreciation_method: method,
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

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Asset Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Category</label>
                <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
                  {FA_CATEGORIES.map(c => <option key={c}>{c}</option>)}
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
              <div>
                <label className="block text-xs text-gray-500 mb-1">Salvage Value ($)</label>
                <input type="number" step="0.01" value={salvageValue} onChange={e => setSalvageValue(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Useful Life (months)</label>
                <input type="number" min="1" value={usefulLife} onChange={e => setUsefulLife(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Depreciation Method</label>
                <select value={method} onChange={e => setMethod(e.target.value)} className={inputCls}>
                  {FA_DEP_METHODS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-3 pt-1 border-t border-gray-800">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">QBO Accounts</p>
              {[
                { label: "Asset Account", value: assetAcct, set: setAssetAcct },
                { label: "Accumulated Depreciation Account", value: accumAcct, set: setAccumAcct },
                { label: "Depreciation Expense Account", value: expAcct, set: setExpAcct },
              ].map(({ label, value, set }) => (
                <div key={label}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    list={`fa-accts-${label}`}
                    className={inputCls}
                    placeholder="Type to search COA…"
                  />
                  <datalist id={`fa-accts-${label}`}>
                    {accounts.map(a => <option key={a} value={a} />)}
                  </datalist>
                </div>
              ))}
            </div>

            <p className="text-xs text-gray-500 bg-gray-800 rounded-lg px-3 py-2">
              This will recode the transaction JE to debit the asset account, approve the transaction, and generate all historical depreciation journal entries for review.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleConfirm}
                disabled={saving || !name || !usefulLife}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                {saving ? "Creating Asset…" : "Confirm — Create Fixed Asset"}
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
  isFirst,
  txRowCount,
  clientId,
  onUpdate,
  onDelete,
  onApprove,
  onReject,
  onSplit,
  onMarkAsFixedAsset,
}: {
  je: JournalEntry;
  tx: TransactionWithEntries;
  accounts: string[];
  isFirst: boolean;
  txRowCount: number;
  clientId: number;
  onUpdate: (je: JournalEntry) => void;
  onDelete: (jeId: number) => void;
  onApprove: (txId: number) => Promise<void>;
  onReject: (txId: number) => Promise<void>;
  onSplit: (txId: number) => Promise<void>;
  onMarkAsFixedAsset: (tx: TransactionWithEntries, jeId: number) => void;
}) {
  const [debit, setDebit] = useState(je.debit_account);
  const [credit, setCredit] = useState(je.credit_account);
  const [amount, setAmount] = useState(String(je.amount));
  const [memo, setMemo] = useState(je.memo ?? "");
  const [jeDate, setJeDate] = useState(je.je_date?.slice(0, 10) ?? tx.date?.slice(0, 10) ?? "");
  const [amountFocused, setAmountFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | "split" | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleSaved, setRuleSaved] = useState(false);
  const [ruleAppliedCount, setRuleAppliedCount] = useState(0);

  const latestRef = useRef({ debit: je.debit_account, credit: je.credit_account, amount: String(je.amount), memo: je.memo ?? "" });

  useEffect(() => {
    setDebit(je.debit_account);
    setCredit(je.credit_account);
    setAmount(String(je.amount));
    setMemo(je.memo ?? "");
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

  function showRulePrompt(newDebit: string, newCredit: string) {
    const matchValue = tx.counterparty_name || tx.description;
    const matchType = tx.counterparty_name ? "counterparty_contains" : "description_contains";
    setRulePrompt({ matchType, matchValue, debit: newDebit, credit: newCredit });
  }

  function handleDebitChange(v: string) {
    const oldDebit = latestRef.current.debit;
    latestRef.current = { ...latestRef.current, debit: v };
    setDebit(v);
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
  const cellBase = "px-3 py-2 text-xs align-middle";
  const inputCls = "w-full bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-500 font-mono";

  return (
    <>
    <tr className={`border-b border-gray-800 ${isFirst ? "border-t border-t-gray-700" : ""} hover:bg-gray-800/20 transition-colors`}>
      {/* Date — per JE row */}
      <td className={`${cellBase} whitespace-nowrap`}>
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
        <td className={`${cellBase}`} rowSpan={txRowCount}>
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
        <td className={`${cellBase} text-right whitespace-nowrap font-mono`} rowSpan={txRowCount}>
          <span className={tx.amount < 0 ? "text-red-400" : "text-green-400"}>
            {tx.amount < 0 ? "-" : "+"}${Math.abs(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        </td>
      ) : null}

      {/* Category — only on first row */}
      {isFirst ? (
        <td className={`${cellBase} whitespace-nowrap`} rowSpan={txRowCount}>
          {formatCategory(tx.mercury_category) ? (
            <span className="text-gray-400 text-xs truncate block">{formatCategory(tx.mercury_category)}</span>
          ) : null}
        </td>
      ) : null}

      {/* Debit account */}
      <td className={`${cellBase}`}>
        <AccountSelect value={debit} onChange={handleDebitChange} accounts={accounts} />
      </td>

      {/* Credit account */}
      <td className={`${cellBase}`}>
        <AccountSelect value={credit} onChange={handleCreditChange} accounts={accounts} />
      </td>

      {/* JE Amount */}
      <td className={`${cellBase} text-right whitespace-nowrap`}>
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
      <td className={`${cellBase}`}>
        <input
          value={memo}
          onChange={(e) => handleMemoChange(e.target.value)}
          onBlur={saveOnBlur}
          placeholder="Memo…"
          className={`${inputCls} font-sans`}
        />
      </td>

      {/* Confidence */}
      <td className={`${cellBase} text-center`}>
        {saving ? (
          <span className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin inline-block" />
        ) : (
          <ConfBadge score={je.ai_confidence} reasoning={je.ai_reasoning} />
        )}
        {je.rule_applied && <span className="block text-blue-400 text-xs">rule</span>}
      </td>

      {/* AI Reasoning */}
      <td className={`${cellBase}`}>
        {je.ai_reasoning ? (
          <span className="text-gray-600 text-xs line-clamp-2 cursor-help" title={je.ai_reasoning}>
            {je.ai_reasoning}
          </span>
        ) : (
          <span className="text-gray-700 text-xs">—</span>
        )}
      </td>

      {/* Actions */}
      <td className={`${cellBase} whitespace-nowrap`}>
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
            </>
          )}
        </div>
      </td>
    </tr>

    {rulePrompt && (
      <tr className="bg-amber-950/30 border-b border-amber-900/20">
        <td colSpan={11} className="px-4 py-2">
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
        <td colSpan={11} className="px-4 py-1.5">
          <span className="text-green-400 text-xs">
            ✓ Rule saved
            {ruleAppliedCount > 0 ? ` — applied to ${ruleAppliedCount} additional pending transaction${ruleAppliedCount !== 1 ? "s" : ""}` : " — future transactions from this vendor will be coded automatically"}
          </span>
        </td>
      </tr>
    )}
    </>
  );
}

// ── No-JE Row ─────────────────────────────────────────────────────────────────

function NoJeRow({ tx }: { tx: TransactionWithEntries }) {
  const cellBase = "px-3 py-2 text-xs align-middle";
  return (
    <tr className="border-t border-gray-700 border-b border-gray-800 bg-red-950/10">
      <td className={`${cellBase} text-gray-400 whitespace-nowrap`}>
        {tx.date ? new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
      </td>
      <td className={`${cellBase}`}>
        <div className="truncate text-white font-medium">{tx.description}</div>
        {tx.counterparty_name && <div className="truncate text-gray-500 text-xs">{tx.counterparty_name}</div>}
      </td>
      <td className={`${cellBase} text-right whitespace-nowrap font-mono`}>
        <span className={tx.amount < 0 ? "text-red-400" : "text-green-400"}>
          {tx.amount < 0 ? "-" : "+"}${Math.abs(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </span>
      </td>
      <td colSpan={8} className={cellBase}>
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
  const [accounts, setAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [coding, setCoding] = useState(false);
  const [codingError, setCodingError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeOption>("since_last_sync");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [sortBy, setSortBy] = useState<"standard" | "amount" | "confidence" | "debit" | "credit">("standard");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(loadColWidths);
  const [fixedAssetTarget, setFixedAssetTarget] = useState<{ tx: TransactionWithEntries; jeId: number } | null>(null);

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
    getTransactionsWithEntries(clientId, "pending")
      .then(setItems)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    reload();
    getChartOfAccounts(clientId).then(setAccounts).catch(console.error);
  }, [clientId, reload]);

  useEffect(() => {
    window.addEventListener("bb-data-changed", reload);
    return () => window.removeEventListener("bb-data-changed", reload);
  }, [reload]);

  async function handleRunCoding() {
    setCoding(true);
    setCodingError(null);
    try {
      const result = await codePending(clientId);
      if (result.je_created === 0) {
        setCodingError(result.message || "AI coding ran but created 0 journal entries.");
      }
      reload();
    } catch (err: unknown) {
      setCodingError(err instanceof Error ? err.message : "Coding failed");
    } finally {
      setCoding(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      await syncMercury(
        clientId, dateRange,
        dateRange === "custom" ? customStart : undefined,
        dateRange === "custom" ? customEnd : undefined,
      );
      reload();
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleApprove(txId: number) {
    await updateTransactionStatus(txId, "approved");
    setItems((prev) => prev.filter((t) => t.id !== txId));
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
    const approvable = items.filter((t) => t.journal_entries.length > 0);
    setApprovingAll(true);
    try {
      await Promise.all(approvable.map((tx) => updateTransactionStatus(tx.id, "approved")));
      const ids = new Set(approvable.map((t) => t.id));
      setItems((prev) => prev.filter((t) => !ids.has(t.id)));
    } finally {
      setApprovingAll(false);
    }
  }

  const sortedItems = [...items].sort((a, b) => {
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
  const uncoded = sortedItems.filter((t) => t.journal_entries.length === 0);

  // Resize handle rendered inside each <th>
  const handle = (col: ColKey) => (
    <div
      onMouseDown={(e) => startResize(col, e)}
      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-indigo-500/40 active:bg-indigo-500/70 select-none"
    />
  );

  return (
    <div className="w-full">
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

      {/* Header */}
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="mr-2">
          <h1 className="text-xl font-bold text-white">Review Queue</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {items.length} pending
            {uncoded.length > 0 && ` · ${uncoded.length} need coding`}
          </p>
        </div>

        {/* Date range + Sync & Code — grouped together */}
        <div className="flex items-center gap-1.5">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeOption)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500"
          >
            <option value="since_last_sync">Since last sync</option>
            <option value="last_30">Last 30 days</option>
            <option value="last_90">Last 90 days</option>
            <option value="last_180">Last 6 months</option>
            <option value="last_365">Last 12 months</option>
            <option value="custom">Custom…</option>
          </select>
          {dateRange === "custom" && (
            <>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
              <span className="text-gray-600 text-xs">→</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
            </>
          )}
          <button
            onClick={handleSync}
            disabled={syncing || coding || loading || (dateRange === "custom" && (!customStart || !customEnd))}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
          >
            {syncing ? (
              <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Syncing…</>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync &amp; Code
              </>
            )}
          </button>
        </div>

        {/* Secondary actions */}
        <div className="flex gap-2 items-center ml-auto">
          <button
            onClick={handleRunCoding}
            disabled={coding || loading}
            className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 text-gray-400 hover:text-gray-200 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
          >
            {coding ? (
              <><span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />Coding…</>
            ) : "✦ AI Code"}
          </button>
          {coded.length > 0 && (
            <button
              onClick={approveAll}
              disabled={approvingAll}
              className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
            >
              {approvingAll ? "Approving…" : `Approve All (${coded.length})`}
            </button>
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
          <table className="border-collapse text-sm table-fixed" style={{ width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
            <colgroup>
              <col style={{ width: colWidths.date }} />
              <col style={{ width: colWidths.description }} />
              <col style={{ width: colWidths.amount }} />
              <col style={{ width: colWidths.category }} />
              <col style={{ width: colWidths.debit }} />
              <col style={{ width: colWidths.credit }} />
              <col style={{ width: colWidths.jeAmt }} />
              <col style={{ width: colWidths.memo }} />
              <col style={{ width: colWidths.conf }} />
              <col style={{ width: colWidths.reasoning }} />
              <col style={{ width: colWidths.actions }} />
            </colgroup>
            <thead>
              <tr className="bg-gray-900 text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap relative select-none">Date{handle("date")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Description{handle("description")}</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">
                  <button onClick={() => { if (sortBy === "amount") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("amount"); setSortDir("desc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Amount <span className={sortBy === "amount" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "amount" && sortDir === "asc" ? "↑" : "↓"}</span>
                  </button>
                  {handle("amount")}
                </th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Category{handle("category")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "debit") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("debit"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Debit Account <span className={sortBy === "debit" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "debit" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {handle("debit")}
                </th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "credit") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("credit"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Credit Account <span className={sortBy === "credit" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "credit" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {handle("credit")}
                </th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">JE Amt{handle("jeAmt")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Memo{handle("memo")}</th>
                <th className="px-3 py-2.5 text-center font-medium relative select-none">
                  <button onClick={() => { if (sortBy === "confidence") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy("confidence"); setSortDir("asc"); } }} className="inline-flex items-center gap-1 hover:text-white transition-colors">
                    Conf <span className={sortBy === "confidence" ? "text-indigo-400" : "text-gray-700"}>{sortBy === "confidence" && sortDir === "desc" ? "↓" : "↑"}</span>
                  </button>
                  {handle("conf")}
                </th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Reasoning{handle("reasoning")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Actions{handle("actions")}</th>
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
                      isFirst={idx === 0}
                      txRowCount={tx.journal_entries.length}
                      clientId={clientId}
                      onUpdate={(updated) => handleJeUpdate(tx.id, updated)}
                      onDelete={handleDelete}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onSplit={handleSplit}
                      onMarkAsFixedAsset={(t, jeId) => setFixedAssetTarget({ tx: t, jeId })}
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
