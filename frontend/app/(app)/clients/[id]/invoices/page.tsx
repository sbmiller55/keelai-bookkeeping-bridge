"use client";

import { useCallback, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { uploadInvoice, InvoiceUploadResult } from "@/lib/api";

interface UploadItem {
  id: string;
  filename: string;
  status: "uploading" | "done" | "error";
  result?: InvoiceUploadResult;
  error?: string;
}

export default function InvoiceUploadPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);

  function updateItem(itemId: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)));
  }

  async function processFile(file: File) {
    const itemId = `${Date.now()}-${Math.random()}`;
    setItems((prev) => [{ id: itemId, filename: file.name, status: "uploading" }, ...prev]);
    try {
      const result = await uploadInvoice(clientId, file);
      updateItem(itemId, { status: "done", result });
    } catch (err: unknown) {
      updateItem(itemId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach(processFile);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [clientId]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Invoice Upload</h1>
        <p className="text-gray-500 text-xs mt-0.5">Upload a PDF or image — AI reads it and creates the journal entries automatically.</p>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-2xl px-8 py-14 cursor-pointer transition-colors select-none ${
          dragging
            ? "border-indigo-400 bg-indigo-500/10"
            : "border-gray-700 hover:border-gray-500 hover:bg-gray-800/30"
        }`}
      >
        <svg className="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-300">Drop invoices here or click to browse</p>
          <p className="text-xs text-gray-600 mt-1">PDF, JPG, PNG, WEBP — up to 20 MB each</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          multiple
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* Results */}
      {items.length > 0 && (
        <div className="mt-6 space-y-4">
          {items.map((item) => (
            <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              {/* Card header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
                {item.status === "uploading" && (
                  <span className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
                )}
                {item.status === "done" && (
                  <span className="w-4 h-4 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center text-xs shrink-0">✓</span>
                )}
                {item.status === "error" && (
                  <span className="w-4 h-4 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center text-xs shrink-0">✕</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{item.filename}</p>
                  {item.status === "uploading" && <p className="text-xs text-gray-500">Reading invoice…</p>}
                  {item.status === "error" && <p className="text-xs text-red-400">{item.error}</p>}
                  {item.status === "done" && item.result && (
                    <p className="text-xs text-gray-400">
                      {item.result.transaction.vendor} · {new Date(item.result.transaction.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · <span className="text-red-400">${Math.abs(item.result.transaction.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                    </p>
                  )}
                </div>
                {item.status === "done" && (
                  <button
                    onClick={() => router.push(`/clients/${id}/review`)}
                    className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 transition-colors whitespace-nowrap"
                  >
                    Review Queue →
                  </button>
                )}
              </div>

              {/* Journal entries */}
              {item.status === "done" && item.result && item.result.journal_entries.length > 0 && (
                <div className="px-4 py-3">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Journal Entries Created</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-600 uppercase tracking-wider">
                        <th className="text-left pb-1 font-medium">Date</th>
                        <th className="text-left pb-1 font-medium">Debit</th>
                        <th className="text-left pb-1 font-medium">Credit</th>
                        <th className="text-right pb-1 font-medium">Amount</th>
                        <th className="text-left pb-1 font-medium">Memo</th>
                        <th className="text-center pb-1 font-medium">Conf</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {item.result.journal_entries.map((je) => {
                        const conf = je.ai_confidence;
                        const confCls = conf === null ? "text-gray-600" : conf >= 0.85 ? "text-green-400" : conf >= 0.6 ? "text-yellow-400" : "text-red-400";
                        return (
                          <tr key={je.id} className="text-gray-300">
                            <td className="py-1.5 pr-3 whitespace-nowrap text-gray-500">{je.je_date ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-white">{je.debit_account}</td>
                            <td className="py-1.5 pr-3">{je.credit_account}</td>
                            <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap">
                              ${je.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                            </td>
                            <td className="py-1.5 pr-3 text-gray-500 max-w-[200px] truncate">{je.memo || "—"}</td>
                            <td className={`py-1.5 text-center font-mono ${confCls}`}>
                              {conf !== null ? `${Math.round(conf * 100)}%` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {item.result.journal_entries[0]?.ai_reasoning && (
                    <p className="mt-2 text-xs text-gray-600 italic">{item.result.journal_entries[0].ai_reasoning}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
