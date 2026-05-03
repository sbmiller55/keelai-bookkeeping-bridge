import { getToken, setToken, removeToken } from "./auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  email: string;
  name: string;
  subscription_tier: string;
  created_at: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface Client {
  id: number;
  user_id: number;
  name: string;
  mercury_api_key_encrypted: string | null;
  qbo_oauth_token: string | null;
  qbo_realm_id: string | null;
  chart_of_accounts_path: string | null;
  policy_path: string | null;
  created_at: string;
  last_sync_at: string | null;
}

export interface ClientCreate {
  name: string;
  mercury_api_key_encrypted?: string;
  qbo_oauth_token?: string;
  chart_of_accounts_path?: string | null;
  policy_path?: string | null;
}

export interface Transaction {
  id: number;
  client_id: number;
  mercury_transaction_id: string | null;
  date: string;
  description: string;
  amount: number;
  mercury_category: string | null;
  kind: string | null;
  counterparty_name: string | null;
  mercury_account_id: string | null;
  mercury_account_name: string | null;
  payment_method: string | null;
  invoice_number: string | null;
  invoice_text: string | null;
  mercury_status: string | null;
  status: "pending" | "reviewed" | "approved" | "exported" | "rejected";
  imported_at: string;
}

export interface PaymentTransaction extends Transaction {
  je_count: number;
}

export interface TransactionCreate {
  client_id: number;
  date: string;
  description: string;
  amount: number;
  mercury_transaction_id?: string;
  mercury_category?: string;
}

export interface JournalEntry {
  id: number;
  je_number: number | null;
  transaction_id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  je_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  memo: string | null;
  description: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  rule_applied: number | null;
  parent_je_id: number | null;
  approved_by: number | null;
  approved_at: string | null;
  exported_at: string | null;
  export_file: string | null;
  is_recurring: boolean | null;
  recur_frequency: string | null;
  recur_end_date: string | null;
  qbo_object_type: string | null;
}

export interface JournalEntryCreate {
  transaction_id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  je_date?: string;
  memo?: string;
  description?: string;
  service_period_start?: string;
  service_period_end?: string;
}

export interface Rule {
  id: number;
  client_id: number;
  match_type: string;
  match_value: string;
  debit_account: string;
  credit_account: string;
  rule_action: "expense" | "prepaid" | "fixed_asset";
  rule_metadata: string | null;
  created_from_transaction_id: number | null;
  active: boolean;
}

export interface RuleCreate {
  client_id: number;
  match_type: string;
  match_value: string;
  debit_account: string;
  credit_account: string;
  rule_action?: "expense" | "prepaid" | "fixed_asset";
  rule_metadata?: string;
  created_from_transaction_id?: number;
  active?: boolean;
}

export interface AuditLog {
  id: number;
  transaction_id: number;
  action: string;
  before_state: string | null;
  after_state: string | null;
  actor: number;
  timestamp: string;
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

let _refreshing: Promise<string | null> | null = null;

async function _tryRefreshToken(): Promise<string | null> {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      const token = getToken();
      if (!token) return null;
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      setToken(data.access_token);
      return data.access_token as string;
    } catch {
      return null;
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    if (res.status === 401) {
      const newToken = await _tryRefreshToken();
      if (newToken) {
        // Retry the original request with the new token
        const retryRes = await fetch(`${BASE_URL}${path}`, {
          ...options,
          headers: { ...headers, "Authorization": `Bearer ${newToken}` },
        });
        if (retryRes.ok) {
          if (retryRes.status === 204) return undefined as unknown as T;
          return retryRes.json() as Promise<T>;
        }
      }
      removeToken();
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = errorBody.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((e: { msg?: string }) => e.msg ?? JSON.stringify(e)).join(", ") : "Request failed";
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = errorBody.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((e: { msg?: string }) => e.msg ?? JSON.stringify(e)).join(", ") : "Invalid email or password";
    throw new Error(message);
  }
  return res.json();
}

export function register(
  name: string,
  email: string,
  password: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
}

export function getMe(): Promise<User> {
  return apiFetch<User>("/auth/me");
}

// ── Clients ───────────────────────────────────────────────────────────────────

export function getClients(): Promise<Client[]> {
  return apiFetch<Client[]>("/clients/");
}

export function getClient(id: number): Promise<Client> {
  return apiFetch<Client>(`/clients/${id}`);
}

export function createClient(data: ClientCreate): Promise<Client> {
  return apiFetch<Client>("/clients/", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getChartOfAccounts(clientId: number): Promise<string[]> {
  return apiFetch<string[]>(`/clients/${clientId}/accounts`);
}

export function updateClient(id: number, data: Partial<ClientCreate>): Promise<Client> {
  return apiFetch<Client>(`/clients/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteClient(id: number): Promise<void> {
  return apiFetch<void>(`/clients/${id}`, { method: "DELETE" });
}

// ── Transactions ──────────────────────────────────────────────────────────────

export function getTransactions(clientId?: number): Promise<Transaction[]> {
  const qs = clientId !== undefined ? `?client_id=${clientId}` : "";
  return apiFetch<Transaction[]>(`/transactions/${qs}`);
}

export function createTransaction(data: TransactionCreate): Promise<Transaction> {
  return apiFetch<Transaction>("/transactions/", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTransactionStatus(
  id: number,
  status: Transaction["status"]
): Promise<Transaction> {
  return apiFetch<Transaction>(`/transactions/${id}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

export function updateTransactionDate(id: number, date: string): Promise<Transaction> {
  return apiFetch<Transaction>(`/transactions/${id}`, {
    method: "PUT",
    body: JSON.stringify({ date }),
  });
}

export function deleteTransaction(id: number): Promise<void> {
  return apiFetch<void>(`/transactions/${id}`, { method: "DELETE" });
}

// ── Journal Entries ───────────────────────────────────────────────────────────

export function getJournalEntries(transactionId?: number): Promise<JournalEntry[]> {
  const qs = transactionId !== undefined ? `?transaction_id=${transactionId}` : "";
  return apiFetch<JournalEntry[]>(`/journal-entries/${qs}`);
}

export function createJournalEntry(data: JournalEntryCreate): Promise<JournalEntry> {
  return apiFetch<JournalEntry>("/journal-entries/", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function createRule(data: RuleCreate): Promise<Rule> {
  return apiFetch<Rule>("/rules/", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

export function getAuditLog(transactionId?: number): Promise<AuditLog[]> {
  const qs = transactionId !== undefined ? `?transaction_id=${transactionId}` : "";
  return apiFetch<AuditLog[]>(`/audit/${qs}`);
}

// ── File Upload ───────────────────────────────────────────────────────────────

export interface UploadResponse {
  path: string;
  filename: string;
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const token = getToken();
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${BASE_URL}/files/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Upload failed");
  }
  return res.json();
}

export function codePrepaid(
  txnId: number,
  options: { service_start: string; service_end: string; expense_account: string; prepaid_account?: string }
): Promise<JournalEntry[]> {
  return apiFetch<JournalEntry[]>(`/transactions/${txnId}/prepaid`, {
    method: "POST",
    body: JSON.stringify({
      service_start: options.service_start,
      service_end: options.service_end,
      expense_account: options.expense_account,
      prepaid_account: options.prepaid_account ?? "Prepaid Expenses",
    }),
  });
}

export function clearAllTransactions(clientId: number): Promise<void> {
  return apiFetch<void>(`/transactions/?client_id=${clientId}`, { method: "DELETE" });
}

export interface TransactionWithEntries extends Transaction {
  journal_entries: JournalEntry[];
}

export function getTransactionsWithEntries(clientId: number, status?: string): Promise<TransactionWithEntries[]> {
  const qs = status ? `&status=${status}` : "";
  return apiFetch<TransactionWithEntries[]>(`/transactions/with-entries?client_id=${clientId}${qs}`);
}

export function updateJournalEntry(id: number, data: Partial<JournalEntryCreate>): Promise<JournalEntry> {
  return apiFetch<JournalEntry>(`/journal-entries/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteJournalEntry(id: number): Promise<void> {
  return apiFetch<void>(`/journal-entries/${id}`, { method: "DELETE" });
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function getRules(clientId: number): Promise<Rule[]> {
  return apiFetch<Rule[]>(`/rules/?client_id=${clientId}`);
}

export function deleteRule(id: number): Promise<void> {
  return apiFetch<void>(`/rules/${id}`, { method: "DELETE" });
}

export function toggleRule(id: number, active: boolean): Promise<Rule> {
  return apiFetch<Rule>(`/rules/${id}`, {
    method: "PUT",
    body: JSON.stringify({ active }),
  });
}

export function updateRule(id: number, data: Partial<RuleCreate>): Promise<Rule> {
  return apiFetch<Rule>(`/rules/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function applyRule(id: number): Promise<{ applied: number; message: string }> {
  return apiFetch(`/rules/${id}/apply`, { method: "POST" });
}

export function generateRules(clientId: number): Promise<{ created: number; message: string }> {
  return apiFetch(`/rules/generate?client_id=${clientId}`, { method: "POST" });
}

export function importMercuryRules(clientId: number): Promise<{ imported: number; message: string }> {
  return apiFetch(`/mercury/import-rules?client_id=${clientId}`, { method: "POST" });
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function getChatHistory(clientId: number): Promise<ChatMessage[]> {
  return apiFetch<ChatMessage[]>(`/chat/history?client_id=${clientId}`);
}

export interface ChatImage {
  data: string;       // base64
  media_type: string; // e.g. "image/png"
}

export async function sendChatMessage(
  clientId: number,
  messages: ChatMessage[],
  currentPage?: string,
  pageContext?: string | null,
  images?: ChatImage[],
): Promise<string> {
  const res = await apiFetch<{ reply: string }>("/chat/", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      messages,
      current_page: currentPage ?? null,
      page_context: pageContext ?? null,
      images: images ?? [],
    }),
  });
  return res.reply;
}

// ── Payments ──────────────────────────────────────────────────────────────────

export function getPayments(clientId: number): Promise<PaymentTransaction[]> {
  return apiFetch<PaymentTransaction[]>(`/mercury/payments?client_id=${clientId}`);
}

export function getInboundEmailAddress(): Promise<{ address: string }> {
  return apiFetch<{ address: string }>("/email/address");
}

// ── Mercury Sync ──────────────────────────────────────────────────────────────

export interface MercuryAccountSummary {
  name: string;
  transactions: number;
  scheduled: number;
}

export interface MercurySyncResult {
  client_id: number;
  client_name: string;
  imported: number;
  skipped: number;
  je_created: number;
  errors: string[];
  accounts: MercuryAccountSummary[];
  date_earliest: string | null;
  date_latest: string | null;
  key_source: "env" | "client" | "none";
  range_start: string | null;
  range_end: string | null;
  last_sync_at: string | null;
}

export interface MercurySyncResponse {
  results: MercurySyncResult[];
  total_imported: number;
  total_skipped: number;
  total_je_created: number;
}

export type DateRangeOption = "since_last_sync" | "last_30" | "last_90" | "last_180" | "last_365" | "custom";

export function codePending(clientId: number): Promise<{ je_created: number; message: string }> {
  return apiFetch(`/mercury/code?client_id=${clientId}`, { method: "POST" });
}

// ── Invoice Upload ────────────────────────────────────────────────────────────

export interface InvoiceJE {
  id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  je_date: string | null;
  memo: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
}

export interface InvoiceUploadResult {
  transaction: {
    id: number;
    date: string;
    description: string;
    vendor: string;
    amount: number;
    status: string;
  };
  journal_entries: InvoiceJE[];
  // Prepaid-only fields
  invoice_type?: string;
  service_start?: string;
  service_end?: string;
  expense_account?: string;
  prepaid_account?: string;
}

export async function uploadInvoice(clientId: number, file: File): Promise<InvoiceUploadResult> {
  const token = getToken();
  const body = new FormData();
  body.append("client_id", String(clientId));
  body.append("file", file);
  const res = await fetch(`${BASE_URL}/invoices/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Upload failed");
  }
  return res.json();
}

export async function recalculatePrepaid(
  transactionId: number,
  serviceStart: string,
  serviceEnd: string,
  expenseAccount: string,
  prepaidAccount: string,
): Promise<InvoiceUploadResult> {
  return apiFetch<InvoiceUploadResult>("/invoices/recalculate", {
    method: "POST",
    body: JSON.stringify({
      transaction_id: transactionId,
      service_start: serviceStart,
      service_end: serviceEnd,
      expense_account: expenseAccount,
      prepaid_account: prepaidAccount,
    }),
  });
}

export function syncMercury(
  clientId?: number,
  dateRange: DateRangeOption = "since_last_sync",
  customStart?: string,
  customEnd?: string,
): Promise<MercurySyncResponse> {
  return apiFetch<MercurySyncResponse>("/mercury/sync", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId ?? null,
      date_range: dateRange,
      custom_start: customStart ?? null,
      custom_end: customEnd ?? null,
    }),
  });
}

export interface Vendor {
  name: string;
  count: number;
  last_seen: string;
}

export function getVendors(clientId: number): Promise<Vendor[]> {
  return apiFetch(`/transactions/vendors?client_id=${clientId}`);
}

export const VENDOR_CLASSES = [
  "Sales & Marketing",
  "Research & Development",
  "General & Administrative",
  "Multi-Class per vendor",
] as const;
export type VendorClass = (typeof VENDOR_CLASSES)[number];

export interface VendorWithClass {
  name: string;
  count: number;
  last_seen: string;
  class_name: VendorClass | null;
  skipped: boolean;
}

export function getVendorClasses(clientId: number): Promise<VendorWithClass[]> {
  return apiFetch(`/transactions/vendor-classes?client_id=${clientId}`);
}

export function setVendorClass(
  clientId: number,
  vendorName: string,
  className: VendorClass | null
): Promise<void> {
  return apiFetch("/transactions/vendor-classes", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, vendor_name: vendorName, class_name: className }),
  });
}

export function skipVendor(clientId: number, name: string): Promise<void> {
  return apiFetch("/transactions/vendor-classes/skip", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, name }),
  });
}

export function unskipVendor(clientId: number, name: string): Promise<void> {
  return apiFetch("/transactions/vendor-classes/unskip", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, name }),
  });
}

export function dismissVendors(
  clientId: number,
  names: string[],
  reason: "exported" | "deleted"
): Promise<void> {
  return apiFetch("/transactions/vendors/dismiss", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, names, reason }),
  });
}

// ── Close Checklist ───────────────────────────────────────────────────────────

export type CloseChecklistItem = {
  id: number;
  client_id: number;
  order_index: number;
  title: string;
  description: string | null;
  due_rule: string;
  milestone: string | null;
  recurrence: string;
  completed_at: string | null;
};

export function getCloseChecklist(clientId: number, closeMonth: string): Promise<CloseChecklistItem[]> {
  return apiFetch<CloseChecklistItem[]>(`/clients/${clientId}/close-checklist?close_month=${closeMonth}`);
}

export function completeChecklistItem(clientId: number, itemId: number, closeMonth: string): Promise<CloseChecklistItem> {
  return apiFetch<CloseChecklistItem>(`/clients/${clientId}/close-checklist/${itemId}/complete`, {
    method: "POST",
    body: JSON.stringify({ close_month: closeMonth }),
  });
}

export function uncompleteChecklistItem(clientId: number, itemId: number, closeMonth: string): Promise<void> {
  return apiFetch<void>(`/clients/${clientId}/close-checklist/${itemId}/complete/${closeMonth}`, {
    method: "DELETE",
  });
}

export function createChecklistItem(clientId: number, data: {
  title: string;
  description?: string;
  due_rule: string;
  order_index: number;
  milestone?: string;
  recurrence?: string;
}): Promise<CloseChecklistItem> {
  return apiFetch<CloseChecklistItem>(`/clients/${clientId}/close-checklist`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateChecklistItem(clientId: number, itemId: number, data: Partial<{
  title: string;
  description: string;
  due_rule: string;
  order_index: number;
  milestone: string;
  recurrence: string;
}>): Promise<CloseChecklistItem> {
  return apiFetch<CloseChecklistItem>(`/clients/${clientId}/close-checklist/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteChecklistItem(clientId: number, itemId: number): Promise<void> {
  return apiFetch<void>(`/clients/${clientId}/close-checklist/${itemId}`, {
    method: "DELETE",
  });
}

// ── QuickBooks Online ─────────────────────────────────────────────────────────

export interface QboStatus {
  connected: boolean;
  realm_id: string | null;
  token_expires_at: string | null;
}

export interface QboSyncResult {
  synced: number;
  created_vendors: string[];
  errors: string[];
}

export function getQboStatus(clientId: number): Promise<QboStatus> {
  return apiFetch<QboStatus>(`/clients/${clientId}/qbo/status`);
}

export function getQboAuthUrl(clientId: number): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`/clients/${clientId}/qbo/auth-url`);
}

export function connectQbo(clientId: number, code: string, realmId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/clients/${clientId}/qbo/callback`, {
    method: "POST",
    body: JSON.stringify({ code, realm_id: realmId }),
  });
}

export function disconnectQbo(clientId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/clients/${clientId}/qbo/disconnect`, {
    method: "DELETE",
  });
}

export function getQboAccounts(clientId: number): Promise<string[]> {
  return apiFetch<{ accounts: string[] }>(`/clients/${clientId}/qbo/accounts`)
    .then((r) => r.accounts);
}

export function ensureQboAccounts(clientId: number): Promise<{ created: string[]; already_existed: string[]; errors: string[] }> {
  return apiFetch(`/clients/${clientId}/qbo/ensure-accounts`, { method: "POST" });
}

export function syncToQbo(clientId: number, markExported = true, force = false): Promise<QboSyncResult> {
  return apiFetch<QboSyncResult>(
    `/clients/${clientId}/qbo/sync?mark_exported=${markExported}&force=${force}`,
    { method: "POST" }
  );
}

// ── Fixed Assets ──────────────────────────────────────────────────────────────

export interface DepreciationPeriod {
  period: string;   // "2026-04"
  date: string;     // ISO date, last day of month
  depreciation: number;
  accumulated_depreciation: number;
  net_book_value: number;
}

export interface FixedAsset {
  id: number;
  client_id: number;
  transaction_id: number | null;
  name: string;
  category: string;
  purchase_date: string;
  purchase_price: number;
  salvage_value: number;
  useful_life_months: number;
  depreciation_method: string;
  asset_type: string;          // "tangible" | "intangible"
  is_indefinite_life: boolean; // true for Goodwill
  qbo_asset_account: string | null;
  qbo_accum_dep_account: string | null;
  qbo_dep_expense_account: string | null;
  status: "active" | "fully_depreciated" | "disposed";
  notes: string | null;
  created_at: string;
  monthly_depreciation: number;
  accumulated_depreciation_to_date: number;
  net_book_value: number;
  schedule: DepreciationPeriod[];
}

export interface FixedAssetCreate {
  transaction_id?: number;
  je_id?: number;
  name: string;
  category: string;
  purchase_date: string;
  purchase_price: number;
  salvage_value?: number;
  useful_life_months: number;
  depreciation_method?: string;
  asset_type?: string;
  is_indefinite_life?: boolean;
  qbo_asset_account?: string;
  qbo_accum_dep_account?: string;
  qbo_dep_expense_account?: string;
  notes?: string;
}

export interface FixedAssetSuggestion {
  name: string;
  category: string;
  purchase_date: string;
  purchase_price: number;
  salvage_value: number;
  useful_life_months: number;
  depreciation_method: string;
  asset_type: string;
  is_indefinite_life: boolean;
}

export function getFixedAssets(clientId: number): Promise<FixedAsset[]> {
  return apiFetch<FixedAsset[]>(`/clients/${clientId}/fixed-assets`);
}

export function getFixedAsset(clientId: number, assetId: number): Promise<FixedAsset> {
  return apiFetch<FixedAsset>(`/clients/${clientId}/fixed-assets/${assetId}`);
}

export function suggestFixedAsset(clientId: number, transactionId: number): Promise<FixedAssetSuggestion> {
  return apiFetch<FixedAssetSuggestion>(`/clients/${clientId}/fixed-assets/suggest?transaction_id=${transactionId}`);
}

export function suggestFixedAssetByName(clientId: number, name: string): Promise<FixedAssetSuggestion> {
  return apiFetch<FixedAssetSuggestion>(`/clients/${clientId}/fixed-assets/suggest?name=${encodeURIComponent(name)}`);
}

export function createFixedAsset(clientId: number, data: FixedAssetCreate): Promise<FixedAsset> {
  return apiFetch<FixedAsset>(`/clients/${clientId}/fixed-assets`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateFixedAsset(clientId: number, assetId: number, data: Partial<FixedAssetCreate> & { status?: string }): Promise<FixedAsset> {
  return apiFetch<FixedAsset>(`/clients/${clientId}/fixed-assets/${assetId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function disposeFixedAsset(clientId: number, assetId: number): Promise<FixedAsset> {
  return apiFetch<FixedAsset>(`/clients/${clientId}/fixed-assets/${assetId}/dispose`, {
    method: "POST",
  });
}

export function generateDepreciationJEs(
  clientId: number,
  month: string,
): Promise<{ created: number; skipped: number; month: string }> {
  return apiFetch(`/clients/${clientId}/fixed-assets/generate-depreciation?month=${month}`, {
    method: "POST",
  });
}

// ── Accrued Expenses ──────────────────────────────────────────────────────────

export interface AccruedExpense {
  id: number;
  client_id: number;
  vendor_name: string;
  description: string | null;
  service_period: string; // "YYYY-MM"
  amount: number;
  source_transaction_id: number | null;
  accrual_je_id: number | null;
  payment_je_id: number | null;
  expected_payment_date: string | null;
  status: "accrued" | "partially_paid" | "cleared";
  ai_confidence: number | null;
  ai_reasoning: string | null;
  standing_rule_id: number | null;
  debit_account: string | null;
  credit_account: string | null;
  created_at: string;
}

export interface AccrualSummary {
  total_accrued: number;
  pending_payment_count: number;
  cleared_this_month: number;
  cleared_this_month_amount: number;
}

export interface AccrualSuggestion {
  transaction_id: number;
  needs_accrual: boolean;
  vendor_name: string;
  description: string;
  service_period: string;
  expense_account: string;
  accrued_account: string;
  confidence: number;
  reasoning: string;
  amount?: number;
}

export interface StandingAccrualRule {
  id: number;
  client_id: number;
  vendor_name: string;
  description: string | null;
  expense_account: string;
  accrued_account: string;
  amount: number | null;
  active: boolean;
  last_generated: string | null;
  created_at: string;
}

export function getAccruals(clientId: number, status?: string): Promise<{ summary: AccrualSummary; accruals: AccruedExpense[] }> {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/clients/${clientId}/accruals${qs}`);
}

export function createAccrual(clientId: number, data: {
  vendor_name: string;
  description?: string;
  service_period: string;
  amount: number;
  source_transaction_id?: number;
  expected_payment_date?: string;
  expense_account: string;
  accrued_account: string;
}): Promise<AccruedExpense> {
  return apiFetch(`/clients/${clientId}/accruals`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateAccrual(clientId: number, aeId: number, data: {
  status?: string;
  expected_payment_date?: string | null;
  description?: string;
  amount?: number;
}): Promise<AccruedExpense> {
  return apiFetch(`/clients/${clientId}/accruals/${aeId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteAccrual(clientId: number, aeId: number): Promise<void> {
  return apiFetch(`/clients/${clientId}/accruals/${aeId}`, { method: "DELETE" });
}

export function releaseAccrual(clientId: number, aeId: number): Promise<{ accrual_id: number; transaction_id: number; je_id: number; service_period: string }> {
  return apiFetch(`/clients/${clientId}/accruals/${aeId}/release`, { method: "POST" });
}

export function analyzeForAccruals(clientId: number): Promise<{ suggestions: AccrualSuggestion[] }> {
  return apiFetch(`/clients/${clientId}/accruals/analyze`, { method: "POST" });
}

export function getStandingRules(clientId: number): Promise<StandingAccrualRule[]> {
  return apiFetch(`/clients/${clientId}/accruals/standing-rules`);
}

export function createStandingRule(clientId: number, data: {
  vendor_name: string;
  description?: string;
  expense_account: string;
  accrued_account?: string;
  amount?: number;
}): Promise<StandingAccrualRule> {
  return apiFetch(`/clients/${clientId}/accruals/standing-rules`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateStandingRule(clientId: number, ruleId: number, data: Partial<{
  vendor_name: string;
  description: string;
  expense_account: string;
  accrued_account: string;
  amount: number | null;
  active: boolean;
}>): Promise<StandingAccrualRule> {
  return apiFetch(`/clients/${clientId}/accruals/standing-rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteStandingRule(clientId: number, ruleId: number): Promise<void> {
  return apiFetch(`/clients/${clientId}/accruals/standing-rules/${ruleId}`, { method: "DELETE" });
}

export function generateFromStandingRules(clientId: number, month?: string): Promise<{
  generated: string[];
  skipped: string[];
  month: string;
}> {
  const qs = month ? `?month=${month}` : "";
  return apiFetch(`/clients/${clientId}/accruals/standing-rules/generate${qs}`, { method: "POST" });
}

// ── Revenue Recognition ───────────────────────────────────────────────────────

export type BillingType =
  | "annual_upfront"
  | "quarterly_upfront"
  | "monthly_advance"
  | "monthly_arrears"
  | "invoice_completion";

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  annual_upfront:    "Annual Upfront",
  quarterly_upfront: "Quarterly Upfront",
  monthly_advance:   "Monthly in Advance",
  monthly_arrears:   "Monthly in Arrears",
  invoice_completion:"Invoice at Completion",
};

export interface RevenueStream {
  id: number;
  client_id: number;
  name: string;
  billing_type: BillingType;
  revenue_account: string;
  deferred_revenue_account: string;
  ar_account: string;
  active: boolean;
  created_at: string;
}

export interface RevenueScheduleEntry {
  id: number;
  contract_id: number;
  period: string;       // "YYYY-MM"
  amount: number;
  je_id: number | null;
  recognized: boolean;
  created_at: string;
}

export interface RevenueContract {
  id: number;
  client_id: number;
  revenue_stream_id: number | null;
  customer_name: string;
  external_id: string | null;
  source: string;
  invoice_number: string | null;
  total_contract_value: number;
  billing_date: string | null;
  due_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  amount_recognized: number;
  amount_deferred: number;
  payment_received: boolean;
  payment_date: string | null;
  status: "active" | "fully_recognized" | "cancelled";
  ai_confidence: number | null;
  ai_reasoning: string | null;
  created_at: string;
  schedule: RevenueScheduleEntry[];
}

export interface RevenueSummary {
  recognized_this_month: number;
  total_deferred: number;
  total_ar_outstanding: number;
  invoices_overdue: number;
}

export interface ArAgingRow {
  id: number;
  customer_name: string;
  invoice_number: string | null;
  billing_date: string | null;
  due_date: string | null;
  amount: number;
  days_outstanding: number;
  days_past_due: number;
  aging_bucket: "current" | "1-30" | "31-60" | "61-90" | "over-90";
  source: string;
}

export interface RevenueIntegrationSettings {
  client_id: number;
  mercury_revenue_enabled: boolean;
  stripe_enabled: boolean;
  stripe_api_key: string | null;
  billcom_enabled: boolean;
  billcom_username: string | null;
  billcom_org_id: string | null;
  billcom_dev_key: string | null;
  last_stripe_sync: string | null;
  last_billcom_sync: string | null;
}

// Revenue Streams
export function getRevenueStreams(clientId: number): Promise<RevenueStream[]> {
  return apiFetch(`/clients/${clientId}/revenue/streams`);
}
export function createRevenueStream(clientId: number, data: {
  name: string; billing_type: BillingType;
  revenue_account: string; deferred_revenue_account: string; ar_account: string;
}): Promise<RevenueStream> {
  return apiFetch(`/clients/${clientId}/revenue/streams`, { method: "POST", body: JSON.stringify(data) });
}
export function updateRevenueStream(clientId: number, streamId: number, data: Partial<{
  name: string; billing_type: BillingType; revenue_account: string;
  deferred_revenue_account: string; ar_account: string; active: boolean;
}>): Promise<RevenueStream> {
  return apiFetch(`/clients/${clientId}/revenue/streams/${streamId}`, { method: "PATCH", body: JSON.stringify(data) });
}
export function deleteRevenueStream(clientId: number, streamId: number): Promise<void> {
  return apiFetch(`/clients/${clientId}/revenue/streams/${streamId}`, { method: "DELETE" });
}

// Revenue Contracts
export function getRevenueSummary(clientId: number): Promise<RevenueSummary> {
  return apiFetch(`/clients/${clientId}/revenue/summary`);
}
export function getRevenueContracts(clientId: number, status?: string): Promise<RevenueContract[]> {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/clients/${clientId}/revenue/contracts${qs}`);
}
export function createRevenueContract(clientId: number, data: {
  customer_name: string; revenue_stream_id?: number; invoice_number?: string;
  total_contract_value: number; billing_date?: string; due_date?: string;
  service_period_start?: string; service_period_end?: string;
  payment_received?: boolean; payment_date?: string; source?: string;
}): Promise<RevenueContract> {
  return apiFetch(`/clients/${clientId}/revenue/contracts`, { method: "POST", body: JSON.stringify(data) });
}
export function updateRevenueContract(clientId: number, contractId: number, data: Partial<{
  status: string; revenue_stream_id: number; service_period_start: string;
  service_period_end: string; payment_received: boolean; payment_date: string; due_date: string;
}>): Promise<RevenueContract> {
  return apiFetch(`/clients/${clientId}/revenue/contracts/${contractId}`, { method: "PATCH", body: JSON.stringify(data) });
}
export function deleteRevenueContract(clientId: number, contractId: number): Promise<void> {
  return apiFetch(`/clients/${clientId}/revenue/contracts/${contractId}`, { method: "DELETE" });
}
export function generateRevenueJEs(clientId: number, contractId: number, period?: string): Promise<{ created: string[]; contract_id: number }> {
  const qs = period ? `?period=${period}` : "";
  return apiFetch(`/clients/${clientId}/revenue/contracts/${contractId}/generate-jes${qs}`, { method: "POST" });
}

// AR Aging
export function getArAging(clientId: number): Promise<ArAgingRow[]> {
  return apiFetch(`/clients/${clientId}/revenue/ar-aging`);
}

// Integration Settings
export function getRevenueIntegrationSettings(clientId: number): Promise<RevenueIntegrationSettings> {
  return apiFetch(`/clients/${clientId}/revenue/integration-settings`);
}
export function updateRevenueIntegrationSettings(clientId: number, data: Partial<{
  mercury_revenue_enabled: boolean; stripe_enabled: boolean; stripe_api_key: string;
  billcom_enabled: boolean; billcom_username: string; billcom_password: string;
  billcom_org_id: string; billcom_dev_key: string;
}>): Promise<{ ok: boolean }> {
  return apiFetch(`/clients/${clientId}/revenue/integration-settings`, { method: "PUT", body: JSON.stringify(data) });
}
export function syncRevenueSources(clientId: number): Promise<{ imported: number; contracts: string[]; errors: string[] }> {
  return apiFetch(`/clients/${clientId}/revenue/sync`, { method: "POST" });
}
export function bulkMatchContracts(clientId: number, streamId: number): Promise<{ updated: number }> {
  return apiFetch(`/clients/${clientId}/revenue/contracts/bulk-match`, { method: "POST", body: JSON.stringify({ stream_id: streamId }) });
}
export function generateAllJEs(clientId: number): Promise<{ created: number; errors: string[] }> {
  return apiFetch(`/clients/${clientId}/revenue/generate-all-jes`, { method: "POST" });
}

// Bill.com
export function testBillcomConnection(clientId: number): Promise<{ ok: boolean; message: string }> {
  return apiFetch(`/clients/${clientId}/billcom/test`, { method: "POST" });
}
export function syncBillcomAP(clientId: number): Promise<{ imported: number; skipped: number }> {
  return apiFetch(`/clients/${clientId}/billcom/sync-ap`, { method: "POST" });
}
