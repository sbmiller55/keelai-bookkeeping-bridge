from datetime import datetime
from typing import TYPE_CHECKING
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Enum as SAEnum,
)
from sqlalchemy.orm import relationship
from database import Base
import enum


class TransactionStatus(str, enum.Enum):
    pending = "pending"
    reviewed = "reviewed"
    approved = "approved"
    exported = "exported"
    rejected = "rejected"
    transfer = "transfer"  # internal Mercury transfer duplicate — no JE needed


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    name = Column(String, nullable=False)
    subscription_tier = Column(String, default="free", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    clients = relationship("Client", back_populates="owner")


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    mercury_api_key_encrypted = Column(Text, nullable=True)
    qbo_oauth_token = Column(Text, nullable=True)       # legacy — kept for compat
    qbo_access_token = Column(Text, nullable=True)
    qbo_refresh_token = Column(Text, nullable=True)
    qbo_realm_id = Column(String, nullable=True)
    qbo_token_expires_at = Column(DateTime, nullable=True)
    chart_of_accounts_path = Column(String, nullable=True)
    policy_path = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_sync_at = Column(DateTime, nullable=True)

    owner = relationship("User", back_populates="clients")
    transactions = relationship("Transaction", back_populates="client")
    rules = relationship("Rule", back_populates="client")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    mercury_transaction_id = Column(String, nullable=True, index=True)
    date = Column(DateTime, nullable=False)
    description = Column(String, nullable=False)
    amount = Column(Float, nullable=False)
    mercury_category = Column(String, nullable=True)
    kind = Column(String, nullable=True)
    counterparty_name = Column(String, nullable=True)
    mercury_account_id = Column(String, nullable=True)
    mercury_account_name = Column(String, nullable=True)
    payment_method = Column(String, nullable=True)
    invoice_number = Column(String, nullable=True)
    raw_data = Column(Text, nullable=True)
    invoice_text = Column(Text, nullable=True)
    mercury_status = Column(String(50), nullable=True)
    status = Column(
        SAEnum(TransactionStatus),
        default=TransactionStatus.pending,
        nullable=False,
    )
    imported_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    client = relationship("Client", back_populates="transactions")
    journal_entries = relationship("JournalEntry", back_populates="transaction")
    audit_logs = relationship("AuditLog", back_populates="transaction")


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(Integer, primary_key=True, index=True)
    je_number = Column(Integer, unique=True, nullable=True, index=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), nullable=False)
    debit_account = Column(String, nullable=False)
    credit_account = Column(String, nullable=False)
    amount = Column(Float, nullable=False)
    je_date = Column(DateTime, nullable=True)
    service_period_start = Column(DateTime, nullable=True)
    service_period_end = Column(DateTime, nullable=True)
    memo = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    ai_confidence = Column(Float, nullable=True)
    ai_reasoning = Column(Text, nullable=True)
    rule_applied = Column(Integer, ForeignKey("rules.id"), nullable=True)
    parent_je_id = Column(Integer, ForeignKey("journal_entries.id"), nullable=True)
    approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    exported_at = Column(DateTime, nullable=True)
    export_file = Column(String, nullable=True)
    qbo_je_id = Column(String, nullable=True)           # QBO's ID for this JE after direct sync
    qbo_object_type = Column(String, nullable=True)     # "Purchase" or "JournalEntry"
    qbo_export_error = Column(Text, nullable=True)      # error message if QBO sync failed
    is_recurring = Column(Boolean, default=False, nullable=True)
    recur_frequency = Column(String(20), nullable=True)  # "MONTHLY"
    recur_end_date = Column(DateTime, nullable=True)

    transaction = relationship("Transaction", back_populates="journal_entries")
    approver = relationship("User", foreign_keys=[approved_by])
    children = relationship(
        "JournalEntry",
        foreign_keys=[parent_je_id],
        backref="parent",
        remote_side="JournalEntry.id",
    )


class Rule(Base):
    __tablename__ = "rules"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    match_type = Column(String, nullable=False)
    match_value = Column(String, nullable=False)
    debit_account = Column(String, nullable=False)
    credit_account = Column(String, nullable=False)
    rule_action = Column(String(20), default="expense", nullable=False)
    rule_metadata = Column(Text, nullable=True)
    created_from_transaction_id = Column(
        Integer, ForeignKey("transactions.id"), nullable=True
    )
    active = Column(Boolean, default=True, nullable=False)

    client = relationship("Client", back_populates="rules")


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), nullable=False)
    action = Column(String, nullable=False)
    before_state = Column(Text, nullable=True)
    after_state = Column(Text, nullable=True)
    actor = Column(Integer, ForeignKey("users.id"), nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False)

    transaction = relationship("Transaction", back_populates="audit_logs")
    actor_user = relationship("User", foreign_keys=[actor])


class ClientChatMessage(Base):
    __tablename__ = "client_chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    role = Column(String(20), nullable=False)   # "user" or "assistant"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class VendorClassification(Base):
    __tablename__ = "vendor_classifications"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    vendor_name = Column(String, nullable=False)
    class_name = Column(String(50), nullable=False)  # "Sales & Marketing" | "Research & Development" | "General & Administrative"
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class DismissedVendor(Base):
    __tablename__ = "dismissed_vendors"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    name = Column(String, nullable=False)
    reason = Column(String(20), nullable=False)  # "exported" | "deleted"
    dismissed_at = Column(DateTime, default=datetime.utcnow, nullable=False)


_JE_NUMBER_START = 10001


def next_je_number(db) -> int:
    """Return the next available JE number (never below 10001, never a duplicate)."""
    from sqlalchemy import func
    max_num = db.query(func.max(JournalEntry.je_number)).scalar()
    return max((_JE_NUMBER_START, (max_num or _JE_NUMBER_START - 1) + 1))


class ModelUpdate(Base):
    __tablename__ = "model_updates"

    id = Column(Integer, primary_key=True, index=True)
    previous_version = Column(String, nullable=True)
    new_version = Column(String, nullable=True)
    detected_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    applied_at = Column(DateTime, nullable=True)
    skipped = Column(Boolean, default=False, nullable=False)


class CloseChecklistItem(Base):
    __tablename__ = "close_checklist_items"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    order_index = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    description = Column(String, nullable=True)
    due_rule = Column(String, nullable=False)
    # due_rule values: "2nd_biz_day", "last_biz_day", "day_N" (N=1-31, 29-31 = last day of month)
    milestone = Column(String, nullable=True)  # e.g. "Soft Close completed"
    recurrence = Column(String, nullable=False, default="monthly")
    # recurrence values: "monthly", "quarter_end", "once"


class CloseChecklistCompletion(Base):
    __tablename__ = "close_checklist_completions"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(Integer, ForeignKey("close_checklist_items.id"), nullable=False)
    close_month = Column(String, nullable=False)  # "2026-02" format
    completed_at = Column(DateTime, default=datetime.utcnow)
