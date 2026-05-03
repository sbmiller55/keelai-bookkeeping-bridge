"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getClient, updateClient, uploadFile, Client, getQboStatus, getQboAuthUrl, disconnectQbo, QboStatus, getQboAccounts, ensureQboAccounts, getRevenueIntegrationSettings, updateRevenueIntegrationSettings, testBillcomConnection, RevenueIntegrationSettings } from "@/lib/api";

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

  const [chartUploading, setChartUploading] = useState(false);
  const [policyUploading, setPolicyUploading] = useState(false);
  const [chartName, setChartName] = useState<string | null>(null);
  const [policyName, setPolicyName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [qboSyncing, setQboSyncing] = useState(false);
  const [qboSyncResult, setQboSyncResult] = useState<string | null>(null);
  const [qboEnsuring, setQboEnsuring] = useState(false);
  const [qboEnsureResult, setQboEnsureResult] = useState<string | null>(null);

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

  useEffect(() => {
    getClient(clientId).then((c) => {
      setClient(c);
      setMercuryKey(c.mercury_api_key_encrypted ?? "");
      setChartName(c.chart_of_accounts_path ? c.chart_of_accounts_path.split("/").pop() ?? null : null);
      setPolicyName(c.policy_path ? c.policy_path.split("/").pop() ?? null : null);
    }).finally(() => setLoading(false));
    getQboStatus(clientId).then(setQboStatus).catch(() => {});
    getRevenueIntegrationSettings(clientId).then((s) => {
      setBillcomSettings(s);
      setBillcomForm({ username: s.billcom_username ?? "", password: "", org_id: s.billcom_org_id ?? "", dev_key: "", enabled: s.billcom_enabled });
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

  async function handleUpload(file: File, field: "chart_of_accounts_path" | "policy_path") {
    const setUploading = field === "chart_of_accounts_path" ? setChartUploading : setPolicyUploading;
    const setName = field === "chart_of_accounts_path" ? setChartName : setPolicyName;
    setUploading(true);
    setUploadError(null);
    try {
      const { path, filename } = await uploadFile(file);
      const updated = await updateClient(clientId, { [field]: path });
      setClient(updated);
      setName(filename);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemoveChart() {
    await updateClient(clientId, { chart_of_accounts_path: null });
    setChartName(null);
    setQboSyncResult(null);
  }

  async function handleQboSync() {
    setQboSyncing(true);
    setQboSyncResult(null);
    try {
      const accounts = await getQboAccounts(clientId);
      setQboSyncResult(`${accounts.length} accounts synced from QBO`);
    } catch (err: unknown) {
      setQboSyncResult(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setQboSyncing(false);
    }
  }

  async function handleEnsureAccounts() {
    setQboEnsuring(true);
    setQboEnsureResult(null);
    try {
      const result = await ensureQboAccounts(clientId);
      const msgs = [];
      if (result.created.length > 0) msgs.push(`Created: ${result.created.join(", ")}`);
      if (result.already_existed.length > 0) msgs.push(`Already existed: ${result.already_existed.length}`);
      if (result.errors.length > 0) msgs.push(`Errors: ${result.errors.join("; ")}`);
      setQboEnsureResult(msgs.join(" · ") || "Done");
    } catch (err: unknown) {
      setQboEnsureResult(err instanceof Error ? err.message : "Failed");
    } finally {
      setQboEnsuring(false);
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
              <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
              <span className="text-sm text-green-400 font-medium">Connected</span>
              <span className="text-xs text-gray-500 ml-1">Realm: {qboStatus.realm_id}</span>
            </div>
            <div>
              <button
                onClick={handleEnsureAccounts}
                disabled={qboEnsuring}
                className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                {qboEnsuring
                  ? <><span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />Setting up…</>
                  : "Set up depreciation & amortization accounts in QBO"}
              </button>
              {qboEnsureResult && (
                <p className="text-xs text-gray-400 mt-1.5">{qboEnsureResult}</p>
              )}
            </div>
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
          <div>
            <UploadField
              label="Chart of Accounts"
              accept=".csv,.xlsx,.xls,.pdf,.txt"
              fileName={chartName}
              uploading={chartUploading}
              onSelect={(f) => handleUpload(f, "chart_of_accounts_path")}
              onRemove={chartName ? handleRemoveChart : undefined}
            />
            {qboStatus?.connected && (
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={handleQboSync}
                  disabled={qboSyncing}
                  className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {qboSyncing
                    ? <><span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />Syncing…</>
                    : <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Sync accounts from QBO
                      </>}
                </button>
                {qboSyncResult && (
                  <span className="text-xs text-green-400">{qboSyncResult}</span>
                )}
              </div>
            )}
          </div>
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
