"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useParams } from "next/navigation";
import {
  getFixedAssets, createFixedAsset, updateFixedAsset, disposeFixedAsset,
  generateDepreciationJEs, getChartOfAccounts, getQboAccounts,
  suggestFixedAssetByName,
  FixedAsset, DepreciationPeriod, FixedAssetSuggestion,
} from "@/lib/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s: string) {
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function statusBadge(status: string) {
  if (status === "active") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-400 border border-green-800">Active</span>;
  if (status === "fully_depreciated") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700">Fully Depreciated</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/50 text-red-400 border border-red-800">Disposed</span>;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const IMPORT_HEADERS = [
  "Asset Name", "Category", "Purchase Date", "Purchase Price",
  "Salvage Value", "Useful Life (months)", "Depreciation Method",
  "QBO Asset Account", "QBO Accum Dep Account", "QBO Dep Expense Account",
];

function downloadTemplate() {
  const rows = [
    IMPORT_HEADERS.join(","),
    '"MacBook Pro 14","Equipment","2025-01-15","2499.00","0","60","straight_line","Long-term office equipment","Accumulated Amortization - Domain Name","Depreciation Expense"',
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "fixed-assets-import-template.csv"; a.click();
  URL.revokeObjectURL(url);
}

function r2(n: number) { return Math.round(n * 100) / 100; }

function exportScheduleXlsx(assets: FixedAsset[]) {
  // Collect every calendar year that appears in any schedule
  const yearSet = new Set<number>();
  for (const a of assets) {
    for (const p of a.schedule) yearSet.add(parseInt(p.period.slice(0, 4)));
    if (a.is_indefinite_life) yearSet.add(parseInt(a.purchase_date.slice(0, 4)));
  }
  if (yearSet.size === 0) return;
  const years = Array.from(yearSet).sort((a, b) => a - b);

  // ── Sheet 1: Summary schedule (one row per asset, one col per year) ──────────
  const aoa: (string | number)[][] = [];

  aoa.push(["Depreciation Schedule", ...Array(5 + years.length).fill("")]);
  aoa.push(["For Financial Reporting Only.", ...Array(5 + years.length).fill("")]);
  aoa.push(Array(6 + years.length).fill(""));
  aoa.push(["", "", "", "", "", "", "Depreciation for Year …", ...Array(years.length - 1).fill("")]);
  aoa.push(["Asset", "Cost", "Year\nAcquired", "Salvage\nValue", "Life\n(Yrs)", "Method", ...years]);

  const yearTotals: Record<number, number> = {};
  years.forEach(y => { yearTotals[y] = 0; });

  for (const asset of assets) {
    // Sum monthly periods into annual buckets
    const annual: Record<number, number> = {};
    years.forEach(y => { annual[y] = 0; });
    for (const p of asset.schedule) {
      const y = parseInt(p.period.slice(0, 4));
      if (y in annual) annual[y] = r2(annual[y] + p.depreciation);
    }

    const method = asset.depreciation_method === "straight_line" ? "SL" : "DDB";
    const lifeYrs = asset.is_indefinite_life ? "Indefinite" :
      asset.useful_life_months > 0 ? (asset.useful_life_months / 12).toFixed(1) : "—";
    const acqYear = parseInt(asset.purchase_date.slice(0, 4));

    aoa.push([
      asset.name,
      asset.purchase_price,
      acqYear,
      asset.is_indefinite_life ? "—" : asset.salvage_value,
      lifeYrs,
      method,
      ...years.map(y => {
        const dep = annual[y] ?? 0;
        yearTotals[y] = r2((yearTotals[y] ?? 0) + dep);
        return dep > 0 ? dep : " - ";
      }),
    ]);
  }

  aoa.push(Array(6 + years.length).fill(""));
  aoa.push(["", "", "", "", "", "Total:", ...years.map(y => yearTotals[y] > 0 ? yearTotals[y] : " - ")]);

  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  ws1["!cols"] = [
    { wch: 32 }, { wch: 12 }, { wch: 9 }, { wch: 10 }, { wch: 9 }, { wch: 7 },
    ...years.map(() => ({ wch: 12 })),
  ];

  // ── Sheet 2: Detail (monthly, per-asset sections) ─────────────────────────────
  const det: (string | number)[][] = [];
  det.push(["Depreciation Schedule — Monthly Detail"]);
  det.push([]);

  for (const asset of assets) {
    det.push([asset.name, "", "", "", "", ""]);
    det.push(["Category", asset.category, "", "Method", asset.depreciation_method === "straight_line" ? "Straight-Line" : "Double-Declining", ""]);
    det.push(["Purchase Date", asset.purchase_date, "", "Cost", asset.purchase_price, ""]);
    det.push(["Useful Life", asset.is_indefinite_life ? "Indefinite" : `${asset.useful_life_months} months`, "", "Salvage", asset.is_indefinite_life ? "—" : asset.salvage_value, ""]);
    det.push([]);
    if (asset.is_indefinite_life) {
      det.push(["No depreciation — indefinite useful life (Goodwill, ASC 350)"]);
    } else {
      det.push(["Period", "Date", "Depreciation", "Accumulated Dep.", "Net Book Value", ""]);
      for (const p of asset.schedule) {
        det.push([p.period, p.date, p.depreciation, p.accumulated_depreciation, p.net_book_value, ""]);
      }
    }
    det.push([]);
    det.push([]);
  }

  const ws2 = XLSX.utils.aoa_to_sheet(det);
  ws2["!cols"] = [{ wch: 20 }, { wch: 15 }, { wch: 14 }, { wch: 16 }, { wch: 15 }, { wch: 8 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, "Schedule");
  XLSX.utils.book_append_sheet(wb, ws2, "Monthly Detail");
  XLSX.writeFile(wb, `depreciation-schedule-${currentMonth()}.xlsx`);
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map(line => {
    // Simple quoted CSV parse
    const cols: string[] = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuote = !inQuote; continue; }
      if (line[i] === "," && !inQuote) { cols.push(cur); cur = ""; continue; }
      cur += line[i];
    }
    cols.push(cur);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? "").trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v));
}

type ImportRow = {
  name: string; category: string; purchase_date: string; purchase_price: number;
  salvage_value: number; useful_life_months: number; depreciation_method: string;
  qbo_asset_account: string; qbo_accum_dep_account: string; qbo_dep_expense_account: string;
  error?: string;
};

function rowFromCsv(r: Record<string, string>): ImportRow {
  const name = r["Asset Name"] || r["name"] || "";
  const price = parseFloat(r["Purchase Price"] || r["purchase_price"] || "0");
  const salvage = parseFloat(r["Salvage Value"] || r["salvage_value"] || "0");
  const life = parseInt(r["Useful Life (months)"] || r["useful_life_months"] || "0");
  const method = (r["Depreciation Method"] || r["depreciation_method"] || "straight_line")
    .toLowerCase().replace(/[^a-z_]/g, "_");
  const methodNorm = method.includes("double") ? "double_declining" : "straight_line";
  const errors: string[] = [];
  if (!name) errors.push("missing name");
  if (!price) errors.push("missing price");
  if (!life) errors.push("missing useful life");
  return {
    name,
    category: r["Category"] || r["category"] || "Equipment",
    purchase_date: r["Purchase Date"] || r["purchase_date"] || "",
    purchase_price: price,
    salvage_value: isNaN(salvage) ? 0 : salvage,
    useful_life_months: life,
    depreciation_method: methodNorm,
    qbo_asset_account: r["QBO Asset Account"] || r["qbo_asset_account"] || "",
    qbo_accum_dep_account: r["QBO Accum Dep Account"] || r["qbo_accum_dep_account"] || "",
    qbo_dep_expense_account: r["QBO Dep Expense Account"] || r["qbo_dep_expense_account"] || "",
    error: errors.length ? errors.join(", ") : undefined,
  };
}

// ── Shared form fields ────────────────────────────────────────────────────────

const TANGIBLE_CATEGORIES = ["Equipment", "Furniture", "Leasehold Improvements", "Vehicles", "Other"];
const INTANGIBLE_CATEGORIES = ["Capitalized Software", "Licenses", "Patents", "Trademarks", "Customer Lists", "Non-Compete Agreements", "Goodwill", "Other Intangibles"];
const INTANGIBLE_SET = new Set(INTANGIBLE_CATEGORIES);
const INTANGIBLE_DEFAULT_LIFE: Record<string, number> = {
  "Capitalized Software": 36,
  "Licenses": 36,
  "Patents": 240,
  "Trademarks": 120,
  "Customer Lists": 60,
  "Non-Compete Agreements": 36,
  "Other Intangibles": 60,
  "Goodwill": 0,
};

const DEP_METHODS = [
  { value: "straight_line", label: "Straight-Line" },
  { value: "double_declining", label: "Double-Declining Balance" },
];

// ── Account field with dropdown (no browser datalist quirks) ──────────────────

function AccountField({ value, onChange, accounts, placeholder = "Type to search…", className }: {
  value: string;
  onChange: (v: string) => void;
  accounts: string[];
  placeholder?: string;
  className?: string;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setInputValue(value); }, [value]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const filtered = inputValue
    ? accounts.filter(a => a.toLowerCase().includes(inputValue.toLowerCase()))
    : accounts;

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={inputValue}
        placeholder={placeholder}
        className={className}
        onChange={e => { const v = e.target.value; setInputValue(v); onChange(v); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { setTimeout(() => { if (ref.current && !ref.current.contains(document.activeElement)) { setOpen(false); } }, 150); }}
        onKeyDown={e => {
          if (e.key === "Escape") { setOpen(false); }
          if (e.key === "Enter" && filtered.length > 0) { e.preventDefault(); setInputValue(filtered[0]); onChange(filtered[0]); setOpen(false); }
        }}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          <div className="max-h-48 overflow-y-auto">
            {filtered.slice(0, 50).map(a => (
              <button key={a} type="button"
                onMouseDown={e => { e.preventDefault(); setInputValue(a); onChange(a); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs ${a === value ? "text-indigo-400 bg-gray-800/50" : "text-gray-200 hover:bg-gray-800"}`}>
                {a}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type FormState = {
  name: string; category: string; purchaseDate: string; purchasePrice: string;
  salvageValue: string; usefulLife: string; method: string;
  assetAcct: string; accumAcct: string; expAcct: string;
};

function AssetFormFields({ form, setForm, accounts, onNameBlur, suggesting }: {
  form: FormState;
  setForm: (f: FormState) => void;
  accounts: string[];
  onNameBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  suggesting?: boolean;
}) {
  const isIntangible = INTANGIBLE_SET.has(form.category);
  const isGoodwill = form.category === "Goodwill";
  const term = isIntangible ? "Amortization" : "Depreciation";

  function handleCategoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const cat = e.target.value;
    const intangible = INTANGIBLE_SET.has(cat);
    const defaultLife = intangible
      ? String(INTANGIBLE_DEFAULT_LIFE[cat] ?? 60)
      : (form.usefulLife === "0" ? "60" : form.usefulLife);
    setForm({
      ...form,
      category: cat,
      method: intangible ? "straight_line" : form.method,
      salvageValue: intangible ? "0" : form.salvageValue,
      usefulLife: defaultLife,
    });
  }

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const cls = "w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <>
      {isIntangible && (
        <div className="bg-violet-950/40 border border-violet-800/50 rounded-lg px-3 py-2 text-xs text-violet-300">
          {isGoodwill
            ? "Goodwill has an indefinite useful life under GAAP — no amortization is recorded. Annual impairment testing is required."
            : `Intangible asset — straight-line amortization only, no salvage value (GAAP ASC 350).`}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-gray-500">Asset Name</label>
            {suggesting && <span className="text-xs text-indigo-400">✦ detecting…</span>}
          </div>
          <input value={form.name} onChange={set("name")} onBlur={onNameBlur} className={cls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Category</label>
          <select value={form.category} onChange={handleCategoryChange} className={cls}>
            <optgroup label="Tangible Assets">
              {TANGIBLE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </optgroup>
            <optgroup label="Intangible Assets">
              {INTANGIBLE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </optgroup>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Purchase Date</label>
          <input type="date" value={form.purchaseDate} onChange={set("purchaseDate")} className={cls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
          <input type="number" step="0.01" value={form.purchasePrice} onChange={set("purchasePrice")} className={cls} />
        </div>
        {!isIntangible && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Salvage Value ($)</label>
            <input type="number" step="0.01" value={form.salvageValue} onChange={set("salvageValue")} className={cls} />
          </div>
        )}
        {!isGoodwill && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Useful Life (months)</label>
            <input type="number" min="1" value={form.usefulLife} onChange={set("usefulLife")} className={cls} />
          </div>
        )}
        {!isIntangible && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Depreciation Method</label>
            <select value={form.method} onChange={set("method")} className={cls}>
              {DEP_METHODS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="space-y-3 pt-1 border-t border-gray-800">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">QBO Accounts</p>
        {([
          ["Asset Account", "assetAcct"],
          [`Accumulated ${term} Account`, "accumAcct"],
          [`${term} Expense Account`, "expAcct"],
        ] as [string, keyof FormState][]).map(([label, key]) => (
          <div key={key}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <AccountField
              value={form[key] as string}
              onChange={v => setForm({ ...form, [key]: v })}
              accounts={accounts}
              className={cls}
              placeholder="Type to search COA…"
            />
          </div>
        ))}
      </div>
    </>
  );
}

// ── Add panel ─────────────────────────────────────────────────────────────────

const EMPTY_FORM: FormState = {
  name: "", category: "Equipment", purchaseDate: "", purchasePrice: "",
  salvageValue: "0", usefulLife: "60", method: "straight_line",
  assetAcct: "", accumAcct: "", expAcct: "",
};

function AddPanel({ clientId, accounts, onAdd, onClose }: {
  clientId: number; accounts: string[];
  onAdd: (a: FixedAsset) => void; onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<FixedAssetSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleNameBlur(e: React.FocusEvent<HTMLInputElement>) {
    const name = e.currentTarget.value.trim();
    if (!name) return;
    setSuggesting(true);
    setSuggestion(null);
    try {
      const s = await suggestFixedAssetByName(clientId, name);
      setSuggestion(s);
      setForm(prev => ({
        ...prev,
        category: s.category,
        salvageValue: String(s.salvage_value),
        usefulLife: String(s.useful_life_months),
        method: s.depreciation_method,
      }));
    } catch { /* ignore */ }
    finally { setSuggesting(false); }
  }

  async function handleSave() {
    setSaving(true); setError(null);
    const isIntangible = INTANGIBLE_SET.has(form.category);
    const isGoodwill = form.category === "Goodwill";
    try {
      const asset = await createFixedAsset(clientId, {
        name: form.name, category: form.category,
        purchase_date: form.purchaseDate,
        purchase_price: parseFloat(form.purchasePrice),
        salvage_value: isIntangible ? 0 : (parseFloat(form.salvageValue) || 0),
        useful_life_months: isGoodwill ? 0 : parseInt(form.usefulLife),
        depreciation_method: isIntangible ? "straight_line" : form.method,
        asset_type: isIntangible ? "intangible" : "tangible",
        is_indefinite_life: isGoodwill,
        qbo_asset_account: form.assetAcct || undefined,
        qbo_accum_dep_account: form.accumAcct || undefined,
        qbo_dep_expense_account: form.expAcct || undefined,
      });
      onAdd(asset);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const isGoodwillForm = form.category === "Goodwill";
  const valid = form.name && form.purchaseDate && parseFloat(form.purchasePrice) > 0 && (isGoodwillForm || parseInt(form.usefulLife) > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg overflow-y-auto max-h-[90vh] shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Add Fixed Asset</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {suggestion && (
            <div className="bg-indigo-950/40 border border-indigo-800/50 rounded-lg px-3 py-2 text-xs text-indigo-300">
              ✦ AI pre-filled based on asset name — review and adjust as needed
            </div>
          )}
          <AssetFormFields form={form} setForm={setForm} accounts={accounts} onNameBlur={handleNameBlur} suggesting={suggesting} />
          {error && <p className="text-xs text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} disabled={saving || !valid}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors">
              {saving ? "Adding…" : "Add Asset"}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Edit panel ────────────────────────────────────────────────────────────────

function EditPanel({ asset, accounts, onSave, onClose }: {
  asset: FixedAsset; accounts: string[];
  onSave: (a: FixedAsset) => void; onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>({
    name: asset.name, category: asset.category,
    purchaseDate: asset.purchase_date, purchasePrice: String(asset.purchase_price),
    salvageValue: String(asset.salvage_value), usefulLife: String(asset.useful_life_months),
    method: asset.depreciation_method, assetAcct: asset.qbo_asset_account ?? "",
    accumAcct: asset.qbo_accum_dep_account ?? "", expAcct: asset.qbo_dep_expense_account ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    const isIntangible = INTANGIBLE_SET.has(form.category);
    const isGoodwill = form.category === "Goodwill";
    try {
      const updated = await updateFixedAsset(asset.client_id, asset.id, {
        name: form.name, category: form.category,
        purchase_date: form.purchaseDate,
        purchase_price: parseFloat(form.purchasePrice),
        salvage_value: isIntangible ? 0 : (parseFloat(form.salvageValue) || 0),
        useful_life_months: isGoodwill ? 0 : parseInt(form.usefulLife),
        depreciation_method: isIntangible ? "straight_line" : form.method,
        asset_type: isIntangible ? "intangible" : "tangible",
        is_indefinite_life: isGoodwill,
        qbo_asset_account: form.assetAcct || undefined,
        qbo_accum_dep_account: form.accumAcct || undefined,
        qbo_dep_expense_account: form.expAcct || undefined,
      });
      onSave(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg overflow-y-auto max-h-[90vh] shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Edit Asset</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <AssetFormFields form={form} setForm={setForm} accounts={accounts} />
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} disabled={saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors">
              {saving ? "Saving…" : "Save Changes"}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CSV Import panel ──────────────────────────────────────────────────────────

function ImportPanel({ clientId, onImport, onClose }: {
  clientId: number; onImport: (assets: FixedAsset[]) => void; onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCsv(text).map(rowFromCsv);
      setRows(parsed);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!rows) return;
    const valid = rows.filter(r => !r.error);
    setImporting(true);
    setErrors([]);
    const created: FixedAsset[] = [];
    for (let i = 0; i < valid.length; i++) {
      const r = valid[i];
      try {
        const asset = await createFixedAsset(clientId, {
          name: r.name, category: r.category,
          purchase_date: r.purchase_date,
          purchase_price: r.purchase_price,
          salvage_value: r.salvage_value,
          useful_life_months: r.useful_life_months,
          depreciation_method: r.depreciation_method,
          qbo_asset_account: r.qbo_asset_account || undefined,
          qbo_accum_dep_account: r.qbo_accum_dep_account || undefined,
          qbo_dep_expense_account: r.qbo_dep_expense_account || undefined,
        });
        created.push(asset);
      } catch (err: unknown) {
        setErrors(prev => [...prev, `"${r.name}": ${err instanceof Error ? err.message : "failed"}`]);
      }
      setProgress(i + 1);
    }
    setImporting(false);
    if (created.length > 0) onImport(created);
  }

  const validCount = rows?.filter(r => !r.error).length ?? 0;
  const invalidCount = rows?.filter(r => r.error).length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl overflow-y-auto max-h-[90vh] shadow-2xl">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Import Fixed Assets from CSV</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">

          {/* Template download */}
          <div className="bg-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm text-white font-medium">CSV Template</p>
              <p className="text-xs text-gray-400 mt-0.5">Download the template, fill it in, then upload below.</p>
            </div>
            <button onClick={downloadTemplate}
              className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-700 hover:border-indigo-500 px-3 py-1.5 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Template
            </button>
          </div>

          {/* File picker */}
          <div>
            <label className="block text-xs text-gray-500 mb-2">Upload CSV file</label>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile}
              className="block w-full text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-700 file:text-white hover:file:bg-indigo-600 cursor-pointer" />
          </div>

          {/* Preview */}
          {rows && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <p className="text-xs text-gray-400">{rows.length} rows parsed</p>
                {validCount > 0 && <span className="text-xs text-green-400">{validCount} ready to import</span>}
                {invalidCount > 0 && <span className="text-xs text-red-400">{invalidCount} with errors</span>}
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-800 max-h-64 overflow-y-auto">
                <table className="w-full text-xs min-w-[600px]">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800 text-gray-500">
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Category</th>
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-right font-medium">Life (mo)</th>
                      <th className="px-3 py-2 text-left font-medium">Method</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-b border-gray-800 last:border-0 ${r.error ? "bg-red-950/30" : ""}`}>
                        <td className="px-3 py-1.5 text-white">{r.name || <span className="text-gray-600">—</span>}</td>
                        <td className="px-3 py-1.5 text-gray-400">{r.category}</td>
                        <td className="px-3 py-1.5 text-gray-400">{r.purchase_date}</td>
                        <td className="px-3 py-1.5 text-right text-gray-300 font-mono">{r.purchase_price ? `$${fmt(r.purchase_price)}` : "—"}</td>
                        <td className="px-3 py-1.5 text-right text-gray-400">{r.useful_life_months || "—"}</td>
                        <td className="px-3 py-1.5 text-gray-400">{r.depreciation_method === "double_declining" ? "DDB" : "SL"}</td>
                        <td className="px-3 py-1.5">
                          {r.error
                            ? <span className="text-red-400">✗ {r.error}</span>
                            : <span className="text-green-400">✓ Ready</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Import errors */}
          {errors.length > 0 && (
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 space-y-1">
              {errors.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
            </div>
          )}

          {importing && (
            <p className="text-xs text-indigo-400">Importing {progress} of {validCount}…</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleImport}
              disabled={importing || !rows || validCount === 0}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              {importing ? `Importing… (${progress}/${validCount})` : `Import ${validCount} Asset${validCount !== 1 ? "s" : ""}`}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Asset row ─────────────────────────────────────────────────────────────────

function AssetRow({ asset, onEdit, onDispose }: {
  asset: FixedAsset; onEdit: () => void; onDispose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const today = currentMonth();

  return (
    <>
      <tr className="border-b border-gray-800 hover:bg-gray-800/30 transition-colors">
        <td className="px-4 py-3">
          <button onClick={() => setExpanded(e => !e)} className="flex items-center gap-2 text-left">
            <svg className={`w-3.5 h-3.5 text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-sm text-white font-medium">{asset.name}</span>
          </button>
        </td>
        <td className="px-4 py-3 text-xs text-gray-400">{asset.category}</td>
        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(asset.purchase_date)}</td>
        <td className="px-4 py-3 text-xs text-right text-gray-300 font-mono">${fmt(asset.purchase_price)}</td>
        <td className="px-4 py-3 text-xs text-right text-gray-400 font-mono">${fmt(asset.salvage_value)}</td>
        <td className="px-4 py-3 text-xs text-right text-indigo-400 font-mono">
          {asset.is_indefinite_life ? <span className="text-gray-600">—</span> : `$${fmt(asset.monthly_depreciation)}`}
        </td>
        <td className="px-4 py-3 text-xs text-right text-yellow-400 font-mono">${fmt(asset.accumulated_depreciation_to_date)}</td>
        <td className="px-4 py-3 text-xs text-right text-green-400 font-mono">${fmt(asset.net_book_value)}</td>
        <td className="px-4 py-3">{statusBadge(asset.status)}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={onEdit} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Edit</button>
            {asset.status === "active" && (
              <button onClick={onDispose} className="text-xs text-red-500 hover:text-red-400 transition-colors">Dispose</button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-900/50">
          <td colSpan={10} className="px-6 py-4">
            {asset.is_indefinite_life ? (
              <div className="bg-violet-950/40 border border-violet-800/50 rounded-lg px-4 py-3 text-xs text-violet-300">
                <p className="font-medium mb-1">Indefinite Useful Life — No Amortization</p>
                <p className="text-violet-400">Goodwill is not amortized under GAAP (ASC 350). Annual impairment testing is required. If impairment is identified, record a write-down journal entry.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wider">
                  Full {asset.asset_type === "intangible" ? "Amortization" : "Depreciation"} Schedule
                </p>
                <div className="overflow-x-auto rounded-lg border border-gray-800">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-500">
                        <th className="px-3 py-2 text-left font-medium">Period</th>
                        <th className="px-3 py-2 text-left font-medium">Date</th>
                        <th className="px-3 py-2 text-right font-medium">{asset.asset_type === "intangible" ? "Amortization" : "Depreciation"}</th>
                        <th className="px-3 py-2 text-right font-medium">Accumulated</th>
                        <th className="px-3 py-2 text-right font-medium">Net Book Value</th>
                        <th className="px-3 py-2 text-center font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asset.schedule.map((p: DepreciationPeriod) => {
                        const isPast = p.period < today;
                        const isCurrent = p.period === today;
                        return (
                          <tr key={p.period} className={`border-b border-gray-800 last:border-0 ${isCurrent ? "bg-indigo-950/30" : ""}`}>
                            <td className={`px-3 py-1.5 font-mono ${isCurrent ? "text-indigo-300" : "text-gray-400"}`}>{p.period}</td>
                            <td className="px-3 py-1.5 text-gray-500">{fmtDate(p.date)}</td>
                            <td className="px-3 py-1.5 text-right text-indigo-400 font-mono">${fmt(p.depreciation)}</td>
                            <td className="px-3 py-1.5 text-right text-yellow-400 font-mono">${fmt(p.accumulated_depreciation)}</td>
                            <td className="px-3 py-1.5 text-right text-green-400 font-mono">${fmt(p.net_book_value)}</td>
                            <td className="px-3 py-1.5 text-center">
                              {isPast ? <span className="text-gray-600">Posted</span> : isCurrent ? <span className="text-indigo-400">Current</span> : <span className="text-gray-700">Future</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FixedAssetsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ created: number; skipped: number } | null>(null);

  const loadAccounts = useCallback(async () => {
    setAccountsError(null);
    const [coa, qboResult] = await Promise.all([
      getChartOfAccounts(clientId).catch(() => [] as string[]),
      getQboAccounts(clientId).catch((e: unknown) => {
        setAccountsError(e instanceof Error ? e.message : "Failed to load QBO accounts");
        return [] as string[];
      }),
    ]);
    const merged = Array.from(new Set([...coa, ...qboResult])).sort();
    setAccounts(merged);
  }, [clientId]);

  useEffect(() => {
    Promise.all([
      getFixedAssets(clientId).then(setAssets),
      loadAccounts(),
    ]).finally(() => setLoading(false));
  }, [clientId, loadAccounts]);

  async function handleDispose(asset: FixedAsset) {
    if (!confirm(`Mark "${asset.name}" as disposed? This cannot be undone.`)) return;
    const updated = await disposeFixedAsset(clientId, asset.id);
    setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
  }

  async function handleGenerateDepreciation() {
    setGenerating(true); setGenResult(null);
    try {
      const result = await generateDepreciationJEs(clientId, currentMonth());
      setGenResult(result);
      setAssets(await getFixedAssets(clientId));
    } finally {
      setGenerating(false);
    }
  }

  const active = assets.filter(a => a.status !== "disposed");
  const totalGross = active.reduce((s, a) => s + a.purchase_price, 0);
  const totalAccum = active.reduce((s, a) => s + a.accumulated_depreciation_to_date, 0);
  const totalNBV = active.reduce((s, a) => s + a.net_book_value, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {showAdd && (
        <AddPanel clientId={clientId} accounts={accounts}
          onAdd={(a) => { setAssets(prev => [...prev, a]); setShowAdd(false); }}
          onClose={() => setShowAdd(false)} />
      )}
      {showImport && (
        <ImportPanel clientId={clientId}
          onImport={(newAssets) => { setAssets(prev => [...prev, ...newAssets]); setShowImport(false); }}
          onClose={() => setShowImport(false)} />
      )}
      {editingAsset && (
        <EditPanel asset={editingAsset} accounts={accounts}
          onSave={(updated) => { setAssets(prev => prev.map(a => a.id === updated.id ? updated : a)); setEditingAsset(null); }}
          onClose={() => setEditingAsset(null)} />
      )}

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Fixed Assets & Intangibles</h1>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-gray-500 text-xs">Depreciation and amortization schedule registry</p>
            {accountsError ? (
              <span className="text-xs text-red-400 flex items-center gap-1.5">
                ⚠ COA: {accountsError}
                <button onClick={loadAccounts} className="underline text-indigo-400 hover:text-indigo-300">Retry</button>
              </span>
            ) : accounts.length > 0 ? (
              <span className="text-xs text-gray-600">{accounts.length} accounts loaded</span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {genResult && (
            <span className="text-xs text-green-400">
              {genResult.created === 0 ? "No new JEs needed" : `${genResult.created} JE${genResult.created !== 1 ? "s" : ""} added to Review Queue`}
            </span>
          )}
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Asset
          </button>
          <button onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
            </svg>
            Import CSV
          </button>
          <button onClick={handleGenerateDepreciation}
            disabled={generating || assets.filter(a => a.status === "active").length === 0}
            className="flex items-center gap-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors">
            {generating ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating…</> : `Generate ${currentMonth()} Dep./Amort. JEs`}
          </button>
          {assets.length > 0 && (
            <button onClick={() => exportScheduleXlsx(assets)}
              className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export Schedule
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      {assets.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-gray-500 mb-1">Gross Asset Value</p>
            <p className="text-2xl font-bold text-white font-mono">${fmt(totalGross)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-gray-500 mb-1">Accumulated Dep./Amort.</p>
            <p className="text-2xl font-bold text-yellow-400 font-mono">${fmt(totalAccum)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-gray-500 mb-1">Net Book Value</p>
            <p className="text-2xl font-bold text-green-400 font-mono">${fmt(totalNBV)}</p>
          </div>
        </div>
      )}

      {/* Asset table */}
      {assets.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-4xl mb-3">🏗️</p>
          <p className="text-gray-400 font-medium">No fixed assets yet</p>
          <p className="text-sm mt-1">Add an asset manually, import a CSV, or mark a transaction as a Fixed Asset in the Review Queue.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left font-medium">Asset</th>
                <th className="px-4 py-3 text-left font-medium">Category</th>
                <th className="px-4 py-3 text-left font-medium">Purchase Date</th>
                <th className="px-4 py-3 text-right font-medium">Cost</th>
                <th className="px-4 py-3 text-right font-medium">Salvage</th>
                <th className="px-4 py-3 text-right font-medium">Monthly Dep./Amort.</th>
                <th className="px-4 py-3 text-right font-medium">Accum. Dep./Amort.</th>
                <th className="px-4 py-3 text-right font-medium">Net Book Value</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map(asset => (
                <AssetRow key={asset.id} asset={asset}
                  onEdit={() => setEditingAsset(asset)}
                  onDispose={() => handleDispose(asset)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
