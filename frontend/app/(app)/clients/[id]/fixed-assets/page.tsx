"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getFixedAssets, updateFixedAsset, disposeFixedAsset, generateDepreciationJEs,
  getChartOfAccounts,
  FixedAsset, DepreciationPeriod,
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

// ── CSV Export ────────────────────────────────────────────────────────────────

function exportScheduleCsv(assets: FixedAsset[]) {
  const rows: string[] = ["Asset Name,Category,Purchase Date,Purchase Price,Salvage Value,Method,Period,Date,Depreciation,Accumulated Depreciation,Net Book Value"];
  for (const a of assets) {
    for (const p of a.schedule) {
      rows.push([
        `"${a.name}"`, `"${a.category}"`, a.purchase_date,
        a.purchase_price, a.salvage_value, a.depreciation_method,
        p.period, p.date, p.depreciation, p.accumulated_depreciation, p.net_book_value,
      ].join(","));
    }
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `depreciation-schedule-${currentMonth()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Edit panel ────────────────────────────────────────────────────────────────

const CATEGORIES = ["Equipment", "Furniture", "Leasehold Improvements", "Vehicles", "Other"];
const DEP_METHODS = [
  { value: "straight_line", label: "Straight-Line" },
  { value: "double_declining", label: "Double-Declining Balance" },
];

function EditPanel({
  asset, accounts, onSave, onClose,
}: {
  asset: FixedAsset;
  accounts: string[];
  onSave: (a: FixedAsset) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(asset.name);
  const [category, setCategory] = useState(asset.category);
  const [purchaseDate, setPurchaseDate] = useState(asset.purchase_date);
  const [purchasePrice, setPurchasePrice] = useState(String(asset.purchase_price));
  const [salvageValue, setSalvageValue] = useState(String(asset.salvage_value));
  const [usefulLife, setUsefulLife] = useState(String(asset.useful_life_months));
  const [method, setMethod] = useState(asset.depreciation_method);
  const [assetAcct, setAssetAcct] = useState(asset.qbo_asset_account ?? "");
  const [accumAcct, setAccumAcct] = useState(asset.qbo_accum_dep_account ?? "");
  const [expAcct, setExpAcct] = useState(asset.qbo_dep_expense_account ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await updateFixedAsset(asset.client_id, asset.id, {
        name, category,
        purchase_date: purchaseDate,
        purchase_price: parseFloat(purchasePrice),
        salvage_value: parseFloat(salvageValue) || 0,
        useful_life_months: parseInt(usefulLife),
        depreciation_method: method,
        qbo_asset_account: assetAcct || undefined,
        qbo_accum_dep_account: accumAcct || undefined,
        qbo_dep_expense_account: expAcct || undefined,
      });
      onSave(updated);
    } finally {
      setSaving(false);
    }
  }

  const selectCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500";
  const inputCls = selectCls;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg p-6 space-y-4 overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Edit Asset</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Asset Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className={selectCls}>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
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
            <input type="number" value={usefulLife} onChange={e => setUsefulLife(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Depreciation Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)} className={selectCls}>
              {DEP_METHODS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
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
                list={`accts-${label}`}
                className={inputCls}
                placeholder="Type to search COA…"
              />
              <datalist id={`accts-${label}`}>
                {accounts.map(a => <option key={a} value={a} />)}
              </datalist>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Asset row ──────────────────────────────────────────────────────────────────

function AssetRow({
  asset, onEdit, onDispose, onUpdate,
}: {
  asset: FixedAsset;
  onEdit: () => void;
  onDispose: () => void;
  onUpdate: (a: FixedAsset) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const today = currentMonth();

  return (
    <>
      <tr className="border-b border-gray-800 hover:bg-gray-800/30 transition-colors">
        <td className="px-4 py-3">
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-2 text-left"
          >
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
        <td className="px-4 py-3 text-xs text-right text-indigo-400 font-mono">${fmt(asset.monthly_depreciation)}</td>
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
            <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wider">Full Depreciation Schedule</p>
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-500">
                    <th className="px-3 py-2 text-left font-medium">Period</th>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-right font-medium">Depreciation</th>
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
  const [loading, setLoading] = useState(true);
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ created: number; skipped: number } | null>(null);

  useEffect(() => {
    Promise.all([
      getFixedAssets(clientId).then(setAssets),
      getChartOfAccounts(clientId).then(setAccounts).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [clientId]);

  async function handleDispose(asset: FixedAsset) {
    if (!confirm(`Mark "${asset.name}" as disposed? This cannot be undone.`)) return;
    const updated = await disposeFixedAsset(clientId, asset.id);
    setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
  }

  async function handleGenerateDepreciation() {
    setGenerating(true);
    setGenResult(null);
    try {
      const result = await generateDepreciationJEs(clientId, currentMonth());
      setGenResult(result);
      // Reload assets to update accumulated depreciation
      const updated = await getFixedAssets(clientId);
      setAssets(updated);
    } finally {
      setGenerating(false);
    }
  }

  // Summary totals
  const totalGross = assets.filter(a => a.status !== "disposed").reduce((s, a) => s + a.purchase_price, 0);
  const totalAccum = assets.filter(a => a.status !== "disposed").reduce((s, a) => s + a.accumulated_depreciation_to_date, 0);
  const totalNBV = assets.filter(a => a.status !== "disposed").reduce((s, a) => s + a.net_book_value, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {editingAsset && (
        <EditPanel
          asset={editingAsset}
          accounts={accounts}
          onSave={(updated) => {
            setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
            setEditingAsset(null);
          }}
          onClose={() => setEditingAsset(null)}
        />
      )}

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Fixed Assets</h1>
          <p className="text-gray-500 mt-1 text-xs">Depreciation schedule and asset registry</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {genResult && (
            <span className="text-xs text-green-400">
              {genResult.created === 0
                ? "No new JEs needed"
                : `${genResult.created} depreciation JE${genResult.created !== 1 ? "s" : ""} added to Review Queue`}
            </span>
          )}
          <button
            onClick={handleGenerateDepreciation}
            disabled={generating || assets.filter(a => a.status === "active").length === 0}
            className="flex items-center gap-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
          >
            {generating ? (
              <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating…</>
            ) : `Generate ${currentMonth()} Depreciation JEs`}
          </button>
          {assets.length > 0 && (
            <button
              onClick={() => exportScheduleCsv(assets)}
              className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
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
            <p className="text-xs text-gray-500 mb-1">Accumulated Depreciation</p>
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
          <p className="text-sm mt-1">Mark a transaction as a Fixed Asset in the Review Queue to get started.</p>
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
                <th className="px-4 py-3 text-right font-medium">Monthly Dep.</th>
                <th className="px-4 py-3 text-right font-medium">Accum. Dep.</th>
                <th className="px-4 py-3 text-right font-medium">Net Book Value</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map(asset => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  onEdit={() => setEditingAsset(asset)}
                  onDispose={() => handleDispose(asset)}
                  onUpdate={(updated) => setAssets(prev => prev.map(a => a.id === updated.id ? updated : a))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
