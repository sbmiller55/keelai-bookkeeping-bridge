"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getClients, createClient, deleteClient, uploadFile, Client } from "@/lib/api";

const EMPTY_FORM = {
  name: "",
  mercury_api_key_encrypted: "",
  qbo_oauth_token: "",
  chart_of_accounts_path: "",
  policy_path: "",
};

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const chartRef = useRef<HTMLInputElement>(null);
  const policyRef = useRef<HTMLInputElement>(null);
  const [chartFileName, setChartFileName] = useState<string | null>(null);
  const [policyFileName, setPolicyFileName] = useState<string | null>(null);
  const [chartUploading, setChartUploading] = useState(false);
  const [policyUploading, setPolicyUploading] = useState(false);

  useEffect(() => {
    getClients()
      .then(setClients)
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  async function handleFileUpload(file: File, field: "chart_of_accounts_path" | "policy_path") {
    const setUploading = field === "chart_of_accounts_path" ? setChartUploading : setPolicyUploading;
    const setName = field === "chart_of_accounts_path" ? setChartFileName : setPolicyFileName;
    setUploading(true);
    setFormError(null);
    try {
      const result = await uploadFile(file);
      setForm((prev) => ({ ...prev, [field]: result.path }));
      setName(result.filename);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        ...(form.mercury_api_key_encrypted && { mercury_api_key_encrypted: form.mercury_api_key_encrypted }),
        ...(form.qbo_oauth_token && { qbo_oauth_token: form.qbo_oauth_token }),
        ...(form.chart_of_accounts_path && { chart_of_accounts_path: form.chart_of_accounts_path }),
        ...(form.policy_path && { policy_path: form.policy_path }),
      };
      const newClient = await createClient(payload);
      setShowForm(false);
      setForm(EMPTY_FORM);
      setChartFileName(null);
      setPolicyFileName(null);
      router.push(`/clients/${newClient.id}`);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to create client");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    if (!confirm("Delete this client and all associated data?")) return;
    try {
      await deleteClient(id);
      setClients((prev) => prev.filter((c) => c.id !== id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete client");
    }
  }

  function cancelForm() {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setChartFileName(null);
    setPolicyFileName(null);
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">My Clients</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
        >
          {showForm ? "Cancel" : "+ Add New Client"}
        </button>
      </div>

      {/* Add client form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8 space-y-4"
        >
          <h2 className="text-base font-semibold text-white">New Client</h2>

          {formError && (
            <p className="text-red-400 text-sm">{formError}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Client Name <span className="text-red-400">*</span>
              </label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="Acme Corp"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Mercury API Key</label>
              <input
                value={form.mercury_api_key_encrypted}
                onChange={(e) => setForm({ ...form, mercury_api_key_encrypted: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="Optional"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">QBO OAuth Token</label>
              <input
                value={form.qbo_oauth_token}
                onChange={(e) => setForm({ ...form, qbo_oauth_token: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="Optional"
              />
            </div>

            {/* Chart of Accounts */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Chart of Accounts</label>
              <input ref={chartRef} type="file" accept=".csv,.xlsx,.xls,.pdf,.txt" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f, "chart_of_accounts_path"); e.target.value = ""; }} />
              {chartFileName ? (
                <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    <span className="text-sm text-white truncate">{chartFileName}</span>
                  </div>
                  <button type="button" onClick={() => chartRef.current?.click()} className="text-xs text-indigo-400 hover:text-indigo-300 shrink-0 ml-2">Replace</button>
                </div>
              ) : (
                <button type="button" onClick={() => chartRef.current?.click()} disabled={chartUploading}
                  className="w-full flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-left hover:border-gray-500 transition-colors disabled:opacity-60">
                  {chartUploading ? <span className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" /> :
                    <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>}
                  <span className="text-sm text-gray-500">{chartUploading ? "Uploading…" : "Choose file…"}</span>
                </button>
              )}
            </div>

            {/* Policy */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Policy Document</label>
              <input ref={policyRef} type="file" accept=".pdf,.docx,.doc,.txt,.md" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f, "policy_path"); e.target.value = ""; }} />
              {policyFileName ? (
                <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    <span className="text-sm text-white truncate">{policyFileName}</span>
                  </div>
                  <button type="button" onClick={() => policyRef.current?.click()} className="text-xs text-indigo-400 hover:text-indigo-300 shrink-0 ml-2">Replace</button>
                </div>
              ) : (
                <button type="button" onClick={() => policyRef.current?.click()} disabled={policyUploading}
                  className="w-full flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-left hover:border-gray-500 transition-colors disabled:opacity-60">
                  {policyUploading ? <span className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" /> :
                    <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>}
                  <span className="text-sm text-gray-500">{policyUploading ? "Uploading…" : "Choose file…"}</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-medium rounded-lg px-5 py-2.5 text-sm transition-colors">
              {submitting ? "Creating…" : "Create Client"}
            </button>
            <button type="button" onClick={cancelForm}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg px-5 py-2.5 text-sm transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Client list */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : clients.length === 0 ? (
        <div className="text-center py-24 text-gray-500">
          <p className="text-lg mb-2">No clients yet.</p>
          <p className="text-sm">Add your first client to get started.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {clients.map((client) => (
            <li key={client.id}>
              <button
                onClick={() => router.push(`/clients/${client.id}`)}
                className="w-full text-left bg-gray-900 border border-gray-800 rounded-xl px-6 py-5 hover:border-indigo-600 hover:bg-gray-900/80 transition-all group"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-semibold text-base group-hover:text-indigo-300 transition-colors">
                      {client.name}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Added {new Date(client.created_at).toLocaleDateString()}
                      {client.mercury_api_key_encrypted && " · Mercury connected"}
                      {client.chart_of_accounts_path && " · Chart uploaded"}
                      {client.policy_path && " · Policy uploaded"}
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-gray-600 group-hover:text-indigo-400 transition-colors shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
