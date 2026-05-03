"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getRevenueSummary, getRevenueContracts, getRevenueStreams, getArAging,
  syncRevenueSources, generateRevenueJEs, updateRevenueContract, deleteRevenueContract,
  getRevenueIntegrationSettings, updateRevenueIntegrationSettings,
  createRevenueStream, updateRevenueStream, deleteRevenueStream,
  bulkMatchContracts, generateAllJEs,
  RevenueSummary, RevenueContract, RevenueStream, ArAgingRow,
  RevenueIntegrationSettings,
  BillingType, BILLING_TYPE_LABELS,
} from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

type Tab = "schedule" | "ar-aging" | "settings";

const BILLING_TYPES: BillingType[] = [
  "annual_upfront", "quarterly_upfront", "monthly_advance", "monthly_arrears", "invoice_completion",
];

const STATUS_BADGE: Record<string, string> = {
  active:           "bg-indigo-900 text-indigo-300 border border-indigo-700",
  fully_recognized: "bg-green-900 text-green-300 border border-green-700",
  cancelled:        "bg-gray-800 text-gray-500 border border-gray-700",
};

const AGING_BADGE: Record<string, string> = {
  current:  "bg-green-900 text-green-300",
  "1-30":   "bg-yellow-900 text-yellow-300",
  "31-60":  "bg-orange-900 text-orange-300",
  "61-90":  "bg-red-900 text-red-300",
  "over-90":"bg-red-950 text-red-400 font-bold",
};

function fmt(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function fmtMonth(s: string) {
  const [y, m] = s.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export default function RevenuePage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const { setCurrentPage, setPageContext } = useChatContext();

  const [tab, setTab] = useState<Tab>("schedule");
  const [summary, setSummary] = useState<RevenueSummary | null>(null);
  const [contracts, setContracts] = useState<RevenueContract[]>([]);
  const [streams, setStreams] = useState<RevenueStream[]>([]);
  const [arAging, setArAging] = useState<ArAgingRow[]>([]);
  const [settings, setSettings] = useState<RevenueIntegrationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [generatingJe, setGeneratingJe] = useState<number | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [bulkMatching, setBulkMatching] = useState(false);
  const [selectedStreamForMatch, setSelectedStreamForMatch] = useState<number | "">("");

  useEffect(() => {
    setCurrentPage("revenue");
    return () => setPageContext(null);
  }, [setCurrentPage, setPageContext]);

  useEffect(() => { load(); }, [clientId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, c, st, ar, int_] = await Promise.all([
        getRevenueSummary(clientId),
        getRevenueContracts(clientId),
        getRevenueStreams(clientId),
        getArAging(clientId),
        getRevenueIntegrationSettings(clientId),
      ]);
      setSummary(s);
      setContracts(c);
      setStreams(st);
      setArAging(ar);
      setSettings(int_);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await syncRevenueSources(clientId);
      setMsg(`Synced: ${r.imported} new contract${r.imported !== 1 ? "s" : ""} imported.${r.errors.length ? " Errors: " + r.errors.join("; ") : ""}`);
      load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleGenerateJes(contractId: number) {
    setGeneratingJe(contractId);
    try {
      const r = await generateRevenueJEs(clientId, contractId);
      setMsg(`Generated ${r.created.length} recognition JE${r.created.length !== 1 ? "s" : ""} for review.`);
      load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "JE generation failed");
    } finally {
      setGeneratingJe(null);
    }
  }

  async function handleBulkMatch() {
    if (!selectedStreamForMatch) return;
    setBulkMatching(true);
    setMsg(null);
    try {
      const r = await bulkMatchContracts(clientId, Number(selectedStreamForMatch));
      setMsg(`Matched ${r.updated} contract${r.updated !== 1 ? "s" : ""} to stream.`);
      load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Match failed");
    } finally {
      setBulkMatching(false);
    }
  }

  async function handleGenerateAll() {
    setGeneratingAll(true);
    setMsg(null);
    try {
      const r = await generateAllJEs(clientId);
      setMsg(`Generated ${r.created} journal entr${r.created !== 1 ? "ies" : "y"} — available in Review queue.${r.errors.length ? " Errors: " + r.errors.join("; ") : ""}`);
      load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "JE generation failed");
    } finally {
      setGeneratingAll(false);
    }
  }

  async function handleStatusChange(contract: RevenueContract, status: string) {
    await updateRevenueContract(clientId, contract.id, { status });
    load();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this contract and all its schedule entries?")) return;
    await deleteRevenueContract(clientId, id);
    load();
  }

  const streamMap = Object.fromEntries(streams.map((s) => [s.id, s]));

  if (loading) return (
    <div className="flex justify-center h-60 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Revenue</h1>
          <p className="text-gray-500 mt-1 text-xs">ASC 606 — deferred revenue, AR aging, and recognition schedules</p>
        </div>
        {tab !== "settings" && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {syncing ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />Syncing…</>
            ) : "Sync Sources"}
          </button>
        )}
      </div>

      {error && <div className="mb-4 bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}
      {msg && <div className="mb-4 bg-indigo-950 border border-indigo-800 text-indigo-300 rounded-lg px-4 py-3 text-sm">{msg}</div>}

      {/* Summary Cards — shown on schedule + ar-aging tabs */}
      {summary && tab !== "settings" && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryCard label="Recognized This Month" value={fmt(summary.recognized_this_month)} color="text-green-400" />
          <SummaryCard label="Deferred Revenue" value={fmt(summary.total_deferred)} color="text-yellow-400" />
          <SummaryCard label="AR Outstanding" value={fmt(summary.total_ar_outstanding)} color="text-blue-400" />
          <SummaryCard label="Invoices Overdue" value={String(summary.invoices_overdue)}
            color={summary.invoices_overdue > 0 ? "text-red-400" : "text-gray-400"} />
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 border-b border-gray-800">
        <nav className="flex gap-1">
          {([
            ["schedule",  "Recognition Schedule"],
            ["ar-aging",  "AR Aging"],
            ["settings",  "Settings"],
          ] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                tab === t
                  ? "bg-gray-900 border border-b-gray-900 border-gray-700 text-white -mb-px"
                  : "text-gray-400 hover:text-gray-200"
              }`}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "schedule" && (
        <>
          {/* Guided action bar */}
          {streams.length === 0 ? (
            <div className="mb-4 bg-indigo-950 border border-indigo-800 rounded-xl px-5 py-4">
              <p className="text-sm font-medium text-indigo-200 mb-1">Set up revenue streams to classify your invoices</p>
              <p className="text-xs text-indigo-400 mb-3">Revenue streams define how each invoice type is recognized. Create one to get started, then generate journal entries for all your invoices at once.</p>
              <button onClick={() => setTab("settings")}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors">
                Create Revenue Stream →
              </button>
            </div>
          ) : contracts.filter(c => !c.revenue_stream_id).length > 0 ? (
            <div className="mb-4 bg-gray-900 border border-yellow-800/50 rounded-xl px-5 py-4">
              <p className="text-sm font-medium text-yellow-300 mb-1">
                {contracts.filter(c => !c.revenue_stream_id).length} unmatched contract{contracts.filter(c => !c.revenue_stream_id).length !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-gray-400 mb-3">Assign them to a revenue stream to generate journal entries.</p>
              <div className="flex items-center gap-2">
                <select value={selectedStreamForMatch} onChange={(e) => setSelectedStreamForMatch(e.target.value === "" ? "" : Number(e.target.value))}
                  className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="">Select stream…</option>
                  {streams.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button onClick={handleBulkMatch} disabled={!selectedStreamForMatch || bulkMatching}
                  className="px-4 py-1.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                  {bulkMatching ? "Matching…" : "Match All"}
                </button>
              </div>
            </div>
          ) : contracts.some(c => c.schedule.some(e => !e.je_id)) ? (
            <div className="mb-4 bg-gray-900 border border-green-800/50 rounded-xl px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-green-300">Ready to generate journal entries</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {contracts.reduce((n, c) => n + c.schedule.filter(e => !e.je_id).length, 0)} pending entr{contracts.reduce((n, c) => n + c.schedule.filter(e => !e.je_id).length, 0) !== 1 ? "ies" : "y"} across {contracts.filter(c => c.schedule.some(e => !e.je_id)).length} contracts
                </p>
              </div>
              <button onClick={handleGenerateAll} disabled={generatingAll}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {generatingAll ? "Generating…" : "Generate All JEs"}
              </button>
            </div>
          ) : null}
          <ScheduleTab
            contracts={contracts}
            streamMap={streamMap}
            expanded={expanded}
            setExpanded={setExpanded}
            generatingJe={generatingJe}
            onGenerateJes={handleGenerateJes}
            onStatusChange={handleStatusChange}
            onDelete={handleDelete}
          />
        </>
      )}
      {tab === "ar-aging" && <ArAgingTab rows={arAging} />}
      {tab === "settings" && (
        <SettingsTab
          clientId={clientId}
          streams={streams}
          settings={settings}
          onSaved={(m) => { setMsg(m); load(); }}
          onError={(e) => setError(e)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

// ── Recognition Schedule Tab ──────────────────────────────────────────────────

function ScheduleTab({ contracts, streamMap, expanded, setExpanded, generatingJe, onGenerateJes, onStatusChange, onDelete }: {
  contracts: RevenueContract[];
  streamMap: Record<number, RevenueStream>;
  expanded: number | null;
  setExpanded: (id: number | null) => void;
  generatingJe: number | null;
  onGenerateJes: (id: number) => void;
  onStatusChange: (c: RevenueContract, status: string) => void;
  onDelete: (id: number) => void;
}) {
  if (contracts.length === 0) {
    return (
      <div className="text-center py-20 text-gray-500">
        No revenue contracts yet. Configure revenue streams in the Settings tab, then sync your sources.
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
      <table className="w-full text-sm min-w-[1100px]">
        <thead>
          <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Invoice #</th>
            <th className="px-4 py-3">Stream</th>
            <th className="px-4 py-3">Billing Date</th>
            <th className="px-4 py-3">Service Period</th>
            <th className="px-4 py-3 text-right">Total</th>
            <th className="px-4 py-3 text-right">Recognized</th>
            <th className="px-4 py-3 text-right">Deferred</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c) => {
            const stream = c.revenue_stream_id ? streamMap[c.revenue_stream_id] : null;
            const pendingEntries = c.schedule.filter((e) => !e.je_id).length;
            const isExpanded = expanded === c.id;
            return (
              <>
                <tr
                  key={c.id}
                  onClick={() => setExpanded(isExpanded ? null : c.id)}
                  className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/30 cursor-pointer transition-colors ${isExpanded ? "bg-gray-800/50" : ""}`}
                >
                  <td className="px-4 py-3">
                    <p className="text-white text-xs font-medium">{c.customer_name}</p>
                    <p className="text-gray-500 text-xs">{c.source}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">{c.invoice_number || "—"}</td>
                  <td className="px-4 py-3 text-xs">
                    {stream ? (
                      <div>
                        <p className="text-gray-300">{stream.name}</p>
                        <p className="text-gray-500">{BILLING_TYPE_LABELS[stream.billing_type]}</p>
                      </div>
                    ) : (
                      <span className="text-yellow-500 text-xs">⚠ Unmatched</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(c.billing_date)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {c.service_period_start && c.service_period_end
                      ? `${fmtDate(c.service_period_start)} – ${fmtDate(c.service_period_end)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-white">{fmt(c.total_contract_value)}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-green-400">{fmt(c.amount_recognized)}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-yellow-400">{fmt(c.amount_deferred)}</td>
                  <td className="px-4 py-3">
                    <select
                      value={c.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); onStatusChange(c, e.target.value); }}
                      className={`text-xs rounded-full px-2 py-0.5 border font-medium bg-transparent cursor-pointer ${STATUS_BADGE[c.status] ?? "text-gray-400 border-gray-700"}`}
                    >
                      <option value="active">Active</option>
                      <option value="fully_recognized">Fully Recognized</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-2 items-center">
                      {pendingEntries > 0 && (
                        <button
                          onClick={() => onGenerateJes(c.id)}
                          disabled={generatingJe === c.id}
                          className="text-xs px-2 py-1 bg-indigo-800 hover:bg-indigo-700 text-indigo-200 rounded transition-colors disabled:opacity-50"
                        >
                          {generatingJe === c.id ? "…" : `Gen JEs (${pendingEntries})`}
                        </button>
                      )}
                      <button onClick={() => onDelete(c.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Del</button>
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${c.id}-exp`} className="border-b border-gray-800 bg-gray-800/20">
                    <td colSpan={10} className="px-6 py-4">
                      <div className="grid grid-cols-3 gap-6">
                        <div className="col-span-2">
                          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Recognition Schedule</p>
                          {c.schedule.length === 0 ? (
                            <p className="text-gray-500 text-xs">No schedule — configure service period and stream to generate.</p>
                          ) : (
                            <div className="grid grid-cols-4 gap-1">
                              {c.schedule.map((e) => (
                                <div key={e.id} className={`rounded px-2 py-1 text-xs flex items-center justify-between ${e.recognized ? "bg-green-900/40 text-green-400" : e.je_id ? "bg-indigo-900/40 text-indigo-300" : "bg-gray-800 text-gray-400"}`}>
                                  <span className="font-mono">{fmtMonth(e.period)}</span>
                                  <span className="font-mono">{fmt(e.amount)}</span>
                                  {e.je_id && <span className="ml-1 text-[10px]">{e.recognized ? "✓" : "⏳"}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1.5 text-xs">
                          <p className="text-gray-400 font-medium uppercase tracking-wider mb-2">Details</p>
                          <DetailRow label="Payment" value={c.payment_received ? `Received ${fmtDate(c.payment_date)}` : "Not received"} />
                          <DetailRow label="Source" value={c.source} />
                          {c.ai_confidence !== null && <DetailRow label="AI Confidence" value={`${Math.round((c.ai_confidence ?? 0) * 100)}%`} />}
                          {c.ai_reasoning && <p className="text-gray-500 italic mt-1">{c.ai_reasoning}</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 w-28 shrink-0">{label}:</span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}

// ── AR Aging Tab ──────────────────────────────────────────────────────────────

function ArAgingTab({ rows }: { rows: ArAgingRow[] }) {
  if (rows.length === 0) {
    return <div className="text-center py-20 text-gray-500">No outstanding AR. All invoices are paid or no invoices imported yet.</div>;
  }

  const buckets = ["current", "1-30", "31-60", "61-90", "over-90"] as const;
  const totals = Object.fromEntries(buckets.map((b) => [b, rows.filter((r) => r.aging_bucket === b).reduce((s, r) => s + r.amount, 0)]));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-3">
        {buckets.map((b) => (
          <div key={b} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">{b === "current" ? "Current" : b === "over-90" ? "Over 90 days" : `${b} days`}</p>
            <p className={`text-lg font-bold ${totals[b] > 0 ? AGING_BADGE[b].split(" ")[1] : "text-gray-500"}`}>{fmt(totals[b])}</p>
          </div>
        ))}
      </div>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Invoice #</th>
              <th className="px-4 py-3">Invoice Date</th>
              <th className="px-4 py-3">Due Date</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">Days Out</th>
              <th className="px-4 py-3">Aging</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3 text-white text-xs font-medium">{r.customer_name}</td>
                <td className="px-4 py-3 text-gray-400 text-xs font-mono">{r.invoice_number || "—"}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(r.billing_date)}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(r.due_date)}</td>
                <td className="px-4 py-3 text-right text-xs font-mono text-white">{fmt(r.amount)}</td>
                <td className="px-4 py-3 text-right text-xs font-mono text-gray-300">{r.days_outstanding}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${AGING_BADGE[r.aging_bucket] ?? "bg-gray-800 text-gray-400"}`}>
                    {r.aging_bucket === "current" ? "Current" : r.aging_bucket === "over-90" ? "90+" : `${r.aging_bucket} days`}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs capitalize">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

function SettingsTab({ clientId, streams, settings, onSaved, onError }: {
  clientId: number;
  streams: RevenueStream[];
  settings: RevenueIntegrationSettings | null;
  onSaved: (msg: string) => void;
  onError: (e: string) => void;
}) {
  const [localStreams, setLocalStreams] = useState<RevenueStream[]>(streams);
  const [showStreamForm, setShowStreamForm] = useState(false);
  const [streamForm, setStreamForm] = useState({
    name: "", billing_type: "annual_upfront" as BillingType,
    revenue_account: "", deferred_revenue_account: "Deferred Revenue", ar_account: "Accounts Receivable",
  });
  const [saving, setSaving] = useState(false);
  const [intForm, setIntForm] = useState({
    mercury_revenue_enabled: settings?.mercury_revenue_enabled ?? false,
    stripe_enabled: settings?.stripe_enabled ?? false, stripe_api_key: "",
    billcom_enabled: settings?.billcom_enabled ?? false, billcom_username: settings?.billcom_username ?? "",
    billcom_password: "", billcom_org_id: settings?.billcom_org_id ?? "", billcom_dev_key: "",
  });

  useEffect(() => {
    setLocalStreams(streams);
  }, [streams]);

  useEffect(() => {
    if (settings) {
      setIntForm((f) => ({
        ...f,
        mercury_revenue_enabled: settings.mercury_revenue_enabled,
        stripe_enabled: settings.stripe_enabled,
        billcom_enabled: settings.billcom_enabled,
        billcom_username: settings.billcom_username ?? "",
        billcom_org_id: settings.billcom_org_id ?? "",
      }));
    }
  }, [settings]);

  async function handleCreateStream(e: React.FormEvent) {
    e.preventDefault();
    try {
      const s = await createRevenueStream(clientId, streamForm);
      setLocalStreams((prev) => [...prev, s]);
      setStreamForm({ name: "", billing_type: "annual_upfront", revenue_account: "", deferred_revenue_account: "Deferred Revenue", ar_account: "Accounts Receivable" });
      setShowStreamForm(false);
      onSaved("Revenue stream created.");
    } catch (e: unknown) { onError(e instanceof Error ? e.message : "Failed to create"); }
  }

  async function handleToggleStream(stream: RevenueStream) {
    try {
      const updated = await updateRevenueStream(clientId, stream.id, { active: !stream.active });
      setLocalStreams((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    } catch (e: unknown) { onError(e instanceof Error ? e.message : "Failed to update"); }
  }

  async function handleDeleteStream(id: number) {
    if (!confirm("Delete this revenue stream?")) return;
    try {
      await deleteRevenueStream(clientId, id);
      setLocalStreams((prev) => prev.filter((s) => s.id !== id));
    } catch (e: unknown) { onError(e instanceof Error ? e.message : "Failed to delete"); }
  }

  async function handleSaveIntegrations(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        mercury_revenue_enabled: intForm.mercury_revenue_enabled,
        stripe_enabled: intForm.stripe_enabled,
        billcom_enabled: intForm.billcom_enabled,
        billcom_username: intForm.billcom_username || undefined,
        billcom_org_id: intForm.billcom_org_id || undefined,
      };
      if (intForm.stripe_api_key) payload.stripe_api_key = intForm.stripe_api_key;
      if (intForm.billcom_password) payload.billcom_password = intForm.billcom_password;
      if (intForm.billcom_dev_key) payload.billcom_dev_key = intForm.billcom_dev_key;
      await updateRevenueIntegrationSettings(clientId, payload);
      onSaved("Integration settings saved.");
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* Revenue Streams */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-white">Revenue Streams</h2>
            <p className="text-xs text-gray-500 mt-0.5">Define billing models for each type of revenue this client generates</p>
          </div>
          <button onClick={() => setShowStreamForm(!showStreamForm)}
            className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">
            + New Stream
          </button>
        </div>

        {showStreamForm && (
          <div className="mb-4 bg-gray-900 border border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-3">New Revenue Stream</h3>
            <form onSubmit={handleCreateStream} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Stream Name</label>
                  <input required placeholder="e.g. Annual SaaS Subscriptions" value={streamForm.name}
                    onChange={(e) => setStreamForm({ ...streamForm, name: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Billing Type</label>
                  <select value={streamForm.billing_type}
                    onChange={(e) => setStreamForm({ ...streamForm, billing_type: e.target.value as BillingType })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
                    {BILLING_TYPES.map((t) => <option key={t} value={t}>{BILLING_TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Revenue Account</label>
                  <input required placeholder="e.g. SaaS Revenue" value={streamForm.revenue_account}
                    onChange={(e) => setStreamForm({ ...streamForm, revenue_account: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Deferred Revenue Account</label>
                  <input required placeholder="Deferred Revenue" value={streamForm.deferred_revenue_account}
                    onChange={(e) => setStreamForm({ ...streamForm, deferred_revenue_account: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Accounts Receivable Account</label>
                  <input required placeholder="Accounts Receivable" value={streamForm.ar_account}
                    onChange={(e) => setStreamForm({ ...streamForm, ar_account: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowStreamForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">Create Stream</button>
              </div>
            </form>
          </div>
        )}

        {localStreams.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-10 text-center text-gray-500 text-sm">
            No revenue streams configured yet.
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-400 font-medium">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Billing Model</th>
                  <th className="px-4 py-3">Revenue Account</th>
                  <th className="px-4 py-3">Deferred Account</th>
                  <th className="px-4 py-3">Active</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {localStreams.map((s) => (
                  <tr key={s.id} className={`border-b border-gray-800 last:border-0 ${!s.active ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3 text-white text-xs font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{BILLING_TYPE_LABELS[s.billing_type]}</td>
                    <td className="px-4 py-3 text-gray-300 text-xs">{s.revenue_account}</td>
                    <td className="px-4 py-3 text-gray-300 text-xs">{s.deferred_revenue_account}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleToggleStream(s)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${s.active ? "bg-indigo-600" : "bg-gray-700"}`}>
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${s.active ? "translate-x-4" : "translate-x-1"}`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleDeleteStream(s.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Integrations */}
      <section>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-white">Data Source Integrations</h2>
          <p className="text-xs text-gray-500 mt-0.5">Enable the revenue data sources that apply to this client</p>
        </div>
        <form onSubmit={handleSaveIntegrations} className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-6">
          {localStreams.length === 0 && (
            <div className="bg-yellow-950 border border-yellow-800 rounded-lg px-4 py-3 mb-4">
              <p className="text-xs font-medium text-yellow-300 mb-0.5">No revenue streams configured</p>
              <p className="text-xs text-yellow-500">Create at least one stream above before enabling integrations — streams are required to classify and generate journal entries for imported invoices.</p>
            </div>
          )}
          <IntegrationSection title="Mercury" description="Pull incoming Mercury payments as revenue contracts"
            enabled={intForm.mercury_revenue_enabled} onToggle={(v) => setIntForm({ ...intForm, mercury_revenue_enabled: v })}
            lastSync={null}>
            <p className="text-xs text-gray-500 mt-2">Mercury is already connected — no additional credentials needed.</p>
          </IntegrationSection>

          <div className="border-t border-gray-800" />

          <IntegrationSection title="Stripe" description="Pull invoices, subscriptions, charges, and refunds from Stripe"
            enabled={intForm.stripe_enabled} onToggle={(v) => setIntForm({ ...intForm, stripe_enabled: v })}
            lastSync={settings?.last_stripe_sync ?? null}>
            {intForm.stripe_enabled && (
              <div className="mt-3">
                <label className="text-xs text-gray-400 mb-1 block">Stripe Secret Key</label>
                <input type="password"
                  placeholder={settings?.stripe_api_key ? "••••••• (saved — enter new key to update)" : "sk_live_..."}
                  value={intForm.stripe_api_key}
                  onChange={(e) => setIntForm({ ...intForm, stripe_api_key: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
              </div>
            )}
          </IntegrationSection>

          <div className="border-t border-gray-800" />

          <IntegrationSection title="Bill.com" description="Pull AR invoices, payment status, and customer details from Bill.com"
            enabled={intForm.billcom_enabled} onToggle={(v) => setIntForm({ ...intForm, billcom_enabled: v })}
            lastSync={settings?.last_billcom_sync ?? null}>
            {intForm.billcom_enabled && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Username</label>
                  <input placeholder="email@company.com" value={intForm.billcom_username}
                    onChange={(e) => setIntForm({ ...intForm, billcom_username: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Password</label>
                  <input type="password" placeholder="••••••••" value={intForm.billcom_password}
                    onChange={(e) => setIntForm({ ...intForm, billcom_password: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Organization ID</label>
                  <input placeholder="00000000000000000" value={intForm.billcom_org_id}
                    onChange={(e) => setIntForm({ ...intForm, billcom_org_id: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Developer Key</label>
                  <input type="password" placeholder="••••••••" value={intForm.billcom_dev_key}
                    onChange={(e) => setIntForm({ ...intForm, billcom_dev_key: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
            )}
          </IntegrationSection>

          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? "Saving…" : "Save Integration Settings"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function IntegrationSection({ title, description, enabled, onToggle, lastSync, children }: {
  title: string; description: string; enabled: boolean;
  onToggle: (v: boolean) => void; lastSync: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          {lastSync && <p className="text-xs text-gray-600 mt-0.5">Last sync: {new Date(lastSync).toLocaleString()}</p>}
        </div>
        <button type="button" onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? "bg-indigo-600" : "bg-gray-700"}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {children}
    </div>
  );
}
