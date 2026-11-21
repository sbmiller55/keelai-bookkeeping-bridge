// Sorting, grouping and prepaid-schedule arithmetic for the Invoices tab.
// Kept apart from the page so the rules can be checked without rendering it.

import type { InvoiceListRow } from "@/lib/api";

export type Category = "unpaid" | "prepaid" | "completed";
export const CATEGORY_ORDER: Category[] = ["unpaid", "prepaid", "completed"];
export const CATEGORY_LABEL: Record<Category, string> = {
  unpaid: "Unpaid", prepaid: "Prepaid", completed: "Completed",
};

export type SortCol =
  | "date" | "vendor" | "invoice" | "description" | "amount"
  | "period" | "type" | "status" | "source";
export type SortDir = "asc" | "desc";
export interface SortKey { col: SortCol; dir: SortDir }

export const SORT_COL_LABEL: Record<SortCol, string> = {
  date: "Date", vendor: "Vendor", invoice: "Invoice #", description: "Description",
  amount: "Amount", period: "Service period", type: "Type", status: "Status", source: "Source",
};

// Status ascending is the only sort that shows category headers.
export const DEFAULT_SORT: SortKey[] = [{ col: "status", dir: "asc" }];
export const MAX_SECONDARY_SORTS = 2;

const TYPE_LABEL: Record<string, string> = {
  one_time: "One-time", accrual: "Accrual", prepaid: "Prepaid", fixed_asset: "Fixed Asset",
};

// An invoice is Completed once nothing is left to do on it: an accrued bill
// once it is paid, a prepaid once its last month has been expensed. Until then
// a prepaid stays in its own category whatever its bill status — it was paid
// up front and what matters is how much is still to be expensed. Partially
// paid bills are still owed money, so they sit with Unpaid.
export function categoryOf(r: InvoiceListRow, today: Date = new Date()): Category {
  if (r.invoice_type === "prepaid") {
    const last = monthIndex(r.service_period_end ?? r.service_period_start);
    const priorMonth = today.getFullYear() * 12 + today.getMonth() - 1;
    return last !== null && last <= priorMonth ? "completed" : "prepaid";
  }
  return r.bill_status === "paid" ? "completed" : "unpaid";
}

// ── Dates ────────────────────────────────────────────────────────────────────

// Read "YYYY-MM-DD…" as a local calendar date. new Date("2026-03-19") is UTC
// midnight, which in Denver is the evening of the 18th.
export function parseDay(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(s: string | null | undefined): string {
  const d = parseDay(s);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export function daysOpen(r: InvoiceListRow, today: Date): number | null {
  const d = parseDay(r.date);
  if (!d) return null;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t.getTime() - d.getTime()) / 86_400_000);
}

// Months counted as year*12 + month index, so ranges are plain subtraction.
function monthIndex(s: string | null | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}/.test(s)) return null;
  const [y, m] = s.slice(0, 7).split("-").map(Number);
  return y * 12 + (m - 1);
}

export function monthLabel(idx: number): string {
  return new Date(Math.floor(idx / 12), idx % 12, 1)
    .toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function monthSlash(idx: number): string {
  return `${String((idx % 12) + 1).padStart(2, "0")}/${Math.floor(idx / 12)}`;
}

export function formatMoney(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Prepaid schedule ─────────────────────────────────────────────────────────

export interface PrepaidSchedule {
  months: number;
  firstMonth: number;
  lastMonth: number;
  monthly: number;
  finalAmount: number;          // takes the rounding difference
  posted: number;               // entries assumed posted, through last month
  accrued: number;
  left: number;
  next: { month: number; amount: number } | null;
}

// Worked in cents so the final entry absorbs exactly the rounding difference.
// Entries are assumed posted through the month before `today`: this page does
// not read the ledger, so it cannot know which actually were.
export function prepaidSchedule(r: InvoiceListRow, today: Date): PrepaidSchedule | null {
  const first = monthIndex(r.service_period_start);
  const last = monthIndex(r.service_period_end ?? r.service_period_start);
  if (first === null || last === null || last < first) return null;
  const months = last - first + 1;
  const totalC = Math.round(r.amount * 100);
  const monthlyC = Math.round(totalC / months);
  const finalC = totalC - monthlyC * (months - 1);
  const priorMonth = today.getFullYear() * 12 + today.getMonth() - 1;
  const posted = Math.min(months, Math.max(0, priorMonth - first + 1));
  const accruedC = posted === months ? totalC : monthlyC * posted;
  return {
    months, firstMonth: first, lastMonth: last,
    monthly: monthlyC / 100,
    finalAmount: finalC / 100,
    posted,
    accrued: accruedC / 100,
    left: (totalC - accruedC) / 100,
    next: posted < months
      ? { month: first + posted, amount: (posted === months - 1 ? finalC : monthlyC) / 100 }
      : null,
  };
}

// ── Paid invoice record ──────────────────────────────────────────────────────

// No service period means a one-time bill: accrued in full in one month and
// paid the next. That is expected, not a gap — only a missing invoice number
// needs a look.
export function isOneTimeBill(r: InvoiceListRow): boolean {
  return !r.service_period_start;
}

export function missingRecord(r: InvoiceListRow): string[] {
  return r.invoice_number?.trim() ? [] : ["invoice no."];
}

export function recordNote(r: InvoiceListRow): { ok: boolean; text: string } {
  const oneTime = isOneTimeBill(r);
  if (missingRecord(r).length > 0) return { ok: false, text: oneTime ? "One-time bill · missing invoice no." : "Missing invoice no." };
  return { ok: true, text: oneTime ? "One-time bill · invoice no. on file" : "Invoice no. and period on file" };
}

// ── Sorting ──────────────────────────────────────────────────────────────────

type SortValue = string | number | null;

function sortValue(r: InvoiceListRow, col: SortCol): SortValue {
  switch (col) {
    case "date": return r.date ? r.date.slice(0, 10) : null;
    case "vendor": return r.vendor?.trim() || null;
    case "invoice": return r.invoice_number?.trim() || null;
    case "description": return r.description?.trim() || null;
    case "amount": return r.amount;
    case "period":
      return r.service_period_start
        ? `${r.service_period_start.slice(0, 7)}|${(r.service_period_end ?? r.service_period_start).slice(0, 7)}`
        : null;
    case "type": return TYPE_LABEL[r.invoice_type] ?? r.invoice_type;
    case "status": return CATEGORY_ORDER.indexOf(categoryOf(r));
    case "source": return r.source || null;
  }
}

// Blanks sort last in both directions: flipping to descending should not
// bring a page of empty invoice numbers to the top.
function compareBy(a: InvoiceListRow, b: InvoiceListRow, key: SortKey): number {
  const va = sortValue(a, key.col);
  const vb = sortValue(b, key.col);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  const c = typeof va === "number" && typeof vb === "number"
    ? va - vb
    : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
  return key.dir === "desc" ? -c : c;
}

function compareAll(a: InvoiceListRow, b: InvoiceListRow, keys: SortKey[]): number {
  for (const k of keys) {
    const c = compareBy(a, b, k);
    if (c !== 0) return c;
  }
  return a.id - b.id;
}

// What a category falls back to inside itself: the bill you have owed longest,
// the prepaid that started first, the invoice completed most recently.
const WITHIN_DEFAULT: Record<Category, SortKey> = {
  unpaid: { col: "date", dir: "asc" },
  prepaid: { col: "date", dir: "asc" },
  completed: { col: "date", dir: "desc" },
};

export function isGrouped(sorts: SortKey[]): boolean {
  return sorts[0]?.col === "status";
}

export function isDefaultSort(sorts: SortKey[]): boolean {
  return sorts.length === 1 && sorts[0].col === "status" && sorts[0].dir === "asc";
}

export interface InvoiceGroup { category: Category; rows: InvoiceListRow[] }

// Status first: one group per category (in status order), rows inside ordered
// by the secondary sorts, then the category's own default. Any other primary:
// a single flat list, returned as one group with category null.
export function arrangeInvoices(
  rows: InvoiceListRow[], sorts: SortKey[],
): { grouped: true; groups: InvoiceGroup[] } | { grouped: false; rows: InvoiceListRow[] } {
  if (!isGrouped(sorts)) {
    return { grouped: false, rows: [...rows].sort((a, b) => compareAll(a, b, sorts)) };
  }
  const order = sorts[0].dir === "asc" ? CATEGORY_ORDER : [...CATEGORY_ORDER].reverse();
  const secondary = sorts.slice(1);
  return {
    grouped: true,
    groups: order.map((category) => ({
      category,
      rows: rows
        .filter((r) => categoryOf(r) === category)
        .sort((a, b) => compareAll(a, b, [...secondary, WITHIN_DEFAULT[category]])),
    })),
  };
}

// Clicking a header: the primary column cycles ascending → descending → back
// to the default; any other column becomes the primary, ascending.
export function clickHeader(sorts: SortKey[], col: SortCol): SortKey[] {
  const primary = sorts[0];
  if (primary?.col === col) {
    if (primary.dir === "asc") return [{ col, dir: "desc" }, ...sorts.slice(1)];
    return DEFAULT_SORT;
  }
  return [{ col, dir: "asc" }, ...sorts.slice(1).filter((s) => s.col !== col)];
}

export function addSort(sorts: SortKey[], col: SortCol): SortKey[] {
  if (sorts.length > MAX_SECONDARY_SORTS || sorts.some((s) => s.col === col)) return sorts;
  return [...sorts, { col, dir: "asc" }];
}

export function flipSort(sorts: SortKey[], i: number): SortKey[] {
  return sorts.map((s, j) => (j === i ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s));
}

export function removeSort(sorts: SortKey[], i: number): SortKey[] {
  if (i === 0) return sorts;
  return sorts.filter((_, j) => j !== i);
}
