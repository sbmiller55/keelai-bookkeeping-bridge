import json as _json
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas

router = APIRouter(prefix="/journal-entries", tags=["journal_entries"])


def _get_je_or_404(je_id: int, user: models.User, db: Session) -> models.JournalEntry:
    je = (
        db.query(models.JournalEntry)
        .join(models.Transaction, models.JournalEntry.transaction_id == models.Transaction.id)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.JournalEntry.id == je_id, models.Client.user_id == user.id)
        .first()
    )
    if not je:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Journal entry not found")
    return je


def _assert_transaction_owned(tx_id: int, user: models.User, db: Session) -> models.Transaction:
    tx = (
        db.query(models.Transaction)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Transaction.id == tx_id, models.Client.user_id == user.id)
        .first()
    )
    if not tx:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Transaction not found or access denied",
        )
    return tx


def _cascade_revenue_recode(edited_je: models.JournalEntry, changed: dict, db: Session) -> int:
    """When a revenue-recognition JE's account is re-coded, propagate that account
    across the whole contract's schedule — every not-yet-exported month's JE — and
    update the revenue stream so FUTURE generated months follow it too. In-place
    account updates only (no delete), so the schedule's je_id links stay intact.
    Returns the number of other JEs updated."""
    entry = (
        db.query(models.RevenueScheduleEntry)
        .filter(models.RevenueScheduleEntry.je_id == edited_je.id)
        .first()
    )
    if not entry:
        return 0
    contract = (
        db.query(models.RevenueContract)
        .filter(models.RevenueContract.id == entry.contract_id)
        .first()
    )
    if not contract:
        return 0
    stream = (
        db.query(models.RevenueStream)
        .filter(models.RevenueStream.id == contract.revenue_stream_id)
        .first()
        if contract.revenue_stream_id else None
    )
    # Update the stream so FUTURE generated months use the corrected account.
    if stream:
        bt = stream.billing_type.value if hasattr(stream.billing_type, "value") else str(stream.billing_type)
        if "credit_account" in changed:
            stream.revenue_account = edited_je.credit_account          # recognition JEs credit revenue
        if "debit_account" in changed:
            if bt in ("monthly_arrears", "invoice_completion"):
                stream.ar_account = edited_je.debit_account            # AR-based recognition
            else:
                stream.deferred_revenue_account = edited_je.debit_account
    # Cascade to every OTHER JE in this contract's schedule that isn't exported yet.
    others = (
        db.query(models.JournalEntry)
        .join(models.RevenueScheduleEntry, models.RevenueScheduleEntry.je_id == models.JournalEntry.id)
        .filter(
            models.RevenueScheduleEntry.contract_id == contract.id,
            models.JournalEntry.id != edited_je.id,
            models.JournalEntry.exported_at.is_(None),
        )
        .all()
    )
    for oje in others:
        if "credit_account" in changed:
            oje.credit_account = edited_je.credit_account
        if "debit_account" in changed:
            oje.debit_account = edited_je.debit_account
    return len(others)


@router.get("/", response_model=List[schemas.JournalEntryRead])
def list_journal_entries(
    transaction_id: Optional[int] = Query(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(models.JournalEntry)
        .join(models.Transaction, models.JournalEntry.transaction_id == models.Transaction.id)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Client.user_id == current_user.id)
    )
    if transaction_id is not None:
        query = query.filter(models.JournalEntry.transaction_id == transaction_id)
    return query.all()


@router.post("/", response_model=schemas.JournalEntryRead, status_code=status.HTTP_201_CREATED)
def create_journal_entry(
    payload: schemas.JournalEntryCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_transaction_owned(payload.transaction_id, current_user, db)
    je = models.JournalEntry(**payload.model_dump())
    je.je_number = models.next_je_number(db)
    db.add(je)
    db.commit()
    db.refresh(je)
    return je


@router.get("/{je_id}", response_model=schemas.JournalEntryRead)
def get_journal_entry(
    je_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_je_or_404(je_id, current_user, db)


@router.put("/{je_id}", response_model=schemas.JournalEntryRead)
def update_journal_entry(
    je_id: int,
    payload: schemas.JournalEntryUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    je = _get_je_or_404(je_id, current_user, db)
    changed = payload.model_dump(exclude_unset=True)

    # Capture before state for auditable fields
    audit_fields = {"debit_account", "credit_account", "amount", "memo", "customer_name"}
    before = {f: getattr(je, f) for f in audit_fields if f in changed}

    for field, value in changed.items():
        setattr(je, field, value)

    # If this is a revenue-recognition JE and its account(s) changed, cascade the
    # new account across the whole contract's schedule + the revenue stream.
    if "debit_account" in changed or "credit_account" in changed:
        tx = (
            db.query(models.Transaction)
            .filter(models.Transaction.id == je.transaction_id)
            .first()
        )
        if tx and tx.source == "revenue":
            _cascade_revenue_recode(je, changed, db)

    db.commit()
    db.refresh(je)

    # Write audit log entry for any meaningful field changes
    if before:
        after = {f: getattr(je, f) for f in before}
        db.add(models.AuditLog(
            transaction_id=je.transaction_id,
            action="je_updated",
            before_state=_json.dumps(before, default=str),
            after_state=_json.dumps(after, default=str),
            actor=current_user.id,
        ))
        db.commit()

    return je


@router.delete("/{je_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_journal_entry(
    je_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    je = _get_je_or_404(je_id, current_user, db)
    # Prevent deleting the last JE for a transaction
    count = (
        db.query(models.JournalEntry)
        .filter(models.JournalEntry.transaction_id == je.transaction_id)
        .count()
    )
    if count <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the only journal entry for a transaction",
        )
    db.delete(je)
    db.commit()
