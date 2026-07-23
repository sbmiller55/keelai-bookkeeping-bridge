"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getClient, updateClient, uploadFile, Client, getQboStatus, getQboAuthUrl, disconnectQbo, QboStatus, getQboAccounts, getRevenueIntegrationSettings, updateRevenueIntegrationSettings, testBillcomConnection, RevenueIntegrationSettings, getStripeSettings, updateStripeSettings, testStripeConnection, StripeConfig } from "@/lib/api";
import { useAccounts } from "@/lib/useAccounts";

// Simple account picker backed by the live QBO chart of accounts. Falls back to
// a free-text input when QBO isn't connected yet (so the field is still usable).
function AccountPicker({
  value, onChange, accounts, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  accounts: string[];
  placeholder: string;
}) {
  const cls = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500";
  if (!accounts.length) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cls} />;
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cls}>
      <option value="">{placeholder}</option>
      {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );
}

function UploadField({
  label,
  accept,
  fileName,
  uploading,
  onSelect,
  onRemove,
}: {
  label: string;
  accept: string;
  fileName: string | null;
  uploading: boolean;
  onSelect: (file: File) => void;
  onRemove?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <p className="text-sm font-medium text-gray-300 mb-1.5">{label}</p>
      <input ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onSelect(f); e.target.value = ""; }} />
      {fileName && !uploading ? (
        <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm text-white truncate">{fileName}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-3">
            <button type="button" onClick={() => ref.current?.click()}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              Replace
            </button>
            {onRemove && (
              <button type="button" onClick={onRemove}
                className="text-xs text-red-500 hover:text-red-400 transition-colors">
                Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} disabled={uploading}
          className="w-full flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-left hover:border-gray-500 transition-colors disabled:opacity-60">
          {uploading
            ? <span className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
            : <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>}
          <span className="text-sm text-gray-500">{uploading ? "Uploading…" : "Choose file…"}</span>
        </button>
      )}
    </div>
  );
}

export default function ClientSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  const [mercuryKey, setMercuryKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  const [policyUploading, setPolicyUploading] = useState(false);
  const [policyName, setPolicyName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [qboSyncing, setQboSyncing] = useState(false);
  const [qboSyncResult, setQboSyncResult] = useState<string | null>(null);

  const [qboStatus, setQboStatus] = useState<QboStatus | null>(null);
  const [qboConnecting, setQboConnecting] = useState(false);
  const [qboDisconnecting, setQboDisconnecting] = useState(false);
  const [qboError, setQboError] = useState<string | null>(null);

  const [billcomSettings, setBillcomSettings] = useState<RevenueIntegrationSettings | null>(null);
  const [billcomForm, setBillcomForm] = useState({ username: "", password: "", org_id: "", dev_key: "", enabled: false });
  const [billcomSaving, setBillcomSaving] = useState(false);
  const [billcomSaved, setBillcomSaved] = useState(false);
  const [billcomTesting, setBillcomTesting] = useState(false);
  const [billcomTestMsg, setBillcomTestMsg] = useState<string | null>(null);
  const [billcomError, setBillcomError] = useState<string | null>(null);

  const { accounts } = useAccounts(clientId);
  const [stripeSettings, setStripeSettings] = useState<StripeConfig | null>(null);
  const [stripeForm, setStripeForm] = useState({
    enabled: false,
    api_key: "",
    treatment: "gross_plus_fees" as StripeConfig["treatment"],
    granularity: "per_charge" as StripeConfig["granularity"],
    recognition_timing: "charge_date" as StripeConfig["recognition_timing"],
    attribute_customer: true,
    revenue_account: "",
    stripe_fees_account: "",
    stripe_clearing_account: "Stripe Clearing",
    bank_account: "",
    payout_match_text: "stripe",
  });
  const [stripeSaving, setStripeSaving] = useState(false);
  const [stripeSaved, setStripeSaved] = useState(false);
  const [stripeTesting, setStripeTesting] = useState(false);
  const [stripeTestMsg, setStripeTestMsg] = useState<string | null>(null);
  const [stripeError, setStripeError] = useState<string | null>(null);

  useEffect(() => {
    getClient(clientId).then((c) => {
      setClient(c);
      setMercuryKey(c.mercury_api_key_encrypted ?? "");
      setPolicyName(c.policy_path ? c.policy_path.split("/").pop() ?? null : null);
    }).finally(() => setLoading(false));
    getQboStatus(clientId).then(setQboStatus).catch(() => {});
    getRevenueIntegrationSettings(clientId).then((s) => {
      setBillcomSettings(s);
      setBillcomForm({ username: s.billcom_username ?? "", password: "", org_id: s.billcom_org_id ?? "", dev_key: "", enabled: s.billcom_enabled });
    }).catch(() => {});
    getStripeSettings(clientId).then((s) => {
      setStripeSettings(s);
      setStripeForm({
        enabled: s.enabled,
        api_key: "",
        treatment: s.treatment,
        granularity: s.granularity,
        recognition_timing: s.recognition_timing,
        attribute_customer: s.attribute_customer,
        revenue_account: s.revenue_account ?? "",
        stripe_fees_account: s.stripe_fees_account ?? "",
        stripe_clearing_account: s.stripe_clearing_account ?? "Stripe Clearing",
        bank_account: s.bank_account ?? "",
        payout_match_text: s.payout_match_text ?? "stripe",
      });
    }).catch(() => {});

    // Refresh QBO status when the tab regains focus (user closes callback tab)
    function onFocus() {
      getQboStatus(clientId).then(setQboStatus).catch(() => {});
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clientId]);

  async function handleQboConnect() {
    setQboConnecting(true);
    setQboError(null);
    try {
      const { url } = await getQboAuthUrl(clientId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      setQboError(err instanceof Error ? err.message : "Failed to start QBO connection");
    } finally {
      setQboConnecting(false);
    }
  }

  async function handleQboDisconnect() {
    if (!confirm("Disconnect QuickBooks Online? You'll need to reconnect to sync directly.")) return;
    setQboDisconnecting(true);
    try {
      await disconnectQbo(clientId);
      setQboStatus({ connected: false, realm_id: null, token_expires_at: null });
    } catch (err: unknown) {
      setQboError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setQboDisconnecting(false);
    }
  }

  async function saveMercuryKey() {
    setSavingKey(true);
    setKeySaved(false);
    try {
      const updated = await updateClient(clientId, { mercury_api_key_encrypted: mercuryKey });
      setClient(updated);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 3000);
    } finally {
      setSavingKey(false);
    }
  }

  async function handleUpload(file: File, field: "policy_path") {
    setPolicyUploading(true);
    setUploadError(null);
    try {
      const { path, filename } = await uploadFile(file);
      const updated = await updateClient(clientId, { [field]: path });
      setClient(updated);
      setPolicyName(filename);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPolicyUploading(false);
    }
  }

  async function handleQboSync() {
    setQboSyncing(true);
    setQboSyncResult(null);
    try {
      const accounts = await getQboAccounts(clientId, /* refresh */ true);
      setQboSyncResult(`${accounts.length} accounts refreshed from QBO`);
    } catch (err: unknown) {
      setQboSyncResult(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setQboSyncing(false);
    }
  }

  async function handleSaveBillcom() {
    setBillcomSaving(true);
    setBillcomError(null);
    setBillcomSaved(false);
    try {
      const payload: Record<string, unknown> = {
        billcom_enabled: billcomForm.enabled,
        billcom_username: billcomForm.username || undefined,
        billcom_org_id: billcomForm.org_id || undefined,
      };
      if (billcomForm.password) payload.billcom_password = billcomForm.password;
      if (billcomForm.dev_key) payload.billcom_dev_key = billcomForm.dev_key;
      await updateRevenueIntegrationSettings(clientId, payload);
      setBillcomSaved(true);
      setBillcomTestMsg(null);
      setTimeout(() => setBillcomSaved(false), 3000);
    } catch (e: unknown) {
      setBillcomError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBillcomSaving(false);
    }
  }

  async function handleTestBillcom() {
    setBillcomTesting(true);
    setBillcomTestMsg(null);
    try {
      const result = await testBillcomConnection(clientId);
      setBillcomTestMsg(result.ok ? "Connected successfully" : "Connection failed");
    } catch (e: unknown) {
      setBillcomTestMsg(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setBillcomTesting(false);
    }
  }

  async function handleSaveStripe() {
    setStripeSaving(true);
    setStripeError(null);
    setStripeSaved(false);
    try {
      const payload: Record<string, unknown> = {
        enabled: stripeForm.enabled,
        treatment: stripeForm.treatment,
        granularity: stripeForm.granularity,
        recognition_timing: stripeForm.recognition_timing,
        attribute_customer: stripeForm.attribute_customer,
        revenue_account: stripeForm.revenue_account || null,
        stripe_fees_account: stripeForm.stripe_fees_account || null,
        stripe_clearing_account: stripeForm.stripe_clearing_account || null,
        bank_account: stripeForm.bank_account || null,
        payout_match_text: stripeForm.payout_match_text || "stripe",
      };
      // Only send the key when the user typed a new one, so the saved key
      // isn't wiped when the masked field is left untouched.
      if (stripeForm.api_key) payload.stripe_api_key = stripeForm.api_key;
      await updateStripeSettings(clientId, payload);
      const fresh = await getStripeSettings(clientId);
      setStripeSettings(fresh);
      setStripeForm((f) => ({ ...f, api_key: "" }));
      setStripeSaved(true);
      setStripeTestMsg(null);
      setTimeout(() => setStripeSaved(false), 3000);
    } catch (e: unknown) {
      setStripeError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setStripeSaving(false);
    }
  }

  async function handleTestStripe() {
    setStripeTesting(true);
    setStripeTestMsg(null);
    try {
      const result = await testStripeConnection(clientId);
      setStripeTestMsg(result.ok ? "Connected successfully" : "Connection failed");
    } catch (e: unknown) {
      setStripeTestMsg(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setStripeTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">{client?.name}</h1>
        <p className="text-gray-400 mt-1 text-sm">Settings</p>
      </div>

      {/* Mercury API Key */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-base font-semibold text-white mb-1">Mercury API Key</h2>
        <p className="text-xs text-gray-500 mb-4">Used when syncing transactions for this client.</p>
        <div className="flex gap-2">
          <input
            type="password"
            value={mercuryKey}
            onChange={(e) => setMercuryKey(e.target.value)}
            placeholder="secret-token:mercury_production_…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            onClick={saveMercuryKey}
            disabled={savingKey}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            {savingKey ? "Saving…" : keySaved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </section>

      {/* Stripe Integration */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold text-white">Stripe Revenue</h2>
          <button type="button"
            onClick={() => setStripeForm((f) => ({ ...f, enabled: !f.enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stripeForm.enabled ? "bg-indigo-600" : "bg-gray-700"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${stripeForm.enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Record Stripe revenue into the coding pipeline. Charges post gross revenue with
          Stripe fees broken out; payouts clear against the bank automatically.
        </p>
        {stripeError && <p className="text-red-400 text-xs mb-3">{stripeError}</p>}

        {/* API key */}
        <label className="text-xs text-gray-400 mb-1 block">Restricted API key</label>
        <input
          type="password"
          value={stripeForm.api_key}
          onChange={(e) => setStripeForm((f) => ({ ...f, api_key: e.target.value }))}
          placeholder={stripeSettings?.stripe_api_key ? "••••••• (saved — enter a new key to replace)" : "rk_live_…"}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-1"
        />
        <p className="text-[11px] text-gray-600 mb-4">
          Create a <span className="text-gray-400">restricted</span> key in Stripe → Developers → API keys,
          with <span className="text-gray-400">Read</span> access to Charges, Balance transactions, Payouts, and Customers.
        </p>

        {/* Treatment / granularity / timing */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Fee treatment</label>
            <select value={stripeForm.treatment}
              onChange={(e) => setStripeForm((f) => ({ ...f, treatment: e.target.value as StripeConfig["treatment"] }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
              <option value="gross_plus_fees">Gross revenue, fees as expense (GAAP)</option>
              <option value="net">Net of fees</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Granularity</label>
            <select value={stripeForm.granularity}
              onChange={(e) => setStripeForm((f) => ({ ...f, granularity: e.target.value as StripeConfig["granularity"] }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
              <option value="per_charge">One entry per charge</option>
              <option value="per_payout">One summary per payout</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Recognize revenue</label>
            <select value={stripeForm.recognition_timing}
              onChange={(e) => setStripeForm((f) => ({ ...f, recognition_timing: e.target.value as StripeConfig["recognition_timing"] }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
              <option value="charge_date">On the charge date</option>
              <option value="available_on">When funds are available</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Customer attribution</label>
            <select value={stripeForm.attribute_customer ? "yes" : "no"}
              onChange={(e) => setStripeForm((f) => ({ ...f, attribute_customer: e.target.value === "yes" }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
              <option value="yes">Attribute each charge to a customer</option>
              <option value="no">No customer attribution</option>
            </select>
          </div>
        </div>

        {/* Account mappings */}
        {accounts.length === 0 && (
          <p className="text-[11px] text-amber-400/80 mb-2">
            Connect QuickBooks below to pick accounts from your chart of accounts. You can type names for now.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Revenue account</label>
            <AccountPicker value={stripeForm.revenue_account}
              onChange={(v) => setStripeForm((f) => ({ ...f, revenue_account: v }))}
              accounts={accounts} placeholder="Select income account…" />
          </div>
          {stripeForm.treatment === "gross_plus_fees" && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Stripe fees account</label>
              <AccountPicker value={stripeForm.stripe_fees_account}
                onChange={(v) => setStripeForm((f) => ({ ...f, stripe_fees_account: v }))}
                accounts={accounts} placeholder="Select expense account…" />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Stripe clearing account</label>
            <AccountPicker value={stripeForm.stripe_clearing_account}
              onChange={(v) => setStripeForm((f) => ({ ...f, stripe_clearing_account: v }))}
              accounts={accounts} placeholder="Select clearing account…" />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Bank account (payouts land here)</label>
            <AccountPicker value={stripeForm.bank_account}
              onChange={(v) => setStripeForm((f) => ({ ...f, bank_account: v }))}
              accounts={accounts} placeholder="Select bank account…" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={handleSaveStripe} disabled={stripeSaving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {stripeSaving ? "Saving…" : stripeSaved ? "Saved ✓" : "Save"}
          </button>
          <button type="button" onClick={handleTestStripe} disabled={stripeTesting}
            className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded-lg transition-colors">
            {stripeTesting ? "Testing…" : "Test Connection"}
          </button>
          {stripeTestMsg && (
            <span className={`text-xs ${stripeTestMsg.includes("success") ? "text-green-400" : "text-red-400"}`}>
              {stripeTestMsg}
            </span>
          )}
        </div>
      </section>

      {/* QuickBooks Online */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-base font-semibold text-white mb-1">QuickBooks Online</h2>
        <p className="text-xs text-gray-500 mb-4">
          Connect to sync journal entries directly to QBO and pull your live Chart of Accounts.
        </p>

        {qboError && <p className="text-red-400 text-xs mb-3">{qboError}</p>}

        {qboStatus?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${qboStatus.needs_reconnect ? "bg-amber-400" : "bg-green-400"}`} />
              <span className={`text-sm font-medium ${qboStatus.needs_reconnect ? "text-amber-300" : "text-green-400"}`}>
                {qboStatus.needs_reconnect ? "Connected, but reconnect required" : "Connected"}
              </span>
              <span className="text-xs text-gray-500 ml-1">Realm: {qboStatus.realm_id}</span>
            </div>
            {qboStatus.needs_reconnect && (
              <div className="bg-amber-950/40 border border-amber-900 rounded-lg p-3 text-xs text-amber-200">
                <p>{qboStatus.reconnect_reason ?? "QuickBooks credentials are stale. Disconnect and reconnect to restore the connection."}</p>
                <p className="text-amber-300/70 mt-1">Live QBO calls (account refresh, journal entry sync) will fail until you reconnect. The cached chart of accounts continues to work in the meantime.</p>
              </div>
            )}
            <button
              onClick={handleQboDisconnect}
              disabled={qboDisconnecting}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {qboDisconnecting ? "Disconnecting…" : "Disconnect QuickBooks"}
            </button>
          </div>
        ) : (
          <button
            onClick={handleQboConnect}
            disabled={qboConnecting}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#2CA01C] hover:bg-[#248017] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {qboConnecting ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
              </svg>
            )}
            {qboConnecting ? "Redirecting to QuickBooks…" : "Connect QuickBooks Online"}
          </button>
        )}
      </section>

      {/* Bill.com */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold text-white">Bill.com</h2>
          <button type="button"
            onClick={() => setBillcomForm((f) => ({ ...f, enabled: !f.enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${billcomForm.enabled ? "bg-indigo-600" : "bg-gray-700"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${billcomForm.enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Connect Bill.com to sync AR invoices and AP bills.</p>
        {billcomError && <p className="text-red-400 text-xs mb-3">{billcomError}</p>}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Username</label>
            <input placeholder="email@company.com" value={billcomForm.username}
              onChange={(e) => setBillcomForm((f) => ({ ...f, username: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Password</label>
            <input type="password"
              placeholder={billcomSettings?.billcom_username ? "••••••• (saved)" : "••••••••"}
              value={billcomForm.password}
              onChange={(e) => setBillcomForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Organization ID</label>
            <input placeholder="00802…" value={billcomForm.org_id}
              onChange={(e) => setBillcomForm((f) => ({ ...f, org_id: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Developer Key</label>
            <input type="password"
              placeholder={billcomSettings?.billcom_dev_key ? "••••••• (saved)" : "••••••••"}
              value={billcomForm.dev_key}
              onChange={(e) => setBillcomForm((f) => ({ ...f, dev_key: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={handleSaveBillcom} disabled={billcomSaving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {billcomSaving ? "Saving…" : billcomSaved ? "Saved ✓" : "Save"}
          </button>
          <button type="button" onClick={handleTestBillcom} disabled={billcomTesting}
            className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded-lg transition-colors">
            {billcomTesting ? "Testing…" : "Test Connection"}
          </button>
          {billcomTestMsg && (
            <span className={`text-xs ${billcomTestMsg.includes("success") ? "text-green-400" : "text-red-400"}`}>
              {billcomTestMsg}
            </span>
          )}
        </div>
      </section>

      {/* File uploads */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-base font-semibold text-white mb-1">Documents</h2>
        <p className="text-xs text-gray-500 mb-4">Chart of accounts and policy documents for this client.</p>

        {uploadError && <p className="text-red-400 text-xs mb-3">{uploadError}</p>}

        <div className="space-y-4">
          {qboStatus?.connected && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Chart of Accounts</label>
              <p className="text-xs text-gray-500 mb-2">
                Pulled live from QuickBooks Online. The cache refreshes automatically on the 1st of each month — use this button to refresh sooner.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleQboSync}
                  disabled={qboSyncing}
                  className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {qboSyncing
                    ? <><span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />Refreshing…</>
                    : <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Refresh accounts from QBO
                      </>}
                </button>
                {qboSyncResult && (
                  <span className="text-xs text-green-400">{qboSyncResult}</span>
                )}
              </div>
            </div>
          )}
          <UploadField
            label="Policy Document"
            accept=".pdf,.docx,.doc,.txt,.md"
            fileName={policyName}
            uploading={policyUploading}
            onSelect={(f) => handleUpload(f, "policy_path")}
          />
        </div>
      </section>
    </div>
  );
}
