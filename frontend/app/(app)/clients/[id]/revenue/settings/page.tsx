"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getRevenueStreams, createRevenueStream, updateRevenueStream, deleteRevenueStream,
  getRevenueIntegrationSettings, updateRevenueIntegrationSettings,
  testBillcomConnection,
  RevenueStream, RevenueIntegrationSettings,
  BillingType, BILLING_TYPE_LABELS,
} from "@/lib/api";

const BILLING_TYPES: BillingType[] = [
  "annual_upfront",
  "quarterly_upfront",
  "monthly_advance",
  "monthly_arrears",
  "invoice_completion",
];

export default function RevenueSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [streams, setStreams] = useState<RevenueStream[]>([]);
  const [settings, setSettings] = useState<RevenueIntegrationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testingBillcom, setTestingBillcom] = useState(false);
  const [billcomTestMsg, setBillcomTestMsg] = useState<string | null>(null);

  // Stream form
  const [showStreamForm, setShowStreamForm] = useState(false);
  const [streamForm, setStreamForm] = useState({
    name: "", billing_type: "annual_upfront" as BillingType,
    revenue_account: "", deferred_revenue_account: "Deferred Revenue", ar_account: "Accounts Receivable",
  });

  // Integration form (local copy for editing)
  const [intForm, setIntForm] = useState({
    mercury_revenue_enabled: false,
    stripe_enabled: false, stripe_api_key: "",
    billcom_enabled: false, billcom_username: "", billcom_password: "",
    billcom_org_id: "", billcom_dev_key: "",
  });

  useEffect(() => { load(); }, [clientId]);

  async function load() {
    setLoading(true);
    try {
      const [s, st] = await Promise.all([getRevenueStreams(clientId), getRevenueIntegrationSettings(clientId)]);
      setStreams(s);
      setSettings(st);
      setIntForm({
        mercury_revenue_enabled: st.mercury_revenue_enabled,
        stripe_enabled: st.stripe_enabled,
        stripe_api_key: "",  // never pre-fill masked key
        billcom_enabled: st.billcom_enabled,
        billcom_username: st.billcom_username || "",
        billcom_password: "",
        billcom_org_id: st.billcom_org_id || "",
        billcom_dev_key: "",
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateStream(e: React.FormEvent) {
    e.preventDefault();
    await createRevenueStream(clientId, streamForm);
    setStreamForm({ name: "", billing_type: "annual_upfront", revenue_account: "", deferred_revenue_account: "Deferred Revenue", ar_account: "Accounts Receivable" });
    setShowStreamForm(false);
    load();
  }

  async function handleToggleStream(stream: RevenueStream) {
    await updateRevenueStream(clientId, stream.id, { active: !stream.active });
    load();
  }

  async function handleDeleteStream(id: number) {
    if (!confirm("Delete this revenue stream?")) return;
    await deleteRevenueStream(clientId, id);
    load();
  }

  async function handleTestBillcom() {
    setTestingBillcom(true);
    setBillcomTestMsg(null);
    try {
      const result = await testBillcomConnection(clientId);
      setBillcomTestMsg(result.ok ? "Connected successfully" : "Connection failed");
    } catch (e: unknown) {
      setBillcomTestMsg(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTestingBillcom(false);
    }
  }

  async function handleSaveIntegrations(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setError(null);
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
      setMsg("Integration settings saved.");
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className="flex justify-center h-60 items-center">
      <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Revenue Settings</h1>
        <p className="text-gray-500 mt-1 text-xs">Configure revenue streams, billing models, and data source integrations</p>
      </div>

      {error && <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>}
      {msg && <div className="bg-green-950 border border-green-800 text-green-300 rounded-lg px-4 py-3 text-sm">{msg}</div>}

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

        {streams.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-10 text-center text-gray-500 text-sm">
            No revenue streams configured. Add one to get started.
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
                {streams.map((s) => (
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

      {/* Data Source Integrations */}
      <section>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-white">Data Source Integrations</h2>
          <p className="text-xs text-gray-500 mt-0.5">Enable the revenue data sources that apply to this client</p>
        </div>

        <form onSubmit={handleSaveIntegrations} className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-6">
          {/* Mercury */}
          <IntegrationSection
            title="Mercury"
            description="Pull incoming Mercury payments as revenue contracts"
            enabled={intForm.mercury_revenue_enabled}
            onToggle={(v) => setIntForm({ ...intForm, mercury_revenue_enabled: v })}
            lastSync={settings?.last_stripe_sync ?? null}
          >
            <p className="text-xs text-gray-500 mt-2">Mercury is already connected — no additional credentials needed.</p>
          </IntegrationSection>

          <div className="border-t border-gray-800" />

          {/* Stripe */}
          <IntegrationSection
            title="Stripe"
            description="Pull invoices, subscriptions, charges, and refunds from Stripe"
            enabled={intForm.stripe_enabled}
            onToggle={(v) => setIntForm({ ...intForm, stripe_enabled: v })}
            lastSync={settings?.last_stripe_sync ?? null}
          >
            {intForm.stripe_enabled && (
              <div className="mt-3">
                <label className="text-xs text-gray-400 mb-1 block">Stripe Secret Key</label>
                <input
                  type="password"
                  placeholder={settings?.stripe_api_key ? "••••••• (saved — enter new key to update)" : "sk_live_..."}
                  value={intForm.stripe_api_key}
                  onChange={(e) => setIntForm({ ...intForm, stripe_api_key: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}
          </IntegrationSection>

          <div className="border-t border-gray-800" />

          {/* Bill.com */}
          <IntegrationSection
            title="Bill.com"
            description="Pull AR invoices and AP bills from Bill.com"
            enabled={intForm.billcom_enabled}
            onToggle={(v) => setIntForm({ ...intForm, billcom_enabled: v })}
            lastSync={settings?.last_billcom_sync ?? null}
          >
            {intForm.billcom_enabled && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Username</label>
                    <input placeholder="email@company.com" value={intForm.billcom_username}
                      onChange={(e) => setIntForm({ ...intForm, billcom_username: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Password</label>
                    <input type="password" placeholder={settings?.billcom_username ? "••••••• (saved)" : "••••••••"} value={intForm.billcom_password}
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
                    <input type="password" placeholder={settings?.billcom_dev_key ? "••••••• (saved)" : "••••••••"} value={intForm.billcom_dev_key}
                      onChange={(e) => setIntForm({ ...intForm, billcom_dev_key: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={handleTestBillcom} disabled={testingBillcom}
                    className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded-lg transition-colors">
                    {testingBillcom ? "Testing…" : "Test Connection"}
                  </button>
                  {billcomTestMsg && (
                    <span className={`text-xs ${billcomTestMsg.includes("success") ? "text-green-400" : "text-red-400"}`}>
                      {billcomTestMsg}
                    </span>
                  )}
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
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  lastSync: string | null;
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
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? "bg-indigo-600" : "bg-gray-700"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {children}
    </div>
  );
}
