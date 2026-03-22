"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  getVendorClasses,
  setVendorClass,
  VENDOR_CLASSES,
  VendorClass,
  VendorWithClass,
} from "@/lib/api";

const CLASS_COLORS: Record<VendorClass, { active: string; hover: string }> = {
  "Sales & Marketing":        { active: "bg-blue-600 text-white",   hover: "hover:bg-blue-900/40 hover:text-blue-300" },
  "Research & Development":   { active: "bg-violet-600 text-white", hover: "hover:bg-violet-900/40 hover:text-violet-300" },
  "General & Administrative": { active: "bg-amber-600 text-white",  hover: "hover:bg-amber-900/40 hover:text-amber-300" },
  "Multi-Class per vendor":   { active: "bg-teal-600 text-white",   hover: "hover:bg-teal-900/40 hover:text-teal-300" },
};

type Filter = "all" | "classified" | "unclassified";

export default function ClassesPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [vendors, setVendors] = useState<VendorWithClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Track in-flight saves per vendor
  const [saving, setSaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    getVendorClasses(clientId)
      .then(setVendors)
      .finally(() => setLoading(false));
  }, [clientId]);

  const handleClassClick = useCallback(
    async (vendor: VendorWithClass, cls: VendorClass) => {
      const newClass = vendor.class_name === cls ? null : cls;
      // Optimistic update
      setVendors((prev) =>
        prev.map((v) => (v.name === vendor.name ? { ...v, class_name: newClass } : v))
      );
      setSaving((prev) => new Set(prev).add(vendor.name));
      try {
        await setVendorClass(clientId, vendor.name, newClass);
      } catch {
        // Revert on failure
        setVendors((prev) =>
          prev.map((v) => (v.name === vendor.name ? { ...v, class_name: vendor.class_name } : v))
        );
      } finally {
        setSaving((prev) => {
          const next = new Set(prev);
          next.delete(vendor.name);
          return next;
        });
      }
    },
    [clientId]
  );

  const filtered = vendors.filter((v) => {
    if (search && !v.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "classified" && !v.class_name) return false;
    if (filter === "unclassified" && v.class_name) return false;
    return true;
  });

  const classifiedCount = vendors.filter((v) => v.class_name).length;
  const pct = vendors.length > 0 ? Math.round((classifiedCount / vendors.length) * 100) : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Vendor Classes</h1>
        <p className="text-gray-500 mt-1 text-xs">
          Assign a class to each vendor for future QBO import. Classes are stored here and can be
          exported once you upgrade your QBO plan.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Progress */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Classification progress</span>
              <span className="text-sm font-medium text-white">
                {classifiedCount} / {vendors.length} vendors ({pct}%)
              </span>
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex gap-4 mt-3">
              {VENDOR_CLASSES.map((cls) => {
                const n = vendors.filter((v) => v.class_name === cls).length;
                const { active } = CLASS_COLORS[cls];
                return (
                  <span key={cls} className="flex items-center gap-1.5 text-xs text-gray-400">
                    <span className={`inline-block w-2 h-2 rounded-full ${active}`} />
                    {cls}: {n}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search vendors…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 w-64"
            />
            <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden text-sm">
              {(["all", "unclassified", "classified"] as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 capitalize transition-colors ${
                    filter === f
                      ? "bg-indigo-600 text-white"
                      : "text-gray-400 hover:text-white hover:bg-gray-800"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 font-medium text-left">
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3 text-right w-24">Txns</th>
                  <th className="px-4 py-3 text-right w-28">Last Seen</th>
                  <th className="px-4 py-3 text-right">Class</th>
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
                    <tr key={v.name} className="border-b border-gray-800 last:border-0">
                      <td className="px-4 py-3">
                        <span className="text-white font-medium">{v.name}</span>
                        {saving.has(v.name) && (
                          <span className="ml-2 text-xs text-gray-500">saving…</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-400">{v.count}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">{v.last_seen}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {VENDOR_CLASSES.map((cls) => {
                            const active = v.class_name === cls;
                            const { active: activeClass, hover } = CLASS_COLORS[cls];
                            return (
                              <button
                                key={cls}
                                onClick={() => handleClassClick(v, cls)}
                                disabled={saving.has(v.name)}
                                title={cls}
                                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
                                  active
                                    ? `${activeClass} border-transparent`
                                    : `border-gray-700 text-gray-500 ${hover}`
                                }`}
                              >
                                {cls === "Sales & Marketing"
                                  ? "S&M"
                                  : cls === "Research & Development"
                                  ? "R&D"
                                  : cls === "General & Administrative"
                                  ? "G&A"
                                  : "Multi"}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-600">
            {vendors.length} vendor{vendors.length !== 1 ? "s" : ""} total · click a class to assign, click again to clear
          </p>
        </div>
      )}
    </div>
  );
}
