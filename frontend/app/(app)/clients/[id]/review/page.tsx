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
  TransactionWithEntries,
  JournalEntry,
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
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [inputValue, value, onChange]);

  const filtered = inputValue
    ? accounts.filter((a) => a.toLowerCase().includes(inputValue.toLowerCase()))
    : accounts;

  // Reset active index when suggestions change
  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputValue(e.target.value);
    setOpen(true);
    setActiveIdx(0);
  }

  function commit(val: string) {
    setInputValue(val);
    onChange(val);
    setOpen(false);
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
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Small delay so click on dropdown item fires first
          setTimeout(() => {
            if (ref.current && !ref.current.contains(document.activeElement)) {
              if (inputValue !== value) onChange(inputValue);
              setOpen(false);
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
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(loadColWidths);

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

  const coded = items.filter((t) => t.journal_entries.length > 0);
  const uncoded = items.filter((t) => t.journal_entries.length === 0);

  // Resize handle rendered inside each <th>
  const handle = (col: ColKey) => (
    <div
      onMouseDown={(e) => startResize(col, e)}
      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-indigo-500/40 active:bg-indigo-500/70 select-none"
    />
  );

  return (
    <div className="w-full">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Review Queue</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {items.length} pending
            {uncoded.length > 0 && ` · ${uncoded.length} need coding`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleRunCoding}
            disabled={coding || loading}
            className="flex items-center gap-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
          >
            {coding ? (
              <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Coding…</>
            ) : "✦ Run AI Coding"}
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

      {codingError && (
        <div className="mb-3 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-2.5 text-xs">
          {codingError}
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
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">Amount{handle("amount")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Category{handle("category")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Debit Account{handle("debit")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Credit Account{handle("credit")}</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap relative select-none">JE Amt{handle("jeAmt")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Memo{handle("memo")}</th>
                <th className="px-3 py-2.5 text-center font-medium relative select-none">Conf{handle("conf")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Reasoning{handle("reasoning")}</th>
                <th className="px-3 py-2.5 text-left font-medium relative select-none">Actions{handle("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tx) =>
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
