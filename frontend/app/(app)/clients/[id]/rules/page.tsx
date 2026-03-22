"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getRules, createRule, deleteRule, updateRule, applyRule, generateRules, importMercuryRules,
  Rule, RuleCreate,
} from "@/lib/api";

const MATCH_TYPES = [
  { value: "counterparty_contains", label: "Counterparty contains" },
  { value: "counterparty_exact", label: "Counterparty exact" },
  { value: "description_contains", label: "Description contains" },
  { value: "description_exact", label: "Description exact" },
  { value: "category_equals", label: "Mercury category equals" },
  { value: "has_category", label: "Has any Mercury category (use $category as account)" },
  { value: "amount_gt", label: "Amount greater than" },
  { value: "amount_lt", label: "Amount less than" },
  { value: "kind", label: "Transaction kind equals" },
];

const RULE_ACTIONS = [
  { value: "expense", label: "Expense (simple DR/CR)" },
  { value: "prepaid", label: "Prepaid (amortize monthly)" },
  { value: "fixed_asset", label: "Fixed Asset (depreciate)" },
];

function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

interface EditState {
  match_type: string;
  match_value: string;
  debit_account: string;
  credit_account: string;
  rule_action: "expense" | "prepaid" | "fixed_asset";
  expense_account: string;
  prepaid_account: string;
  service_start: string;
  service_end: string;
  bank_account: string;
  asset_account: string;
  accumulated_account: string;
  depreciation_account: string;
  useful_life_months: string;
  gaap_basis: string;
}

function ruleToEditState(r: Rule): EditState {
  const meta = parseMetadata(r.rule_metadata);
  return {
    match_type: r.match_type,
    match_value: r.match_value,
    debit_account: r.debit_account,
    credit_account: r.credit_account,
    rule_action: (r.rule_action as EditState["rule_action"]) || "expense",
    expense_account: meta.expense_account || "",
    prepaid_account: meta.prepaid_account || "",
    service_start: meta.service_start || "",
    service_end: meta.service_end || "",
    bank_account: meta.bank_account || "",
    asset_account: meta.asset_account || "",
    accumulated_account: meta.accumulated_account || "Accumulated Depreciation",
    depreciation_account: meta.depreciation_account || "Depreciation Expense",
    useful_life_months: meta.useful_life_months || "60",
    gaap_basis: meta.gaap_basis || "",
  };
}

function blankEditState(clientId: number): EditState {
  return {
    match_type: "counterparty_contains",
    match_value: "",
    debit_account: "",
    credit_account: "Accrued Expenses",
    rule_action: "expense",
    expense_account: "",
    prepaid_account: "Prepaid Expenses",
    service_start: "",
    service_end: "",
    bank_account: "Accrued Expenses",
    asset_account: "",
    accumulated_account: "Accumulated Depreciation",
    depreciation_account: "Depreciation Expense",
    useful_life_months: "60",
    gaap_basis: "",
  };
}

function buildMetadata(e: EditState): string | null {
  if (e.rule_action === "prepaid") {
    const meta: Record<string, string> = {};
    if (e.expense_account) meta.expense_account = e.expense_account;
    if (e.prepaid_account) meta.prepaid_account = e.prepaid_account;
    if (e.service_start) meta.service_start = e.service_start;
    if (e.service_end) meta.service_end = e.service_end;
    if (e.bank_account) meta.bank_account = e.bank_account;
    return Object.keys(meta).length ? JSON.stringify(meta) : null;
  }
  if (e.rule_action === "fixed_asset") {
    const meta: Record<string, string> = {
      accumulated_account: e.accumulated_account || "Accumulated Depreciation",
      depreciation_account: e.depreciation_account || "Depreciation Expense",
      useful_life_months: e.useful_life_months || "60",
    };
    if (e.asset_account) meta.asset_account = e.asset_account;
    if (e.gaap_basis) meta.gaap_basis = e.gaap_basis;
    if (e.bank_account) meta.bank_account = e.bank_account;
    return JSON.stringify(meta);
  }
  return null;
}

function buildPayload(e: EditState, clientId?: number): Partial<RuleCreate> {
  return {
    ...(clientId !== undefined ? { client_id: clientId } : {}),
    match_type: e.match_type,
    match_value: e.match_value,
    debit_account: e.debit_account,
    credit_account: e.credit_account,
    rule_action: e.rule_action,
    rule_metadata: buildMetadata(e) ?? undefined,
  };
}

function MetaFields({ es, setEs }: { es: EditState; setEs: (e: EditState) => void }) {
  function F({ label, field, placeholder }: { label: string; field: keyof EditState; placeholder?: string }) {
    return (
      <div>
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>
        <input
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
          value={es[field] as string}
          onChange={(ev) => setEs({ ...es, [field]: ev.target.value })}
          placeholder={placeholder}
        />
      </div>
    );
  }

  if (es.rule_action === "prepaid") {
    return (
      <div className="grid grid-cols-2 gap-3 border-t border-gray-800 pt-3">
        <F label="Expense Account" field="expense_account" placeholder="e.g. Software Subscriptions" />
        <F label="Prepaid Account" field="prepaid_account" placeholder="Prepaid Expenses" />
        <F label="Service Start (e.g. January 2025)" field="service_start" />
        <F label="Service End (e.g. December 2025)" field="service_end" />
        <F label="Bank/Payment Account" field="bank_account" placeholder="Accrued Expenses" />
      </div>
    );
  }
  if (es.rule_action === "fixed_asset") {
    return (
      <div className="grid grid-cols-2 gap-3 border-t border-gray-800 pt-3">
        <F label="Asset Account" field="asset_account" placeholder="e.g. Computer Equipment" />
        <F label="Bank/Payment Account" field="bank_account" placeholder="Accrued Expenses" />
        <F label="Accumulated Depreciation Account" field="accumulated_account" />
        <F label="Depreciation Expense Account" field="depreciation_account" />
        <F label="Useful Life (months)" field="useful_life_months" placeholder="60" />
        <F label="GAAP Basis" field="gaap_basis" placeholder="e.g. 5-year straight-line" />
      </div>
    );
  }
  return null;
}

export default function RulesPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);

  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [applyResult, setApplyResult] = useState<Record<number, string>>({});
  const [toolbarMsg, setToolbarMsg] = useState("");
  const [toolbarWorking, setToolbarWorking] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newState, setNewState] = useState<EditState>(() => blankEditState(clientId));
  const [creatingNew, setCreatingNew] = useState(false);

  useEffect(() => {
    setLoading(true);
    getRules(clientId).then(setRules).finally(() => setLoading(false));
  }, [clientId]);

  function startEdit(r: Rule) {
    setEditingId(r.id);
    setEditState(ruleToEditState(r));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditState(null);
  }

  async function saveEdit(r: Rule) {
    if (!editState) return;
    setSavingId(r.id);
    try {
      const updated = await updateRule(r.id, buildPayload(editState));
      setRules(rules.map((x) => (x.id === r.id ? updated : x)));
      setEditingId(null);
      setEditState(null);
    } finally {
      setSavingId(null);
    }
  }

  async function handleCreate() {
    if (!newState.match_value || !newState.debit_account || !newState.credit_account) return;
    setCreatingNew(true);
    try {
      const rule = await createRule(buildPayload(newState, clientId) as RuleCreate);
      setRules([rule, ...rules]);
      setNewState(blankEditState(clientId));
      setShowNewForm(false);
    } finally {
      setCreatingNew(false);
    }
  }

  async function handleDelete(id: number) {
    await deleteRule(id);
    setRules(rules.filter((r) => r.id !== id));
  }

  async function handleToggle(r: Rule) {
    const updated = await updateRule(r.id, { active: !r.active });
    setRules(rules.map((x) => (x.id === r.id ? updated : x)));
  }

  async function handleApply(r: Rule) {
    setApplyingId(r.id);
    try {
      const res = await applyRule(r.id);
      setApplyResult({ ...applyResult, [r.id]: res.message });
      setTimeout(
        () => setApplyResult((prev) => { const n = { ...prev }; delete n[r.id]; return n; }),
        4000
      );
    } finally {
      setApplyingId(null);
    }
  }

  async function handleGenerate() {
    setToolbarWorking(true);
    setToolbarMsg("");
    try {
      const res = await generateRules(clientId);
      if (res.created > 0) {
        const fresh = await getRules(clientId);
        setRules(fresh);
      }
      setToolbarMsg(res.message);
    } finally {
      setToolbarWorking(false);
    }
  }

  async function handleImport() {
    setToolbarWorking(true);
    setToolbarMsg("");
    try {
      const res = await importMercuryRules(clientId);
      if (res.imported > 0) {
        const fresh = await getRules(clientId);
        setRules(fresh);
      }
      setToolbarMsg(res.message);
    } finally {
      setToolbarWorking(false);
    }
  }

  function RuleFormFields({ es, setEs }: { es: EditState; setEs: (e: EditState) => void }) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Match Type</p>
            <select
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
              value={es.match_type}
              onChange={(e) => setEs({ ...es, match_type: e.target.value })}
            >
              {MATCH_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Match Value</p>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
              value={es.match_value}
              onChange={(e) => setEs({ ...es, match_value: e.target.value })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Debit Account</p>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
              value={es.debit_account}
              onChange={(e) => setEs({ ...es, debit_account: e.target.value })}
            />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Credit Account</p>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
              value={es.credit_account}
              onChange={(e) => setEs({ ...es, credit_account: e.target.value })}
            />
          </div>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Rule Action</p>
          <select
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
            value={es.rule_action}
            onChange={(e) => setEs({ ...es, rule_action: e.target.value as EditState["rule_action"] })}
          >
            {RULE_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <MetaFields es={es} setEs={setEs} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Rules Engine</h1>
          <p className="text-gray-500 mt-1 text-xs">Rules fire before AI coding. First match wins.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleImport}
            disabled={toolbarWorking}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            Import from Mercury
          </button>
          <button
            onClick={handleGenerate}
            disabled={toolbarWorking}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            Generate from Patterns
          </button>
          <button
            onClick={() => { setShowNewForm((s) => !s); setNewState(blankEditState(clientId)); }}
            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg"
          >
            + New Rule
          </button>
        </div>
      </div>

      {toolbarMsg && (
        <div className="mb-4 text-xs text-green-400 bg-green-900/20 border border-green-800 rounded-lg px-4 py-2">
          {toolbarMsg}
        </div>
      )}

      {showNewForm && (
        <div className="bg-gray-900 border border-indigo-800/40 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-white mb-3">New Rule</h2>
          <RuleFormFields es={newState} setEs={setNewState} />
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleCreate}
              disabled={creatingNew || !newState.match_value || !newState.debit_account || !newState.credit_account}
              className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded disabled:opacity-50"
            >
              {creatingNew ? "Saving…" : "Create Rule"}
            </button>
            <button onClick={() => setShowNewForm(false)} className="text-xs text-gray-400 hover:text-gray-300 px-3 py-1.5">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center h-40 items-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rules.length === 0 && !showNewForm ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-3xl mb-3">📋</p>
          <p className="text-gray-400 font-medium">No rules yet</p>
          <p className="text-sm mt-1">Rules are created when you save a correction in the Review Queue, or click Generate from Patterns.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((r) => {
            const isEditing = editingId === r.id;
            const es = isEditing ? editState! : null;

            return (
              <div
                key={r.id}
                className={`bg-gray-900 border rounded-xl p-4 ${r.active ? "border-gray-800" : "border-gray-800 opacity-50"}`}
              >
                {!isEditing ? (
                  <div className="flex items-start gap-4">
                    <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                      <div>
                        <span className="text-gray-500">Match: </span>
                        <span className="text-gray-300 font-mono">{r.match_type}</span>
                        <span className="text-gray-500"> = </span>
                        <span className="text-white">&quot;{r.match_value}&quot;</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Action: </span>
                        <span className={`font-medium ${r.rule_action === "expense" ? "text-blue-400" : r.rule_action === "prepaid" ? "text-amber-400" : "text-purple-400"}`}>
                          {RULE_ACTIONS.find((a) => a.value === r.rule_action)?.label ?? r.rule_action}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">DR </span>
                        <span className="text-green-400">{r.debit_account}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">CR </span>
                        <span className="text-red-400">{r.credit_account}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      {applyResult[r.id] && (
                        <span className="text-xs text-green-400">{applyResult[r.id]}</span>
                      )}
                      <button
                        onClick={() => handleApply(r)}
                        disabled={applyingId === r.id || !r.active}
                        className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-2.5 py-1 rounded disabled:opacity-40"
                      >
                        {applyingId === r.id ? "Applying…" : "Apply"}
                      </button>
                      <button
                        onClick={() => handleToggle(r)}
                        className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-2.5 py-1 rounded"
                      >
                        {r.active ? "Disable" : "Enable"}
                      </button>
                      <button
                        onClick={() => startEdit(r)}
                        className="text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-2.5 py-1 rounded"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="text-xs text-red-400 hover:text-red-300 px-1.5 py-1"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <RuleFormFields es={es!} setEs={(e) => setEditState(e)} />
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => saveEdit(r)}
                        disabled={savingId === r.id}
                        className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded disabled:opacity-50"
                      >
                        {savingId === r.id ? "Saving…" : "Save"}
                      </button>
                      <button onClick={cancelEdit} className="text-xs text-gray-400 hover:text-gray-300 px-3 py-1.5">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
