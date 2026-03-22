"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getVendors, dismissVendors, Vendor } from "@/lib/api";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function triggerDownload(content: string, type: string, filename: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildVendorCsv(vendors: Vendor[]) {
  const headers = ["Name", "Company", "Email", "Phone", "Street", "City", "State", "ZIP", "Country"];
  const lines = [headers.join(",")];
  for (const v of vendors) {
    const name = `"${v.name.replace(/"/g, '""')}"`;
    lines.push([name, "", "", "", "", "", "", "", ""].join(","));
  }
  return lines.join("\n");
}

type ConfirmModal =
  | { type: "export"; vendors: Vendor[] }
  | { type: "delete"; vendors: Vendor[] }
  | null;

export default function VendorsPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<ConfirmModal>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    setLoading(true);
    getVendors(clientId)
      .then(setVendors)
      .finally(() => setLoading(false));
  }, [clientId]);

  const filtered = vendors.filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase())
  );

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((v) => selected.has(v.name));

  function toggleAll() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((v) => next.delete(v.name));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((v) => next.add(v.name));
        return next;
      });
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const selectedVendors = vendors.filter((v) => selected.has(v.name));

  // Export: download CSV then show confirm-upload modal
  function handleExportClick() {
    if (selectedVendors.length === 0) return;
    const csv = buildVendorCsv(selectedVendors);
    triggerDownload(csv, "text/csv", `qbo-vendors-${today()}.csv`);
    setConfirm({ type: "export", vendors: selectedVendors });
  }

  // Delete: show confirm-delete modal
  function handleDeleteClick() {
    if (selectedVendors.length === 0) return;
    setConfirm({ type: "delete", vendors: selectedVendors });
  }

  async function handleConfirm() {
    if (!confirm) return;
    setDismissing(true);
    try {
      const names = confirm.vendors.map((v) => v.name);
      await dismissVendors(
        clientId,
        names,
        confirm.type === "export" ? "exported" : "deleted"
      );
      setVendors((prev) => prev.filter((v) => !names.includes(v.name)));
      setSelected((prev) => {
        const next = new Set(prev);
        names.forEach((n) => next.delete(n));
        return next;
      });
      setConfirm(null);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Vendors</h1>
        <p className="text-gray-500 mt-1 text-xs">
          Select vendors to export as a QBO-ready CSV — import via Settings → Import Data → Vendors.
          Once exported and confirmed, or deleted, vendors are removed from this list.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Toolbar */}
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search vendors…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 w-64"
            />
            <div className="flex-1" />
            {selected.size > 0 && (
              <>
                <button
                  onClick={handleDeleteClick}
                  className="flex items-center gap-2 bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete {selected.size}
                </button>
                <button
                  onClick={handleExportClick}
                  className="flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export {selected.size} (.csv)
                </button>
              </>
            )}
          </div>

          {/* Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 font-medium text-left">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAll}
                      className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                    />
                  </th>
                  <th className="px-4 py-3">Vendor Name</th>
                  <th className="px-4 py-3 text-right">Transactions</th>
                  <th className="px-4 py-3 text-right">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-gray-500">
                      {search ? "No vendors match your search." : "No vendors found."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((v) => (
                    <tr
                      key={v.name}
                      onClick={() => toggle(v.name)}
                      className={`border-b border-gray-800 last:border-0 cursor-pointer transition-colors ${
                        selected.has(v.name) ? "bg-indigo-950/40" : "hover:bg-gray-800/30"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(v.name)}
                          onChange={() => toggle(v.name)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-4 py-3 text-white font-medium">{v.name}</td>
                      <td className="px-4 py-3 text-right text-gray-400">{v.count}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">{v.last_seen}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-600">
            {vendors.length} vendor{vendors.length !== 1 ? "s" : ""} total
            {selected.size > 0 ? ` · ${selected.size} selected` : ""}
          </p>
        </div>
      )}

      {/* Confirm modal */}
      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            {confirm.type === "export" ? (
              <>
                <h2 className="text-lg font-semibold text-white mb-2">Confirm QBO upload</h2>
                <p className="text-gray-400 text-sm mb-4">
                  Your CSV has been downloaded. Once you've imported it into QuickBooks Online, confirm below —
                  these {confirm.vendors.length} vendor{confirm.vendors.length !== 1 ? "s" : ""} will be removed from this list.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-white mb-2">Delete vendors?</h2>
                <p className="text-gray-400 text-sm mb-4">
                  Remove {confirm.vendors.length} vendor{confirm.vendors.length !== 1 ? "s" : ""} from this list?
                  This only hides them here — it does not affect any transactions.
                </p>
              </>
            )}

            <ul className="bg-gray-800 rounded-lg px-4 py-2 mb-5 max-h-40 overflow-y-auto space-y-1">
              {confirm.vendors.map((v) => (
                <li key={v.name} className="text-sm text-white truncate">{v.name}</li>
              ))}
            </ul>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirm(null)}
                disabled={dismissing}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={dismissing}
                className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors ${
                  confirm.type === "export"
                    ? "bg-green-700 hover:bg-green-600"
                    : "bg-red-700 hover:bg-red-600"
                } disabled:opacity-50`}
              >
                {dismissing
                  ? "Saving…"
                  : confirm.type === "export"
                  ? "Yes, uploaded to QBO"
                  : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
