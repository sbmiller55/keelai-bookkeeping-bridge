from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr


# ── User schemas ──────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: str


class UserRead(BaseModel):
    id: int
    email: str
    name: str
    subscription_tier: str
    created_at: datetime

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    name: Optional[str] = None
    subscription_tier: Optional[str] = None


# ── Auth schemas ──────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserRead


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


# ── Client schemas ────────────────────────────────────────────────────────────

class ClientCreate(BaseModel):
    name: str
    mercury_api_key_encrypted: Optional[str] = None
    qbo_oauth_token: Optional[str] = None
    chart_of_accounts_path: Optional[str] = None
    policy_path: Optional[str] = None


class ClientRead(BaseModel):
    id: int
    user_id: int
    name: str
    mercury_api_key_encrypted: Optional[str] = None
    qbo_oauth_token: Optional[str] = None
    chart_of_accounts_path: Optional[str] = None
    policy_path: Optional[str] = None
    created_at: datetime
    last_sync_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    mercury_api_key_encrypted: Optional[str] = None
    qbo_oauth_token: Optional[str] = None
    chart_of_accounts_path: Optional[str] = None
    policy_path: Optional[str] = None
    last_sync_at: Optional[datetime] = None


# ── Transaction schemas ───────────────────────────────────────────────────────

class TransactionCreate(BaseModel):
    client_id: int
    mercury_transaction_id: Optional[str] = None
    date: datetime
    description: str
    amount: float
    mercury_category: Optional[str] = None


class TransactionRead(BaseModel):
    id: int
    client_id: int
    mercury_transaction_id: Optional[str] = None
    date: datetime
    description: str
    amount: float
    mercury_category: Optional[str] = None
    kind: Optional[str] = None
    counterparty_name: Optional[str] = None
    mercury_account_id: Optional[str] = None
    mercury_account_name: Optional[str] = None
    payment_method: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_text: Optional[str] = None
    mercury_status: Optional[str] = None
    status: str
    imported_at: datetime
    source: Optional[str] = "mercury"
    fixed_asset_id: Optional[int] = None

    model_config = {"from_attributes": True}


class TransactionUpdate(BaseModel):
    status: Optional[str] = None
    description: Optional[str] = None
    mercury_category: Optional[str] = None
    date: Optional[datetime] = None


# ── Journal Entry schemas ─────────────────────────────────────────────────────

class JournalEntryCreate(BaseModel):
    transaction_id: int
    debit_account: str
    credit_account: str
    amount: float
    je_date: Optional[datetime] = None
    service_period_start: Optional[datetime] = None
    service_period_end: Optional[datetime] = None
    memo: Optional[str] = None
    description: Optional[str] = None
    ai_confidence: Optional[float] = None
    ai_reasoning: Optional[str] = None
    rule_applied: Optional[int] = None
    parent_je_id: Optional[int] = None


class JournalEntryRead(BaseModel):
    id: int
    je_number: Optional[int] = None
    transaction_id: int
    debit_account: str
    credit_account: str
    amount: float
    je_date: Optional[datetime] = None
    service_period_start: Optional[datetime] = None
    service_period_end: Optional[datetime] = None
    memo: Optional[str] = None
    description: Optional[str] = None
    ai_confidence: Optional[float] = None
    ai_reasoning: Optional[str] = None
    rule_applied: Optional[int] = None
    parent_je_id: Optional[int] = None
    approved_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    exported_at: Optional[datetime] = None
    export_file: Optional[str] = None
    is_recurring: Optional[bool] = None
    recur_frequency: Optional[str] = None
    recur_end_date: Optional[datetime] = None
    qbo_object_type: Optional[str] = None

    model_config = {"from_attributes": True}


class TransactionWithEntries(TransactionRead):
    journal_entries: list["JournalEntryRead"] = []

    model_config = {"from_attributes": True}


class JournalEntryUpdate(BaseModel):
    debit_account: Optional[str] = None
    credit_account: Optional[str] = None
    amount: Optional[float] = None
    je_date: Optional[datetime] = None
    service_period_start: Optional[datetime] = None
    service_period_end: Optional[datetime] = None
    memo: Optional[str] = None
    description: Optional[str] = None
    ai_confidence: Optional[float] = None
    ai_reasoning: Optional[str] = None
    approved_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    exported_at: Optional[datetime] = None
    export_file: Optional[str] = None
    is_recurring: Optional[bool] = None
    recur_frequency: Optional[str] = None
    recur_end_date: Optional[datetime] = None


# ── Rule schemas ──────────────────────────────────────────────────────────────

class RuleCreate(BaseModel):
    client_id: int
    match_type: str
    match_value: str
    debit_account: str
    credit_account: str
    rule_action: str = "expense"
    rule_metadata: Optional[str] = None
    created_from_transaction_id: Optional[int] = None
    active: bool = True


class RuleRead(BaseModel):
    id: int
    client_id: int
    match_type: str
    match_value: str
    debit_account: str
    credit_account: str
    rule_action: str
    rule_metadata: Optional[str] = None
    created_from_transaction_id: Optional[int] = None
    active: bool

    model_config = {"from_attributes": True}


class RuleUpdate(BaseModel):
    match_type: Optional[str] = None
    match_value: Optional[str] = None
    debit_account: Optional[str] = None
    credit_account: Optional[str] = None
    rule_action: Optional[str] = None
    rule_metadata: Optional[str] = None
    active: Optional[bool] = None


# ── Audit Log schemas ─────────────────────────────────────────────────────────

class AuditLogCreate(BaseModel):
    transaction_id: int
    action: str
    before_state: Optional[str] = None
    after_state: Optional[str] = None
    actor: int


class AuditLogRead(BaseModel):
    id: int
    transaction_id: int
    action: str
    before_state: Optional[str] = None
    after_state: Optional[str] = None
    actor: int
    timestamp: datetime

    model_config = {"from_attributes": True}


# ── Close Checklist schemas ────────────────────────────────────────────────────

class CloseChecklistItemCreate(BaseModel):
    title: str
    description: Optional[str] = None
    due_rule: str
    order_index: int
    milestone: Optional[str] = None
    recurrence: str = "monthly"  # "monthly", "quarter_end", "once"


class CloseChecklistItemUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_rule: Optional[str] = None
    order_index: Optional[int] = None
    milestone: Optional[str] = None
    recurrence: Optional[str] = None


class CloseChecklistItemRead(BaseModel):
    id: int
    client_id: int
    order_index: int
    title: str
    description: Optional[str] = None
    due_rule: str
    milestone: Optional[str] = None
    recurrence: str = "monthly"
    completed_at: Optional[datetime] = None  # populated when fetching with close_month

    model_config = {"from_attributes": True}


class CompleteItemRequest(BaseModel):
    close_month: str  # "2026-02"


# ── Fixed Asset schemas ───────────────────────────────────────────────────────

class FixedAssetCreate(BaseModel):
    transaction_id: Optional[int] = None
    je_id: Optional[int] = None  # JE to recode
    name: str
    category: str
    purchase_date: str  # "YYYY-MM-DD"
    purchase_price: float
    salvage_value: float = 0.0
    useful_life_months: int = 0  # 0 = indefinite (Goodwill)
    depreciation_method: str = "straight_line"
    asset_type: str = "tangible"  # "tangible" | "intangible"
    is_indefinite_life: bool = False
    qbo_asset_account: Optional[str] = None
    qbo_accum_dep_account: Optional[str] = None
    qbo_dep_expense_account: Optional[str] = None
    notes: Optional[str] = None


class FixedAssetUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    purchase_date: Optional[str] = None
    purchase_price: Optional[float] = None
    salvage_value: Optional[float] = None
    useful_life_months: Optional[int] = None
    depreciation_method: Optional[str] = None
    asset_type: Optional[str] = None
    is_indefinite_life: Optional[bool] = None
    qbo_asset_account: Optional[str] = None
    qbo_accum_dep_account: Optional[str] = None
    qbo_dep_expense_account: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class DepreciationPeriod(BaseModel):
    period: str
    date: str
    depreciation: float
    accumulated_depreciation: float
    net_book_value: float


class FixedAssetRead(BaseModel):
    id: int
    client_id: int
    transaction_id: Optional[int] = None
    name: str
    category: str
    purchase_date: str
    purchase_price: float
    salvage_value: float
    useful_life_months: int
    depreciation_method: str
    asset_type: str = "tangible"
    is_indefinite_life: bool = False
    qbo_asset_account: Optional[str] = None
    qbo_accum_dep_account: Optional[str] = None
    qbo_dep_expense_account: Optional[str] = None
    status: str
    notes: Optional[str] = None
    created_at: datetime
    # Computed fields
    monthly_depreciation: float = 0.0
    accumulated_depreciation_to_date: float = 0.0
    net_book_value: float = 0.0
    schedule: list[DepreciationPeriod] = []

    model_config = {"from_attributes": True}
