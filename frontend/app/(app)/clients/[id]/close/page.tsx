"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CloseChecklistItem,
  getCloseChecklist,
  completeChecklistItem,
  uncompleteChecklistItem,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
} from "@/lib/api";

// ── Due date helpers ───────────────────────────────────────────────────────────

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
  switch (due_rule) {
    case "2nd_biz_day": return getNthBusinessDay(workingYear, m0, 2);
    case "day_5": return new Date(workingYear, m0, 5);
    case "last_biz_day": return getLastBusinessDay(workingYear, m0);
    case "day_1_next_month": {
      const nm = workingMonth === 12 ? 1 : workingMonth + 1;
      const ny = workingMonth === 12 ? workingYear + 1 : workingYear;
      return new Date(ny, nm - 1, 1);
    }
    default: return new Date(workingYear, m0, 5);
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getCloseMonthStr(now: Date): string {
  const prev = now.getMonth() === 0 ? 12 : now.getMonth();
  const yr = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return `${yr}-${String(prev).padStart(2, "0")}`;
}

function formatMonthLabel(closeMonthStr: string): string {
  const [y, m] = closeMonthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ── Form ──────────────────────────────────────────────────────────────────────

type FormState = { title: string; description: string; due_rule: string; milestone: string };
const EMPTY_FORM: FormState = { title: "", description: "", due_rule: "day_5", milestone: "" };

function ItemForm({ form, setForm, onSave, onCancel, saving }: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            placeholder="Task title *"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            autoFocus
          />
        </div>
        <div className="col-span-2">
          <textarea
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
            placeholder="Description (optional)"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <div>
          <select
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            value={form.due_rule}
            onChange={(e) => setForm((f) => ({ ...f, due_rule: e.target.value }))}
          >
            <option value="2nd_biz_day">2nd business day of month</option>
            <option value="day_5">5th of month</option>
            <option value="last_biz_day">Last business day of month</option>
            <option value="day_1_next_month">1st of following month</option>
          </select>
        </div>
        <div>
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            placeholder="Milestone label (optional)"
            value={form.milestone}
            onChange={(e) => setForm((f) => ({ ...f, milestone: e.target.value }))}
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving || !form.title.trim()}
          className="px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MonthlyClosePage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const now = new Date();
  const closeMonthStr = getCloseMonthStr(now);
  const workingYear = now.getFullYear();
  const workingMonth = now.getMonth() + 1;

  const [items, setItems] = useState<CloseChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [justCheckedId, setJustCheckedId] = useState<number | null>(null);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    getCloseChecklist(clientId, closeMonthStr)
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clientId, closeMonthStr]);

  const completedCount = items.filter((i) => i.completed_at !== null).length;
  const totalCount = items.length;
  const softCloseDone = items.find((i) => i.milestone === "Soft Close completed")?.completed_at != null;
  const financialsClosedDone = items.find((i) => i.milestone === "Financials Closed")?.completed_at != null;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  async function handleToggle(item: CloseChecklistItem) {
    const completing = !item.completed_at;
    setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, completed_at: completing ? new Date().toISOString() : null } : i));
    if (completing) { setJustCheckedId(item.id); setTimeout(() => setJustCheckedId(null), 700); }
    try {
      if (item.completed_at) {
        await uncompleteChecklistItem(clientId, item.id, closeMonthStr);
        setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, completed_at: null } : i));
      } else {
        const updated = await completeChecklistItem(clientId, item.id, closeMonthStr);
        setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, completed_at: updated.completed_at } : i));
      }
    } catch { setItems(items); }
  }

  function startEdit(item: CloseChecklistItem) {
    setEditingId(item.id);
    setAddingNew(false);
    setForm({ title: item.title, description: item.description ?? "", due_rule: item.due_rule, milestone: item.milestone ?? "" });
  }

  function cancelForm() { setEditingId(null); setAddingNew(false); setForm(EMPTY_FORM); }

  async function handleSaveEdit(item: CloseChecklistItem) {
    setSaving(true);
    try {
      const updated = await updateChecklistItem(clientId, item.id, {
        title: form.title, description: form.description || undefined,
        due_rule: form.due_rule, milestone: form.milestone || undefined,
      });
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, ...updated } : i));
      cancelForm();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete(item: CloseChecklistItem) {
    if (!confirm(`Delete "${item.title}"?`)) return;
    try {
      await deleteChecklistItem(clientId, item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) { setError(e.message); }
  }

  async function handleAddSave() {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const maxOrder = items.reduce((m, i) => Math.max(m, i.order_index), 0);
      await createChecklistItem(clientId, {
        title: form.title, description: form.description || undefined,
        due_rule: form.due_rule, order_index: maxOrder + 1, milestone: form.milestone || undefined,
      });
      const fresh = await getCloseChecklist(clientId, closeMonthStr);
      setItems(fresh);
      cancelForm();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="w-7 h-7 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="max-w-2xl space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{formatMonthLabel(closeMonthStr)} Close</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Working month: {new Date(workingYear, workingMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
        </div>
        <button
          onClick={() => { setAddingNew(true); setEditingId(null); setForm(EMPTY_FORM); }}
          className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add to-do
        </button>
      </div>

      {error && <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-2 text-sm text-red-300">{error}</div>}

      {/* Status bar */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 flex items-center gap-3">
        <span className="text-sm text-gray-300 font-medium whitespace-nowrap">{completedCount} of {totalCount} completed</span>
        <div className="flex-1 bg-gray-700 rounded-full h-1.5">
          <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
            style={{ width: totalCount > 0 ? `${(completedCount / totalCount) * 100}%` : "0%" }} />
        </div>
        {softCloseDone && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-900/60 text-emerald-300 border border-emerald-700 whitespace-nowrap">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
            Soft Close completed
          </span>
        )}
        {financialsClosedDone && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-900/60 text-indigo-300 border border-indigo-700 whitespace-nowrap">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
            Financials Closed
          </span>
        )}
      </div>

      {/* Add form — only shown when active */}
      {addingNew && (
        <div className="bg-gray-800 border border-indigo-500 rounded-xl p-4">
          <p className="text-sm font-semibold text-white mb-3">New to-do item</p>
          <ItemForm form={form} setForm={setForm} onSave={handleAddSave} onCancel={cancelForm} saving={saving} />
        </div>
      )}

      {/* Checklist — Todoist style: plain rows, thin dividers, no card */}
      <div>
        {items.map((item) => {
          const dueDate = calcDueDate(item.due_rule, workingYear, workingMonth);
          const isOverdue = !item.completed_at && dueDate < today;
          const isCompleted = item.completed_at !== null;
          const justChecked = justCheckedId === item.id;
          const isEditing = editingId === item.id;

          return (
            <div
              key={item.id}
              className={`border-b border-gray-800 transition-colors duration-300 ${justChecked ? "bg-emerald-900/10" : "hover:bg-gray-800/30"}`}
              onMouseEnter={() => setHoveredId(item.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {isEditing ? (
                <div className="py-3">
                  <ItemForm form={form} setForm={setForm} onSave={() => handleSaveEdit(item)} onCancel={cancelForm} saving={saving} />
                </div>
              ) : (
                <div className="flex items-start gap-3 py-3">
                  {/* Circle checkbox */}
                  <button
                    onClick={() => handleToggle(item)}
                    className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                      justChecked ? "bg-emerald-500 border-emerald-500 scale-110"
                      : isCompleted ? "bg-indigo-600 border-indigo-600"
                      : "border-gray-600 hover:border-indigo-400"
                    }`}
                  >
                    {isCompleted && (
                      <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className={`text-sm ${isCompleted ? "line-through text-gray-500" : "text-white"}`}>
                        {item.title}
                      </span>
                      {item.milestone && isCompleted && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/50 text-emerald-400 border border-emerald-800">
                          {item.milestone}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
                    )}
                  </div>

                  {/* Due date — right aligned */}
                  <span className={`text-xs shrink-0 tabular-nums ${isOverdue ? "text-red-400 font-medium" : isCompleted ? "text-gray-500" : "text-white"}`}>
                    {formatDate(dueDate)}
                  </span>

                  {/* Hover actions */}
                  <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${hoveredId === item.id ? "opacity-100" : "opacity-0"}`}>
                    <button onClick={() => startEdit(item)} className="p-1 rounded text-gray-600 hover:text-gray-300 transition-colors" title="Edit">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a4 4 0 01-1.414.929l-3.414 1.172 1.172-3.414A4 4 0 019 13z" />
                      </svg>
                    </button>
                    <button onClick={() => handleDelete(item)} className="p-1 rounded text-gray-600 hover:text-red-400 transition-colors" title="Delete">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 011-1h4a1 1 0 011 1m-7 0H5m14 0h-2" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
