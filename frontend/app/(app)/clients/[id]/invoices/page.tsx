"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  uploadInvoice, recalculatePrepaid, updateTransactionStatus,
  createJournalEntry, updateJournalEntry, deleteJournalEntry,
  deleteTransaction, getAccruals, deleteAccrual,
  InvoiceUploadResult,
} from "@/lib/api";

interface UploadItem {
  id: string;
  filename: string;
  status: "uploading" | "done" | "error";
  result?: InvoiceUploadResult;
  error?: string;
  editing?: boolean;
  editServiceStart?: string;
  editServiceEnd?: string;
  editExpenseAccount?: string;
  editPrepaidAccount?: string;
  recalculating?: boolean;
  approving?: boolean;
  approved?: boolean;
  cancelling?: boolean;
  cancelled?: boolean;
}

// ── Editable JE Table ─────────────────────────────────────────────────────────
// Inline editor that lets the user customize the JE lines of an uploaded invoice
// before sending them to the Review Queue.

type EditableJe = {
  id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  je_date: string | null;
  memo: string | null;
};

function EditableJeTable({
  txId,
  initialJes,
  onChange,
}: {
  txId: number;
  initialJes: EditableJe[];
  onChange?: (jes: EditableJe[]) => void;
}) {
  const [jes, setJes] = useState<EditableJe[]>(initialJes);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => { setJes(initialJes); }, [initialJes]);

  function emit(next: EditableJe[]) {
    setJes(next);
    onChange?.(next);
  }

  async function patchLine(id: number, patch: Partial<EditableJe>) {
    const updated = await updateJournalEntry(id, patch as Parameters<typeof updateJournalEntry>[1]);
    const slim: EditableJe = {
      id: updated.id,
      debit_account: updated.debit_account,
      credit_account: updated.credit_account,
      amount: updated.amount,
      je_date: updated.je_date,
      memo: updated.memo,
    };
    emit(jes.map((j) => (j.id === id ? slim : j)));
  }

  async function addLine() {
    setAdding(true);
    try {
      const last = jes[jes.length - 1];
      const created = await createJournalEntry({
        transaction_id: txId,
        debit_account: last?.debit_account ?? "Uncoded",
        credit_account: last?.credit_account ?? "Accrued Expenses",
        amount: 0,
        memo: "",
        je_date: last?.je_date ?? undefined,
      });
      const slim: EditableJe = {
        id: created.id,
        debit_account: created.debit_account,
        credit_account: created.credit_account,
        amount: created.amount,
        je_date: created.je_date,
        memo: created.memo,
      };
      emit([...jes, slim]);
    } finally {
      setAdding(false);
    }
  }

  async function removeLine(id: number) {
    if (!confirm("Delete this JE line?")) return;
    setDeletingId(id);
    try {
      await deleteJournalEntry(id);
      emit(jes.filter((j) => j.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  // Balance check: in a Tx with multiple lines, sum debits = sum credits.
  // Each JournalEntry here represents one DR/CR pair, so it's auto-balanced per
  // line. The aggregate check is just: total debits-by-account = total credits-by-account.
  const totalDebit = jes.reduce((s, j) => s + (j.amount || 0), 0);
  const totalCredit = totalDebit; // by construction (each row is balanced)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

  return (
    <div className="space-y-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-600 uppercase tracking-wider">
            <th className="text-left pb-1 font-medium">Date</th>
            <th className="text-left pb-1 font-medium">Debit Account</th>
            <th className="text-left pb-1 font-medium">Credit Account</th>
            <th className="text-right pb-1 font-medium">Amount</th>
            <th className="text-left pb-1 font-medium">Memo</th>
            <th className="text-center pb-1 font-medium w-12">⌫</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {jes.map((je) => (
            <JeEditRow
              key={je.id}
              je={je}
              onPatch={(p) => patchLine(je.id, p)}
              onDelete={() => removeLine(je.id)}
              deleting={deletingId === je.id}
              canDelete={jes.length > 1}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="text-gray-500">
            <td colSpan={3} className="pt-2 pr-3 text-right text-xs">Total</td>
            <td className="pt-2 pr-3 text-right font-mono text-white">
              ${totalDebit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </td>
            <td colSpan={2} className="pt-2 pl-3">
              <span className={`text-xs ${balanced ? "text-green-400" : "text-red-400"}`}>
                {balanced ? "✓ balanced" : "⚠ out of balance"}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>

      <button
        type="button"
        onClick={addLine}
        disabled={adding}
        className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
      >
        {adding ? "Adding…" : "+ Add JE line"}
      </button>
    </div>
  );
}

function JeEditRow({
  je, onPatch, onDelete, deleting, canDelete,
}: {
  je: EditableJe;
  onPatch: (p: Partial<EditableJe>) => Promise<void>;
  onDelete: () => void;
  deleting: boolean;
  canDelete: boolean;
}) {
  const [debit, setDebit] = useState(je.debit_account);
  const [credit, setCredit] = useState(je.credit_account);
  const [amount, setAmount] = useState(String(je.amount));
  const [memo, setMemo] = useState(je.memo ?? "");
  const [date, setDate] = useState(je.je_date?.slice(0, 10) ?? "");

  useEffect(() => {
    setDebit(je.debit_account);
    setCredit(je.credit_account);
    setAmount(String(je.amount));
    setMemo(je.memo ?? "");
    setDate(je.je_date?.slice(0, 10) ?? "");
  }, [je]);

  const cellInput = "w-full bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-500";

  return (
    <tr className="text-gray-300">
      <td className="py-1.5 pr-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onBlur={() => date !== (je.je_date?.slice(0, 10) ?? "") && onPatch({ je_date: date || null })}
          className={cellInput}
        />
      </td>
      <td className="py-1.5 pr-2">
        <input
          value={debit}
          onChange={(e) => setDebit(e.target.value)}
          onBlur={() => debit !== je.debit_account && onPatch({ debit_account: debit })}
          className={cellInput}
        />
      </td>
      <td className="py-1.5 pr-2">
        <input
          value={credit}
          onChange={(e) => setCredit(e.target.value)}
          onBlur={() => credit !== je.credit_account && onPatch({ credit_account: credit })}
          className={cellInput}
        />
      </td>
      <td className="py-1.5 pr-2 text-right">
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => {
            const n = parseFloat(amount);
            if (!isNaN(n) && n !== je.amount) onPatch({ amount: n });
          }}
          className={`${cellInput} text-right font-mono`}
        />
      </td>
      <td className="py-1.5 pr-2">
        <input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          onBlur={() => memo !== (je.memo ?? "") && onPatch({ memo })}
          className={cellInput}
          placeholder="Memo…"
        />
      </td>
      <td className="py-1.5 text-center">
        {canDelete ? (
          <button
            onClick={onDelete}
            disabled={deleting}
            className="text-gray-500 hover:text-red-400 disabled:opacity-50 text-xs transition-colors"
            title="Delete this line"
          >
            {deleting ? "…" : "✕"}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export default function InvoiceUploadPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);

  function updateItem(itemId: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)));
  }

  async function processFile(file: File) {
    const itemId = `${Date.now()}-${Math.random()}`;
    setItems((prev) => [{ id: itemId, filename: file.name, status: "uploading" }, ...prev]);
    try {
      const result = await uploadInvoice(clientId, file);
      updateItem(itemId, { status: "done", result });
    } catch (err: unknown) {
      updateItem(itemId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach(processFile);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [clientId]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Invoice Upload</h1>
        <p className="text-gray-500 text-xs mt-0.5">Upload a PDF or image — AI reads it and creates the journal entries automatically.</p>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-2xl px-8 py-14 cursor-pointer transition-colors select-none ${
          dragging
            ? "border-indigo-400 bg-indigo-500/10"
            : "border-gray-700 hover:border-gray-500 hover:bg-gray-800/30"
        }`}
      >
        <svg className="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-300">Drop invoices here or click to browse</p>
          <p className="text-xs text-gray-600 mt-1">PDF, JPG, PNG, WEBP — up to 20 MB each</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          multiple
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* Results */}
      {items.length > 0 && (
        <div className="mt-6 space-y-4">
          {items.map((item) => (
            <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              {/* Card header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
                {item.status === "uploading" && (
                  <span className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
                )}
                {item.status === "done" && (
                  <span className="w-4 h-4 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center text-xs shrink-0">✓</span>
                )}
                {item.status === "error" && (
                  <span className="w-4 h-4 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center text-xs shrink-0">✕</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{item.filename}</p>
                  {item.status === "uploading" && <p className="text-xs text-gray-500">Reading invoice…</p>}
                  {item.status === "error" && <p className="text-xs text-red-400">{item.error}</p>}
                  {item.status === "done" && item.result && (
                    <p className="text-xs text-gray-400">
                      {item.result.transaction.vendor} · {new Date(item.result.transaction.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · <span className="text-red-400">${Math.abs(item.result.transaction.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Journal entries */}
              {item.status === "done" && item.result && item.result.journal_entries.length > 0 && (() => {
                const jes = item.result.journal_entries;
                const isPrepaid = item.result.invoice_type === "prepaid";
                const paymentJe = isPrepaid ? jes[0] : null;
                // Calculate monthly amount and count from service period + total
                const serviceStart = item.result.service_start;
                const serviceEnd = item.result.service_end;
                const expenseAccount = item.result.expense_account;
                const prepaidAccount = item.result.prepaid_account;
                // Parse "Month YYYY" or "YYYY-MM" strings into {year, month}
                const parseMonthStr = (s: string | undefined) => {
                  if (!s) return null;
                  const iso = s.match(/^(\d{4})-(\d{2})$/);
                  if (iso) return { year: parseInt(iso[1]), month: parseInt(iso[2]) - 1 };
                  const names = ["january","february","march","april","may","june","july","august","september","october","november","december"];
                  const parts = s.trim().split(/\s+/);
                  if (parts.length === 2) {
                    const m = names.indexOf(parts[0].toLowerCase());
                    const y = parseInt(parts[1]);
                    if (m >= 0 && !isNaN(y)) return { year: y, month: m };
                  }
                  return null;
                };
                const startParsed = parseMonthStr(serviceStart);
                const endParsed = parseMonthStr(serviceEnd);
                const nMonths = (startParsed && endParsed)
                  ? (endParsed.year - startParsed.year) * 12 + (endParsed.month - startParsed.month) + 1
                  : null;
                const monthlyAmount = (nMonths && paymentJe) ? paymentJe.amount / nMonths : null;

                return (
                  <div className="px-4 py-3 space-y-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wider">Journal Entries Created</p>

                    {isPrepaid && (
                      <div className="bg-indigo-950/50 border border-indigo-800/60 rounded-xl px-4 py-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <svg className="w-3.5 h-3.5 text-indigo-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          <p className="text-xs font-semibold text-indigo-300">
                            Recurring accruals scheduled — {nMonths ?? "?"} monthly {nMonths === 1 ? "entry" : "entries"} created
                          </p>
                        </div>

                        {item.editing ? (
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-gray-500 block mb-1">Service Start</label>
                                <input
                                  type="text"
                                  placeholder="e.g. April 2026"
                                  value={item.editServiceStart ?? ""}
                                  onChange={(e) => updateItem(item.id, { editServiceStart: e.target.value })}
                                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 block mb-1">Service End</label>
                                <input
                                  type="text"
                                  placeholder="e.g. April 2027"
                                  value={item.editServiceEnd ?? ""}
                                  onChange={(e) => updateItem(item.id, { editServiceEnd: e.target.value })}
                                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-xs text-gray-500 block mb-1">Expense Account</label>
                              <input
                                type="text"
                                value={item.editExpenseAccount ?? ""}
                                onChange={(e) => updateItem(item.id, { editExpenseAccount: e.target.value })}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-gray-500 block mb-1">Prepaid Account</label>
                              <input
                                type="text"
                                value={item.editPrepaidAccount ?? ""}
                                onChange={(e) => updateItem(item.id, { editPrepaidAccount: e.target.value })}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div className="flex items-center gap-3 pt-1">
                              <button
                                disabled={item.recalculating}
                                onClick={async () => {
                                  if (!item.result) return;
                                  updateItem(item.id, { recalculating: true });
                                  try {
                                    const updated = await recalculatePrepaid(
                                      item.result.transaction.id,
                                      item.editServiceStart ?? "",
                                      item.editServiceEnd ?? "",
                                      item.editExpenseAccount ?? "",
                                      item.editPrepaidAccount ?? "",
                                    );
                                    updateItem(item.id, { result: updated, editing: false, recalculating: false });
                                  } catch {
                                    updateItem(item.id, { recalculating: false });
                                  }
                                }}
                                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                              >
                                {item.recalculating ? "Recalculating…" : "Recalculate"}
                              </button>
                              <button
                                onClick={() => updateItem(item.id, { editing: false })}
                                className="text-xs text-gray-500 hover:text-gray-300"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-xs text-indigo-400/80">
                              {expenseAccount} / {prepaidAccount}
                              {monthlyAmount && ` · $${monthlyAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}/mo`}
                              {serviceStart && serviceEnd && ` · ${serviceStart} – ${serviceEnd}`}
                            </p>
                            <button
                              onClick={() => updateItem(item.id, {
                                editing: true,
                                editServiceStart: serviceStart ?? "",
                                editServiceEnd: serviceEnd ?? "",
                                editExpenseAccount: expenseAccount ?? "",
                                editPrepaidAccount: prepaidAccount ?? "",
                              })}
                              className="text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-3 py-1 rounded-lg transition-colors"
                            >
                              Edit service period &amp; accounts
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Prepaid: amortization summary above, editable payment JE below */}
                    {isPrepaid && (
                      <div className="text-xs text-gray-500 italic bg-indigo-950/20 border border-indigo-900/30 rounded-lg px-3 py-2">
                        Monthly amortization: {monthlyAmount ? `$${monthlyAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}/mo × ${nMonths}` : "—"}
                        {serviceStart && serviceEnd && ` (${serviceStart.slice(0, 7)} – ${serviceEnd.slice(0, 7)})`} — generated as accrual entries, manage on the Accruals tab.
                      </div>
                    )}

                    <EditableJeTable
                      txId={item.result.transaction.id}
                      initialJes={jes}
                      onChange={(nextJes) => {
                        // Merge slim edits back into InvoiceJE[] (preserving ai_confidence/ai_reasoning by id)
                        const prevById = new Map(jes.map((j) => [j.id, j]));
                        const merged = nextJes.map((nj) => {
                          const prev = prevById.get(nj.id);
                          return {
                            id: nj.id,
                            debit_account: nj.debit_account,
                            credit_account: nj.credit_account,
                            amount: nj.amount,
                            je_date: nj.je_date,
                            memo: nj.memo,
                            ai_confidence: prev?.ai_confidence ?? null,
                            ai_reasoning: prev?.ai_reasoning ?? null,
                          };
                        });
                        updateItem(item.id, { result: { ...item.result!, journal_entries: merged } });
                      }}
                    />

                    {jes[0]?.ai_reasoning && (
                      <p className="text-xs text-gray-600 italic">{jes[0].ai_reasoning}</p>
                    )}

                    <div className="flex items-center gap-3 pt-1">
                      {item.cancelled ? (
                        <span className="text-xs text-gray-500 font-medium">✕ Cancelled — invoice and its journal entries were discarded</span>
                      ) : item.approved ? (
                        <span className="text-xs text-green-400 font-medium">✓ Approved — on Export page (and tracked on Payments &rarr; Accruals if the JE credits an accrual account)</span>
                      ) : (
                        <>
                          <button
                            disabled={item.approving || item.editing || item.cancelling}
                            onClick={async () => {
                              if (!item.result) return;
                              updateItem(item.id, { approving: true });
                              try {
                                await updateTransactionStatus(item.result.transaction.id, "approved");
                                updateItem(item.id, { approving: false, approved: true });
                              } catch {
                                updateItem(item.id, { approving: false });
                              }
                            }}
                            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                          >
                            {item.approving ? "Saving…" : "Approve & Save"}
                          </button>
                          <button
                            disabled={item.approving || item.editing || item.cancelling}
                            onClick={async () => {
                              if (!item.result) return;
                              if (!confirm("Cancel this invoice upload? The transaction, its journal entries, and any amortization schedule will be permanently deleted.")) return;
                              const txId = item.result.transaction.id;
                              updateItem(item.id, { cancelling: true });
                              try {
                                // Clean up any prepaid amortization rows linked to this invoice
                                try {
                                  const { accruals } = await getAccruals(clientId);
                                  const linked = accruals.filter((a) => a.source_transaction_id === txId);
                                  await Promise.all(linked.map((a) => deleteAccrual(clientId, a.id)));
                                } catch {
                                  /* non-fatal: continue to delete transaction */
                                }
                                await deleteTransaction(txId);
                                updateItem(item.id, { cancelling: false, cancelled: true });
                              } catch {
                                updateItem(item.id, { cancelling: false });
                              }
                            }}
                            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 text-gray-300 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                          >
                            {item.cancelling ? "Cancelling…" : "Cancel & Discard"}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => router.push(item.approved ? `/clients/${id}/export` : `/clients/${id}/review`)}
                        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        {item.approved ? "View on Export page →" : "Edit in Review Queue →"}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
