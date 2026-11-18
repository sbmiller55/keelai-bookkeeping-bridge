"use client";

/**
 * Two read-only checks against QuickBooks, run from the close checklist.
 *
 * Both answer questions nothing else in the app can: they read what QuickBooks
 * actually holds rather than this app's record of what it pushed, which is the
 * thing that was wrong when September 2026 posted twice.
 *
 *   Duplicates    the same entry sitting in QuickBooks more than once
 *   Schedules     every amortization and depreciation schedule tied to the GL
 *
 * Nothing here posts or changes anything, and the button says so — the whole
 * point is that it is safe to press during a close.
 */

import { useState } from "react";
import {
  CloseCheckResult,
  TieOutResult,
  TieOutSchedule,
  runCloseCheck,
  runScheduleTieOut,
} from "@/lib/api";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Plain English for each way a schedule can be out, and how worried to be. */
const FLAG_COPY: Record<string, { label: string; tone: "bad" | "warn"; hint: string }> = {
  duplicated_in_qbo: {
    label: "Duplicated in QuickBooks",
    tone: "bad",
    hint: "Posted more than once — the books are overstated until a copy is deleted.",
  },
  not_exported: {
    label: "Not in QuickBooks",
    tone: "bad",
    hint: "Created here but never exported, so the ledger is understated.",
  },
  over_generated: {
    label: "Extra entries here",
    tone: "warn",
    hint: "More entries in Keel than the schedule allows. Harmless until exported.",
  },
  not_generated: {
    label: "Months not created",
    tone: "warn",
    hint: "A month the schedule expects has not been generated yet.",
  },
};

function Pill({ tone, children }: { tone: "ok" | "bad" | "warn"; children: React.ReactNode }) {
  const styles = {
    ok: "bg-emerald-900/60 text-emerald-300 border-emerald-700",
    bad: "bg-red-900/50 text-red-300 border-red-700",
    warn: "bg-amber-900/50 text-amber-300 border-amber-700",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

function ScheduleRow({ s }: { s: TieOutSchedule }) {
  const ok = s.flags.length === 0;
  return (
    <div className="py-2.5 border-b border-gray-800 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-white font-medium truncate">{s.name}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {money(s.monthly)}/mo · {s.months_elapsed} of {s.months_total || "—"} months
            {s.kind === "prepaid" ? " · prepaid" : " · fixed asset"}
          </p>
        </div>
        <div className="flex flex-wrap gap-1 justify-end shrink-0">
          {ok ? <Pill tone="ok">Ties out</Pill>
              : s.flags.map((f) => (
                  <Pill key={f} tone={FLAG_COPY[f]?.tone ?? "warn"}>
                    {FLAG_COPY[f]?.label ?? f}
                  </Pill>
                ))}
        </div>
      </div>

      {!ok && (
        <>
          {/* The three numbers that have to agree, so the direction is obvious. */}
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {[
              ["Schedule says", s.expected_to_date],
              ["Keel has", s.keel_to_date],
              ["QuickBooks has", s.qbo_to_date],
            ].map(([label, val]) => (
              <div key={label as string} className="bg-gray-900/60 rounded-lg py-1.5 px-2">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
                <p className="text-sm text-white tabular-nums mt-0.5">{money(val as number)}</p>
              </div>
            ))}
          </div>
          <ul className="mt-2 space-y-0.5">
            {s.flags.map((f) => (
              <li key={f} className="text-[11px] text-gray-400">· {FLAG_COPY[f]?.hint ?? f}</li>
            ))}
          </ul>
          {s.missing_periods.length > 0 && (
            <p className="text-[11px] text-gray-500 mt-1">
              Months not created: {s.missing_periods.join(", ")}
            </p>
          )}
          {Object.keys(s.duplicated_periods).length > 0 && (
            <p className="text-[11px] text-red-300 mt-1">
              Duplicated in QuickBooks:{" "}
              {Object.entries(s.duplicated_periods)
                .map(([p, ids]) => `${p} (ids ${ids.join(", ")})`)
                .join("; ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function CloseChecks({
  clientId,
  period,
  periodLabel,
}: {
  clientId: number;
  period: string;        // "YYYY-MM"
  periodLabel: string;
}) {
  const [dupes, setDupes] = useState<CloseCheckResult | null>(null);
  const [tie, setTie] = useState<TieOutResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      // Both hit QuickBooks; run them together so one press answers both.
      const [d, t] = await Promise.all([
        runCloseCheck(clientId, period),
        runScheduleTieOut(clientId, period),
      ]);
      setDupes(d);
      setTie(t);
      setOpen(true);
    } catch (e: any) {
      setError(e?.message ?? "Could not reach QuickBooks.");
    } finally {
      setRunning(false);
    }
  }

  const hasRun = dupes !== null && tie !== null;
  const allClean = hasRun && dupes!.clean && tie!.clean;
  const problems = hasRun
    ? dupes!.duplicates.length + tie!.schedules.filter((s) => s.flags.length > 0).length
    : 0;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">Check {periodLabel} against QuickBooks</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Looks for duplicate entries and ties every schedule to the ledger. Reads only —
            nothing is posted or changed.
          </p>
        </div>
        {hasRun && (
          <button onClick={() => setOpen((o) => !o)}
            className="text-[11px] text-gray-400 hover:text-white transition-colors whitespace-nowrap">
            {open ? "Hide" : "Show"}
          </button>
        )}
        <button
          onClick={run}
          disabled={running}
          className="px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {running ? "Checking…" : hasRun ? "Re-check" : "Run check"}
        </button>
      </div>

      {error && (
        <div className="mx-4 mb-3 bg-red-900/40 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {hasRun && open && (
        <div className="border-t border-gray-700 px-4 py-3 space-y-4">
          {/* Headline */}
          <div className={`rounded-lg px-3 py-2 border ${allClean
            ? "bg-emerald-900/30 border-emerald-800"
            : "bg-amber-900/25 border-amber-800"}`}>
            <p className={`text-sm font-semibold ${allClean ? "text-emerald-300" : "text-amber-200"}`}>
              {allClean
                ? `${periodLabel} looks clean`
                : `${problems} thing${problems === 1 ? "" : "s"} to look at before closing`}
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Read {dupes!.qbo_entries} QuickBooks entries for this period.
              {!allClean && tie!.total_variance > 0 &&
                ` Schedules are out by ${money(tie!.total_variance)} in total.`}
            </p>
          </div>

          {/* Duplicates */}
          {dupes!.duplicates.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-300 mb-1.5">Duplicate entries in QuickBooks</p>
              {dupes!.duplicates.map((d) => (
                <div key={`${d.doc_number}-${d.txn_date}`}
                  className="bg-red-900/20 border border-red-900 rounded-lg px-3 py-2 mb-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm text-white truncate">{d.memo || `Entry ${d.doc_number}`}</p>
                    <p className="text-sm text-red-300 tabular-nums whitespace-nowrap">
                      +{money(d.overstated_by)}
                    </p>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    #{d.doc_number} · {d.txn_date} · {money(d.amount)} × {d.count} ·
                    QuickBooks ids {d.qbo_ids.join(", ")}
                  </p>
                </div>
              ))}
              <p className="text-[11px] text-gray-500">
                Delete the extra copies in QuickBooks. Keel will not re-post them.
              </p>
            </div>
          )}

          {/* Schedules */}
          <div>
            <p className="text-xs font-semibold text-gray-300 mb-0.5">Schedules</p>
            {tie!.schedules.length === 0
              ? <p className="text-[11px] text-gray-500 py-2">No schedules set up for this client.</p>
              : tie!.schedules.map((s) => <ScheduleRow key={`${s.kind}-${s.name}`} s={s} />)}
          </div>

          {/* Recurring in QBO with no schedule here */}
          {tie!.unscheduled.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-300 mb-1.5">
                Recurring in QuickBooks with no schedule in Keel
              </p>
              {tie!.unscheduled.map((u) => (
                <div key={u.name} className="flex items-baseline justify-between gap-2 py-1 border-b border-gray-800 last:border-b-0">
                  <p className="text-sm text-gray-200 capitalize truncate">{u.name}</p>
                  <p className="text-[11px] text-gray-500 whitespace-nowrap">
                    {u.periods.length} month{u.periods.length === 1 ? "" : "s"} in QuickBooks · {money(u.total)}
                  </p>
                </div>
              ))}
              <p className="text-[11px] text-gray-500 mt-1">
                Amortizing in QuickBooks with nothing here tracking the schedule, so a skipped
                month would go unnoticed. Set one up in Payments → prepaid expenses.
              </p>
            </div>
          )}

          {/* Orphans — only the ones a person should actually look at */}
          {dupes!.orphans.some((o) => !o.likely_external) && (
            <div>
              <p className="text-xs font-semibold text-gray-300 mb-1.5">
                In QuickBooks, unknown to Keel
              </p>
              {dupes!.orphans.filter((o) => !o.likely_external).map((o) => (
                <div key={o.qbo_id} className="flex items-baseline justify-between gap-2 py-1 border-b border-gray-800 last:border-b-0">
                  <p className="text-sm text-gray-200 truncate">{o.memo || `Entry ${o.doc_number}`}</p>
                  <p className="text-[11px] text-gray-500 whitespace-nowrap">
                    id {o.qbo_id} · {o.txn_date} · {money(o.amount)}
                  </p>
                </div>
              ))}
              <p className="text-[11px] text-gray-500 mt-1">
                Entries Rippling posts itself are filtered out of this list.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
