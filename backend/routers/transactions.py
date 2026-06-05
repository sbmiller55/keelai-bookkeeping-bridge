import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
from ai_coder import generate_prepaid_jes, _parse_month, _add_months

router = APIRouter(prefix="/transactions", tags=["transactions"])


def _assert_client_owned(client_id: int, user: models.User, db: Session) -> models.Client:
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client not found or access denied")
    return client


def _get_transaction_or_404(tx_id: int, user: models.User, db: Session) -> models.Transaction:
    tx = (
        db.query(models.Transaction)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Transaction.id == tx_id, models.Client.user_id == user.id)
        .first()
    )
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    return tx


@router.get("/", response_model=List[schemas.TransactionRead])
def list_transactions(
    client_id: Optional[int] = Query(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(models.Transaction)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Client.user_id == current_user.id)
    )
    if client_id is not None:
        query = query.filter(models.Transaction.client_id == client_id)
    return query.order_by(models.Transaction.date.desc()).all()


@router.post("/", response_model=schemas.TransactionRead, status_code=status.HTTP_201_CREATED)
def create_transaction(
    payload: schemas.TransactionCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_client_owned(payload.client_id, current_user, db)
    tx = models.Transaction(**payload.model_dump())
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


@router.get("/with-entries", response_model=List[schemas.TransactionWithEntries])
def list_with_entries(
    client_id: int = Query(...),
    status_filter: Optional[str] = Query(None, alias="status"),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns transactions with their journal entries embedded, newest first."""
    _assert_client_owned(client_id, current_user, db)
    query = (
        db.query(models.Transaction)
        .filter(models.Transaction.client_id == client_id)
    )
    if status_filter:
        query = query.filter(models.Transaction.status == status_filter)
    txns = query.order_by(models.Transaction.date.desc()).all()

    # Attach journal entries
    txn_ids = [t.id for t in txns]
    if txn_ids:
        all_jes = (
            db.query(models.JournalEntry)
            .filter(models.JournalEntry.transaction_id.in_(txn_ids))
            .all()
        )
        je_map: dict[int, list] = {}
        for je in all_jes:
            je_map.setdefault(je.transaction_id, []).append(je)
    else:
        je_map = {}

    # Build a summary map for any matched invoice transactions referenced by JEs
    matched_invoice_ids = {
        je.matched_invoice_id
        for jes in je_map.values()
        for je in jes
        if getattr(je, "matched_invoice_id", None)
    }
    matched_invoice_map: dict[int, dict] = {}
    if matched_invoice_ids:
        for inv in (
            db.query(models.Transaction)
            .filter(models.Transaction.id.in_(matched_invoice_ids))
            .all()
        ):
            matched_invoice_map[inv.id] = {
                "id": inv.id,
                "vendor": inv.counterparty_name or "",
                "invoice_number": inv.invoice_number,
                "date": inv.date.isoformat() if inv.date else None,
                "amount": abs(float(inv.amount or 0)),
            }

    result = []
    for t in txns:
        t_data = schemas.TransactionWithEntries.model_validate(t)
        je_list = []
        for je in je_map.get(t.id, []):
            jed = schemas.JournalEntryRead.model_validate(je)
            if getattr(je, "matched_invoice_id", None) and je.matched_invoice_id in matched_invoice_map:
                jed.matched_invoice = matched_invoice_map[je.matched_invoice_id]
            je_list.append(jed)
        t_data.journal_entries = je_list
        result.append(t_data)
    return result


class BulkStatusResult(BaseModel):
    dry_run:        bool
    candidate_count: int
    updated_count:  int


@router.post("/bulk-update-status", response_model=BulkStatusResult)
def bulk_update_status(
    client_id: int = Query(...),
    from_status: str = Query(..., description="Current status to match"),
    to_status: str = Query(..., description="New status to set"),
    before_date: Optional[str] = Query(None, description="Only affect transactions with date < this YYYY-MM-DD"),
    confirm: str = Query("", description="Must equal 'YES' to actually run; otherwise dry-run"),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bulk move transactions between statuses. Used for catching up state when
    transactions were imported to an external system out-of-band.

    Dry-run unless confirm='YES'.
    """
    _assert_client_owned(client_id, current_user, db)

    valid = {s.value for s in models.TransactionStatus}
    if from_status not in valid or to_status not in valid:
        raise HTTPException(400, f"Invalid status. Allowed: {sorted(valid)}")

    q = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status == from_status,
        )
    )
    if before_date:
        try:
            cutoff = datetime.strptime(before_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "before_date must be YYYY-MM-DD")
        q = q.filter(models.Transaction.date < cutoff)

    candidate_count = q.count()
    if confirm != "YES":
        return BulkStatusResult(dry_run=True, candidate_count=candidate_count, updated_count=0)

    updated = q.update({"status": to_status}, synchronize_session=False)
    db.commit()
    return BulkStatusResult(dry_run=False, candidate_count=candidate_count, updated_count=updated)


@router.get("/vendors")
def get_vendors(
    client_id: int = Query(...),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return all unique counterparty names for a client, excluding dismissed vendors."""
    _assert_client_owned(client_id, current_user, db)
    from sqlalchemy import func
    dismissed = {
        r.name
        for r in db.query(models.DismissedVendor.name)
        .filter(models.DismissedVendor.client_id == client_id)
        .all()
    }
    rows = (
        db.query(
            models.Transaction.counterparty_name,
            func.count(models.Transaction.id).label("count"),
            func.max(models.Transaction.date).label("last_seen"),
        )
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.counterparty_name.isnot(None),
            models.Transaction.counterparty_name != "",
            models.Transaction.status != models.TransactionStatus.transfer,
            models.Transaction.status != models.TransactionStatus.rejected,
        )
        .group_by(models.Transaction.counterparty_name)
        .order_by(models.Transaction.counterparty_name)
        .all()
    )
    return [
        {"name": r.counterparty_name, "count": r.count, "last_seen": r.last_seen.strftime("%Y-%m-%d")}
        for r in rows
        if r.counterparty_name not in dismissed
    ]


VENDOR_CLASSES = {
    "Sales & Marketing",
    "Research & Development",
    "General & Administrative",
    "Multi-Class per vendor",
}


_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

def _normalize_vendor_name(counterparty_name: str | None, description: str) -> str | None:
    """
    Return a cleaned vendor name, preferring counterparty_name over description.
    Strips transaction-specific noise; returns title-cased result.
    """
    raw = (counterparty_name or "").strip() or (description or "").strip()
    if not raw:
        return None

    name = raw
    # Strip everything after * (e.g. "AMZN MKTP US*1A2B3C" → "AMZN MKTP US")
    name = re.sub(r'\*.*', '', name)
    # Strip trailing digit-heavy tokens (order IDs, phone numbers, zip codes)
    name = re.sub(r'[\s\-]+\d[\d\-\.]+$', '', name.strip())
    # Strip US city/state suffixes like "SAN FRANCISCO CA" or "SEATTLE WA 98109"
    name = re.sub(r'[\s,]+[A-Z]{2}\s*\d{0,5}$', '', name.strip())
    # Strip trailing month names (e.g. "Depreciation - Domain Name - February")
    name = re.sub(
        r'[\s\-]+(?:' + '|'.join(_MONTHS) + r')(?:\s+\d{4})?$',
        '', name.strip(), flags=re.IGNORECASE,
    )
    # Strip trailing punctuation / dashes
    name = re.sub(r'[\s\-\.,]+$', '', name).strip()

    name = name.title()

    _NOISE = {
        "In", "Out", "Transfer", "Debit", "Credit", "Fee", "Ach",
        "Wire", "Check", "Payment", "Deposit", "Withdrawal", "Pending",
        "Hold", "Return", "Refund", "Void", "Memo", "Note", "Other",
        "Unknown", "N/A", "Na", "None",
    }
    if len(name) < 3 or re.match(r'^\d+$', name) or name in _NOISE:
        return None

    return name


@router.get("/vendor-classes")
def get_vendor_classes(
    client_id: int = Query(...),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return all vendors ever seen for a client, with their class assignment and skip status."""
    _assert_client_owned(client_id, current_user, db)

    txns = (
        db.query(
            models.Transaction.counterparty_name,
            models.Transaction.description,
            models.Transaction.date,
        )
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status != models.TransactionStatus.transfer,
            models.Transaction.status != models.TransactionStatus.rejected,
        )
        .all()
    )

    # Group by normalized (title-cased) vendor name — case-insensitive by construction
    groups: dict[str, dict] = {}
    for txn in txns:
        name = _normalize_vendor_name(txn.counterparty_name, txn.description)
        if not name:
            continue
        if name not in groups:
            groups[name] = {"count": 0, "last_seen": txn.date}
        groups[name]["count"] += 1
        if txn.date > groups[name]["last_seen"]:
            groups[name]["last_seen"] = txn.date

    # Case-insensitive lookups so stored "ATTIO INC" matches display "Attio Inc"
    classifications = {
        r.vendor_name.lower(): r.class_name
        for r in db.query(models.VendorClassification)
        .filter(models.VendorClassification.client_id == client_id)
        .all()
    }
    skipped = {
        r.name.lower()
        for r in db.query(models.DismissedVendor.name)
        .filter(
            models.DismissedVendor.client_id == client_id,
            models.DismissedVendor.reason == "skipped",
        )
        .all()
    }

    return sorted(
        [
            {
                "name": name,
                "count": data["count"],
                "last_seen": data["last_seen"].strftime("%Y-%m-%d"),
                "class_name": classifications.get(name.lower()),
                "skipped": name.lower() in skipped,
            }
            for name, data in groups.items()
        ],
        key=lambda r: r["name"],
    )


class VendorSkipRequest(BaseModel):
    client_id: int
    name: str


@router.post("/vendor-classes/skip", status_code=status.HTTP_204_NO_CONTENT)
def skip_vendor(
    payload: VendorSkipRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark a vendor as skipped so it is hidden from the classification view."""
    _assert_client_owned(payload.client_id, current_user, db)
    existing = (
        db.query(models.DismissedVendor)
        .filter(
            models.DismissedVendor.client_id == payload.client_id,
            models.DismissedVendor.name == payload.name,
        )
        .first()
    )
    if existing:
        existing.reason = "skipped"
        existing.dismissed_at = datetime.utcnow()
    else:
        db.add(models.DismissedVendor(
            client_id=payload.client_id,
            name=payload.name,
            reason="skipped",
        ))
    db.commit()


@router.post("/vendor-classes/unskip", status_code=status.HTTP_204_NO_CONTENT)
def unskip_vendor(
    payload: VendorSkipRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a vendor from the skipped list."""
    _assert_client_owned(payload.client_id, current_user, db)
    db.query(models.DismissedVendor).filter(
        models.DismissedVendor.client_id == payload.client_id,
        models.DismissedVendor.name == payload.name,
        models.DismissedVendor.reason == "skipped",
    ).delete()
    db.commit()


class VendorClassRequest(BaseModel):
    client_id: int
    vendor_name: str
    class_name: Optional[str]  # None to clear


@router.post("/vendor-classes", status_code=status.HTTP_204_NO_CONTENT)
def set_vendor_class(
    payload: VendorClassRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Assign or clear a class for a vendor."""
    _assert_client_owned(payload.client_id, current_user, db)
    if payload.class_name is not None and payload.class_name not in VENDOR_CLASSES:
        raise HTTPException(status_code=400, detail=f"Invalid class: {payload.class_name!r}")
    existing = (
        db.query(models.VendorClassification)
        .filter(
            models.VendorClassification.client_id == payload.client_id,
            models.VendorClassification.vendor_name == payload.vendor_name,
        )
        .first()
    )
    if payload.class_name is None:
        if existing:
            db.delete(existing)
    elif existing:
        existing.class_name = payload.class_name
        existing.updated_at = datetime.utcnow()
    else:
        db.add(models.VendorClassification(
            client_id=payload.client_id,
            vendor_name=payload.vendor_name,
            class_name=payload.class_name,
        ))
    db.commit()


class VendorDismissRequest(BaseModel):
    client_id: int
    names: List[str]
    reason: str  # "exported" | "deleted"


@router.post("/vendors/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_vendors(
    payload: VendorDismissRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark vendors as dismissed (exported or deleted) so they no longer appear in the list."""
    _assert_client_owned(payload.client_id, current_user, db)
    for name in payload.names:
        existing = (
            db.query(models.DismissedVendor)
            .filter(
                models.DismissedVendor.client_id == payload.client_id,
                models.DismissedVendor.name == name,
            )
            .first()
        )
        if existing:
            existing.reason = payload.reason
            existing.dismissed_at = datetime.utcnow()
        else:
            db.add(models.DismissedVendor(
                client_id=payload.client_id,
                name=name,
                reason=payload.reason,
            ))
    db.commit()


@router.get("/{transaction_id}", response_model=schemas.TransactionRead)
def get_transaction(
    transaction_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_transaction_or_404(transaction_id, current_user, db)


@router.put("/{transaction_id}", response_model=schemas.TransactionRead)
def update_transaction(
    transaction_id: int,
    payload: schemas.TransactionUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tx = _get_transaction_or_404(transaction_id, current_user, db)
    prev_status = tx.status
    fields = payload.model_dump(exclude_unset=True)

    new_status_str  = str(fields.get("status") or "").lower()
    prev_status_str = str(prev_status.value if hasattr(prev_status, "value") else prev_status).lower()

    # Hard COA validation at approval time. The dropdown lock prevents bad
    # account names from being typed in the Review Queue, but rules and AI
    # coding can still produce JEs with names that don't exist in the live
    # QBO chart of accounts (or that point at a parent/header account QBO
    # rejects on JE import). Block the approval here so the user finds out
    # NOW, not when the export downloads / sync fails.
    if new_status_str == "approved" and prev_status_str != "approved":
        client = (
            db.query(models.Client)
            .filter(models.Client.id == tx.client_id, models.Client.user_id == current_user.id)
            .first()
        )
        bad_names = _coa_violations_for_transaction(tx, client, db)
        if bad_names:
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "coa_validation_failed",
                    "message": (
                        "Cannot approve: journal entry references account name(s) not in your "
                        "live QBO chart of accounts: " + ", ".join(f'"{n}"' for n in bad_names) +
                        ". Fix the account name in the Review Queue (use the dropdown) before approving."
                    ),
                    "bad_account_names": bad_names,
                },
            )

    for field, value in fields.items():
        setattr(tx, field, value)

    # Auto-clear linked accruals when a payment transitions to approved.
    # Catches both AI-matched payments and manually coded DR Accrued / CR Bank entries.
    if new_status_str == "approved" and prev_status_str != "approved":
        _auto_clear_accruals_for_transaction(tx, db)

    db.commit()
    db.refresh(tx)
    return tx


def _coa_violations_for_transaction(
    tx: models.Transaction,
    client: Optional[models.Client],
    db: Session,
) -> list[str]:
    """Return the distinct list of JE account names referenced by this
    transaction that don't exist in the client's live QBO postable COA.
    Empty list = OK to approve."""
    if not client:
        return []
    try:
        import ai_coder as _ai
        chart = _ai._resolve_chart(client)
        coa_set = _ai._parse_coa_set(chart)
    except Exception:
        coa_set = None
    if not coa_set:
        # If we can't reach QBO we don't want to lock the user out of
        # approvals — log the gap and pass through.
        return []
    always_valid = {a.lower() for a in _ai._ALWAYS_VALID_ACCOUNTS}
    valid = coa_set | always_valid

    jes = (
        db.query(models.JournalEntry)
        .filter(models.JournalEntry.transaction_id == tx.id)
        .all()
    )
    bad: list[str] = []
    seen: set[str] = set()
    for je in jes:
        for name in (je.debit_account, je.credit_account):
            if not name:
                continue
            if name.lower() not in valid and name not in seen:
                bad.append(name)
                seen.add(name)
    return bad


def _auto_clear_accruals_for_transaction(tx: models.Transaction, db: Session) -> None:
    """Mark linked AccruedExpense rows as cleared when a payment is approved.

    Two paths:
      1. JE has matched_invoice_id → clear the AccruedExpense whose
         source_transaction_id = matched_invoice_id.
      2. JE debits an accrual liability ('accrued' in account name) → find an
         open AccruedExpense for same client + vendor with matching amount.
    """
    jes = (
        db.query(models.JournalEntry)
        .filter(models.JournalEntry.transaction_id == tx.id)
        .all()
    )
    if not jes:
        return

    vendor = (tx.counterparty_name or tx.description or "").strip()
    for je in jes:
        # Path 1: AI-matched JE references the invoice transaction directly
        if getattr(je, "matched_invoice_id", None):
            ae = (
                db.query(models.AccruedExpense)
                .filter(
                    models.AccruedExpense.client_id == tx.client_id,
                    models.AccruedExpense.source_transaction_id == je.matched_invoice_id,
                    models.AccruedExpense.status != models.AccruedExpenseStatus.cleared,
                )
                .first()
            )
            if ae:
                ae.status = models.AccruedExpenseStatus.cleared
                ae.payment_je_id = je.id
                continue

        # Path 2: JE debits an accrual liability — find a matching open accrual
        # by client + vendor (case-insensitive substring) + amount within 2%
        debit = (je.debit_account or "").lower()
        if "accrued" not in debit:
            continue
        je_amt = abs(float(je.amount or 0))
        if je_amt == 0 or not vendor:
            continue
        candidates = (
            db.query(models.AccruedExpense)
            .filter(
                models.AccruedExpense.client_id == tx.client_id,
                models.AccruedExpense.status != models.AccruedExpenseStatus.cleared,
            )
            .all()
        )
        v_lower = vendor.lower()
        best = None
        for ae in candidates:
            ae_vendor = (ae.vendor_name or "").lower()
            if not ae_vendor or len(ae_vendor) < 3:
                continue
            if ae_vendor not in v_lower and v_lower not in ae_vendor:
                continue
            ae_amt = float(ae.amount or 0)
            if ae_amt == 0:
                continue
            diff = abs(ae_amt - je_amt) / ae_amt
            if diff > 0.02:
                continue
            if best is None or diff < best[1]:
                best = (ae, diff)
        if best is not None:
            ae = best[0]
            ae.status = models.AccruedExpenseStatus.cleared
            ae.payment_je_id = je.id


@router.delete("/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(
    transaction_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tx = _get_transaction_or_404(transaction_id, current_user, db)
    db.query(models.JournalEntry).filter(models.JournalEntry.transaction_id == tx.id).delete()
    db.delete(tx)
    db.commit()


class PrepaidRequest(BaseModel):
    service_start: str   # "2025-01" or "January 2025"
    service_end: str
    expense_account: str
    prepaid_account: str = "Prepaid Expenses"


@router.post("/{transaction_id}/prepaid")
def code_as_prepaid(
    transaction_id: int,
    payload: PrepaidRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Replace all JEs for a transaction with a prepaid payment JE + monthly amortization JEs."""
    tx = _get_transaction_or_404(transaction_id, current_user, db)

    service_start = _parse_month(payload.service_start)
    if not service_start:
        raise HTTPException(status_code=400, detail=f"Could not parse service_start: {payload.service_start!r}")
    service_end = _parse_month(payload.service_end)
    if not service_end:
        raise HTTPException(status_code=400, detail=f"Could not parse service_end: {payload.service_end!r}")
    if service_end < service_start:
        raise HTTPException(status_code=400, detail="service_end must be on or after service_start")

    bank_account = tx.mercury_account_name or "Mercury Checking"
    vendor = tx.counterparty_name or tx.description or "Vendor"
    total_amount = abs(tx.amount)

    # Delete existing JEs
    db.query(models.JournalEntry).filter(models.JournalEntry.transaction_id == tx.id).delete()

    je_data_list = generate_prepaid_jes(
        total_amount=total_amount,
        payment_date=tx.date,
        bank_account=bank_account,
        expense_account=payload.expense_account,
        prepaid_account=payload.prepaid_account,
        service_start=service_start,
        service_end=service_end,
        vendor=vendor,
        confidence=1.0,
        reasoning="Manually coded as prepaid annual expense.",
    )

    created = []
    for jd in je_data_list:
        je = models.JournalEntry(
            transaction_id=tx.id,
            debit_account=jd["debit_account"][:255],
            credit_account=jd["credit_account"][:255],
            amount=jd["amount"],
            je_date=jd.get("je_date"),
            memo=jd.get("memo", "")[:500],
            ai_confidence=jd.get("ai_confidence", 1.0),
            ai_reasoning=jd.get("ai_reasoning", "")[:1000],
            service_period_start=jd.get("service_period_start"),
            service_period_end=jd.get("service_period_end"),
            is_recurring=jd.get("is_recurring", False),
            recur_frequency=jd.get("recur_frequency"),
            recur_end_date=jd.get("recur_end_date"),
        )
        db.add(je)
        created.append(je)

    db.commit()
    for je in created:
        db.refresh(je)

    return [
        {
            "id": je.id,
            "debit_account": je.debit_account,
            "credit_account": je.credit_account,
            "amount": je.amount,
            "je_date": je.je_date.strftime("%Y-%m-%d") if je.je_date else None,
            "memo": je.memo,
            "ai_confidence": je.ai_confidence,
            "ai_reasoning": je.ai_reasoning,
            "service_period_start": je.service_period_start.strftime("%Y-%m-%d") if je.service_period_start else None,
            "service_period_end": je.service_period_end.strftime("%Y-%m-%d") if je.service_period_end else None,
        }
        for je in created
    ]


@router.delete("/", status_code=status.HTTP_405_METHOD_NOT_ALLOWED)
def bulk_delete_transactions():
    raise HTTPException(status_code=405, detail="Bulk transaction deletion is disabled.")
