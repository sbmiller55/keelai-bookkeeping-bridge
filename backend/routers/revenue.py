"""
Revenue Recognition Schedule endpoints.

Routes:
  GET  /clients/{id}/revenue/summary
  GET  /clients/{id}/revenue/streams
  POST /clients/{id}/revenue/streams
  PATCH /clients/{id}/revenue/streams/{sid}
  DELETE /clients/{id}/revenue/streams/{sid}
  GET  /clients/{id}/revenue/contracts
  POST /clients/{id}/revenue/contracts
  PATCH /clients/{id}/revenue/contracts/{cid}
  DELETE /clients/{id}/revenue/contracts/{cid}
  POST /clients/{id}/revenue/contracts/{cid}/generate-jes
  GET  /clients/{id}/revenue/ar-aging
  GET  /clients/{id}/revenue/integration-settings
  PUT  /clients/{id}/revenue/integration-settings
  POST /clients/{id}/revenue/sync
"""

import calendar
import json
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import (
    BillingType,
    Client,
    JournalEntry,
    RevenueContract,
    RevenueContractStatus,
    RevenueIntegrationSettings,
    RevenueScheduleEntry,
    RevenueStream,
    Transaction,
    TransactionStatus,
    User,
    next_je_number,
)
from schemas import (
    RevenueContractCreate,
    RevenueContractRead,
    RevenueContractUpdate,
    RevenueIntegrationSettingsRead,
    RevenueIntegrationSettingsUpdate,
    RevenueScheduleEntryRead,
    RevenueSummary,
    RevenueStreamCreate,
    RevenueStreamRead,
    RevenueStreamUpdate,
)

router = APIRouter(prefix="/clients/{client_id}/revenue", tags=["revenue"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_client(client_id: int, user: User, db: Session) -> Client:
    c = db.query(Client).filter(Client.id == client_id, Client.user_id == user.id).first()
    if not c:
        raise HTTPException(404, "Client not found")
    return c


def _current_month() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def _last_day(year: int, month: int) -> datetime:
    return datetime(year, month, calendar.monthrange(year, month)[1])


def _add_months(dt: datetime, n: int) -> datetime:
    month = dt.month + n
    year = dt.year + (month - 1) // 12
    month = (month - 1) % 12 + 1
    return dt.replace(year=year, month=month, day=1)


def _get_or_create_integration_settings(client_id: int, db: Session) -> RevenueIntegrationSettings:
    settings = db.query(RevenueIntegrationSettings).filter(
        RevenueIntegrationSettings.client_id == client_id
    ).first()
    if not settings:
        settings = RevenueIntegrationSettings(client_id=client_id)
        db.add(settings)
        db.flush()
    return settings


def _build_schedule(contract: RevenueContract, stream: Optional[RevenueStream]) -> list[dict]:
    """Generate the month-by-month recognition schedule entries for a contract."""
    if not stream or not contract.service_period_start or not contract.service_period_end:
        return []

    start = contract.service_period_start.replace(day=1)
    end = contract.service_period_end.replace(day=1)
    n_months = (end.year - start.year) * 12 + (end.month - start.month) + 1
    if n_months < 1:
        n_months = 1

    monthly = round(contract.total_contract_value / n_months, 2)
    # Adjust last month for rounding
    periods = []
    current = start
    total = 0.0
    for i in range(n_months):
        is_last = (i == n_months - 1)
        amt = round(contract.total_contract_value - total, 2) if is_last else monthly
        periods.append({
            "period": current.strftime("%Y-%m"),
            "amount": amt,
        })
        total += amt
        current = _add_months(current, 1)
    return periods


def _enrich_contract(contract: RevenueContract, db: Session) -> dict:
    entries = db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.contract_id == contract.id
    ).order_by(RevenueScheduleEntry.period).all()
    d = {
        "id": contract.id,
        "client_id": contract.client_id,
        "revenue_stream_id": contract.revenue_stream_id,
        "customer_name": contract.customer_name,
        "external_id": contract.external_id,
        "source": contract.source,
        "invoice_number": contract.invoice_number,
        "total_contract_value": contract.total_contract_value,
        "billing_date": contract.billing_date.isoformat() if contract.billing_date else None,
        "due_date": contract.due_date.isoformat() if contract.due_date else None,
        "service_period_start": contract.service_period_start.isoformat() if contract.service_period_start else None,
        "service_period_end": contract.service_period_end.isoformat() if contract.service_period_end else None,
        "amount_recognized": contract.amount_recognized,
        "amount_deferred": round(contract.total_contract_value - contract.amount_recognized, 2),
        "payment_received": contract.payment_received,
        "payment_date": contract.payment_date.isoformat() if contract.payment_date else None,
        "status": contract.status.value if contract.status else "active",
        "ai_confidence": contract.ai_confidence,
        "ai_reasoning": contract.ai_reasoning,
        "created_at": contract.created_at.isoformat(),
        "schedule": [
            {"id": e.id, "period": e.period, "amount": e.amount, "je_id": e.je_id, "recognized": e.recognized}
            for e in entries
        ],
    }
    return d


# ── Summary ───────────────────────────────────────────────────────────────────

@router.get("/summary")
def get_summary(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    this_month = _current_month()
    now = datetime.utcnow()

    contracts = db.query(RevenueContract).filter(
        RevenueContract.client_id == client_id
    ).all()

    # Revenue recognized this month: sum of schedule entries recognized in this_month with a JE
    recognized_entries = db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.client_id == client_id,
        RevenueScheduleEntry.period == this_month,
        RevenueScheduleEntry.recognized == True,
    ).all()
    recognized_this_month = sum(e.amount for e in recognized_entries)

    # Total deferred: contracts where billing_type has deferred component, payment received but not fully recognized
    total_deferred = sum(
        max(0.0, c.total_contract_value - c.amount_recognized)
        for c in contracts
        if c.payment_received and c.status == RevenueContractStatus.active
    )

    # Total AR outstanding: contracts where payment not received
    total_ar = sum(
        c.total_contract_value - c.amount_recognized
        for c in contracts
        if not c.payment_received and c.status == RevenueContractStatus.active
    )

    # Overdue: AR contracts with due_date in the past
    overdue_count = sum(
        1 for c in contracts
        if not c.payment_received
        and c.due_date
        and c.due_date < now
        and c.status == RevenueContractStatus.active
    )

    return RevenueSummary(
        recognized_this_month=round(recognized_this_month, 2),
        total_deferred=round(total_deferred, 2),
        total_ar_outstanding=round(total_ar, 2),
        invoices_overdue=overdue_count,
    )


# ── Revenue Streams ───────────────────────────────────────────────────────────

@router.get("/streams")
def list_streams(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    streams = db.query(RevenueStream).filter(RevenueStream.client_id == client_id).all()
    return [RevenueStreamRead.model_validate(s) for s in streams]


@router.post("/streams")
def create_stream(
    client_id: int,
    body: RevenueStreamCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    try:
        BillingType(body.billing_type)
    except ValueError:
        raise HTTPException(400, f"Invalid billing_type: {body.billing_type}")
    stream = RevenueStream(client_id=client_id, **body.model_dump())
    db.add(stream)
    db.commit()
    db.refresh(stream)
    return RevenueStreamRead.model_validate(stream)


@router.patch("/streams/{stream_id}")
def update_stream(
    client_id: int,
    stream_id: int,
    body: RevenueStreamUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    stream = db.query(RevenueStream).filter(
        RevenueStream.id == stream_id, RevenueStream.client_id == client_id
    ).first()
    if not stream:
        raise HTTPException(404, "Revenue stream not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(stream, field, val)
    db.commit()
    db.refresh(stream)
    return RevenueStreamRead.model_validate(stream)


@router.delete("/streams/{stream_id}")
def delete_stream(
    client_id: int,
    stream_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    stream = db.query(RevenueStream).filter(
        RevenueStream.id == stream_id, RevenueStream.client_id == client_id
    ).first()
    if not stream:
        raise HTTPException(404, "Revenue stream not found")
    db.delete(stream)
    db.commit()
    return {"ok": True}


# ── Revenue Contracts ─────────────────────────────────────────────────────────

@router.get("/contracts")
def list_contracts(
    client_id: int,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    q = db.query(RevenueContract).filter(RevenueContract.client_id == client_id)
    if status:
        q = q.filter(RevenueContract.status == status)
    contracts = q.order_by(RevenueContract.billing_date.desc().nullslast()).all()
    return [_enrich_contract(c, db) for c in contracts]


@router.post("/contracts")
def create_contract(
    client_id: int,
    body: RevenueContractCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    contract = RevenueContract(client_id=client_id, **body.model_dump())
    db.add(contract)
    db.flush()

    # Auto-generate schedule entries if stream and service period are set
    if body.revenue_stream_id and body.service_period_start and body.service_period_end:
        stream = db.query(RevenueStream).filter(RevenueStream.id == body.revenue_stream_id).first()
        if stream:
            _create_schedule_entries(contract, stream, db)

    db.commit()
    db.refresh(contract)
    return _enrich_contract(contract, db)


@router.patch("/contracts/{contract_id}")
def update_contract(
    client_id: int,
    contract_id: int,
    body: RevenueContractUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    contract = db.query(RevenueContract).filter(
        RevenueContract.id == contract_id, RevenueContract.client_id == client_id
    ).first()
    if not contract:
        raise HTTPException(404, "Contract not found")
    for field, val in body.model_dump(exclude_none=True).items():
        if field == "status":
            contract.status = RevenueContractStatus(val)
        else:
            setattr(contract, field, val)
    db.commit()
    return _enrich_contract(contract, db)


@router.delete("/contracts/{contract_id}")
def delete_contract(
    client_id: int,
    contract_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    contract = db.query(RevenueContract).filter(
        RevenueContract.id == contract_id, RevenueContract.client_id == client_id
    ).first()
    if not contract:
        raise HTTPException(404, "Contract not found")
    db.query(RevenueScheduleEntry).filter(RevenueScheduleEntry.contract_id == contract_id).delete()
    db.delete(contract)
    db.commit()
    return {"ok": True}


@router.post("/contracts/{contract_id}/generate-jes")
def generate_recognition_jes(
    client_id: int,
    contract_id: int,
    period: Optional[str] = None,  # "YYYY-MM" — if None, generate all pending
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Generate journal entries for pending recognition schedule entries.
    Creates JEs in the review queue (status=pending on the synthetic transaction).
    """
    client = _get_client(client_id, current_user, db)
    contract = db.query(RevenueContract).filter(
        RevenueContract.id == contract_id, RevenueContract.client_id == client_id
    ).first()
    if not contract:
        raise HTTPException(404, "Contract not found")
    stream = None
    if contract.revenue_stream_id:
        stream = db.query(RevenueStream).filter(RevenueStream.id == contract.revenue_stream_id).first()
    if not stream:
        raise HTTPException(400, "Contract has no revenue stream configured")

    entries_q = db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.contract_id == contract_id,
        RevenueScheduleEntry.je_id == None,
    )
    if period:
        entries_q = entries_q.filter(RevenueScheduleEntry.period == period)
    entries = entries_q.all()

    created = []
    for entry in entries:
        try:
            sp_dt = datetime.strptime(entry.period, "%Y-%m")
        except ValueError:
            continue

        billing_type = BillingType(stream.billing_type) if isinstance(stream.billing_type, str) else stream.billing_type

        if billing_type in (BillingType.monthly_arrears, BillingType.invoice_completion):
            # AR-based: DR AR / CR Revenue (recognition entry)
            je_date = _last_day(sp_dt.year, sp_dt.month)
            debit_acct = stream.ar_account
            credit_acct = stream.revenue_account
            memo = f"Revenue Recognition - {contract.customer_name} - {sp_dt.strftime('%b %Y')}"
        else:
            # Deferred-based: DR Deferred Revenue / CR Revenue
            je_date = _last_day(sp_dt.year, sp_dt.month)
            debit_acct = stream.deferred_revenue_account
            credit_acct = stream.revenue_account
            memo = f"Revenue Recognition - {contract.customer_name} - {sp_dt.strftime('%b %Y')}"

        # Create synthetic transaction
        tx = Transaction(
            client_id=client_id,
            date=je_date,
            description=memo,
            amount=entry.amount,
            status=TransactionStatus.pending,
            source="revenue",
        )
        db.add(tx)
        db.flush()

        je = JournalEntry(
            transaction_id=tx.id,
            je_number=next_je_number(db),
            debit_account=debit_acct,
            credit_account=credit_acct,
            amount=entry.amount,
            je_date=je_date,
            memo=memo[:80],
            ai_confidence=1.0,
            ai_reasoning=f"ASC 606 recognition for {contract.customer_name}, {stream.name}, {entry.period}.",
        )
        db.add(je)
        db.flush()

        entry.je_id = je.id
        created.append(entry.period)

    db.commit()
    return {"created": created, "contract_id": contract_id}


class BulkMatchBody(BaseModel):
    stream_id: int


@router.post("/contracts/bulk-match")
def bulk_match_contracts(
    client_id: int,
    body: BulkMatchBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign all unmatched contracts to a stream and infer service periods."""
    _get_client(client_id, current_user, db)
    stream = db.query(RevenueStream).filter(
        RevenueStream.id == body.stream_id,
        RevenueStream.client_id == client_id,
    ).first()
    if not stream:
        raise HTTPException(404, "Revenue stream not found")

    billing_type = BillingType(stream.billing_type) if isinstance(stream.billing_type, str) else stream.billing_type

    contracts = db.query(RevenueContract).filter(
        RevenueContract.client_id == client_id,
        RevenueContract.revenue_stream_id == None,
        RevenueContract.status == RevenueContractStatus.active,
        RevenueContract.total_contract_value > 0,
    ).all()

    updated = 0
    for contract in contracts:
        contract.revenue_stream_id = stream.id

        # Infer service period from billing date for simple billing types
        if not contract.service_period_start and contract.billing_date:
            bd = contract.billing_date
            if billing_type in (BillingType.invoice_completion, BillingType.monthly_arrears):
                contract.service_period_start = bd.replace(day=1)
                contract.service_period_end = _last_day(bd.year, bd.month)

        if contract.service_period_start and contract.service_period_end:
            _create_schedule_entries(contract, stream, db)

        updated += 1

    db.commit()
    return {"updated": updated}


@router.post("/generate-all-jes")
def generate_all_jes(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate JEs for all matched contracts with pending schedule entries."""
    _get_client(client_id, current_user, db)

    contracts = db.query(RevenueContract).filter(
        RevenueContract.client_id == client_id,
        RevenueContract.status == RevenueContractStatus.active,
        RevenueContract.revenue_stream_id.isnot(None),
    ).all()

    total_created = 0
    errors = []

    for contract in contracts:
        stream = db.query(RevenueStream).filter(
            RevenueStream.id == contract.revenue_stream_id
        ).first()
        if not stream:
            continue

        entries = db.query(RevenueScheduleEntry).filter(
            RevenueScheduleEntry.contract_id == contract.id,
            RevenueScheduleEntry.je_id == None,
        ).all()
        if not entries:
            continue

        billing_type = BillingType(stream.billing_type) if isinstance(stream.billing_type, str) else stream.billing_type

        for entry in entries:
            try:
                sp_dt = datetime.strptime(entry.period, "%Y-%m")
            except ValueError:
                continue

            je_date = _last_day(sp_dt.year, sp_dt.month)
            if billing_type in (BillingType.monthly_arrears, BillingType.invoice_completion):
                debit_acct = stream.ar_account
                credit_acct = stream.revenue_account
            else:
                debit_acct = stream.deferred_revenue_account
                credit_acct = stream.revenue_account

            memo = f"Revenue Recognition - {contract.customer_name} - {sp_dt.strftime('%b %Y')}"

            tx = Transaction(
                client_id=client_id,
                date=je_date,
                description=memo,
                amount=entry.amount,
                status=TransactionStatus.pending,
                source="revenue",
            )
            db.add(tx)
            db.flush()

            je = JournalEntry(
                transaction_id=tx.id,
                je_number=next_je_number(db),
                debit_account=debit_acct,
                credit_account=credit_acct,
                amount=entry.amount,
                je_date=je_date,
                memo=memo[:80],
                ai_confidence=1.0,
                ai_reasoning=f"ASC 606 recognition for {contract.customer_name}, {stream.name}, {entry.period}.",
            )
            db.add(je)
            db.flush()

            entry.je_id = je.id
            total_created += 1

    db.commit()
    return {"created": total_created, "errors": errors}


# ── AR Aging ──────────────────────────────────────────────────────────────────

@router.get("/ar-aging")
def get_ar_aging(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    now = datetime.utcnow()

    contracts = db.query(RevenueContract).filter(
        RevenueContract.client_id == client_id,
        RevenueContract.payment_received == False,
        RevenueContract.status == RevenueContractStatus.active,
    ).order_by(RevenueContract.due_date.asc().nullslast()).all()

    result = []
    for c in contracts:
        days_out = (now - c.billing_date).days if c.billing_date else 0
        if c.due_date:
            days_past_due = (now - c.due_date).days
        else:
            days_past_due = days_out

        if days_past_due <= 0:
            aging_bucket = "current"
        elif days_past_due <= 30:
            aging_bucket = "1-30"
        elif days_past_due <= 60:
            aging_bucket = "31-60"
        elif days_past_due <= 90:
            aging_bucket = "61-90"
        else:
            aging_bucket = "over-90"

        result.append({
            "id": c.id,
            "customer_name": c.customer_name,
            "invoice_number": c.invoice_number,
            "billing_date": c.billing_date.isoformat() if c.billing_date else None,
            "due_date": c.due_date.isoformat() if c.due_date else None,
            "amount": c.total_contract_value,
            "days_outstanding": days_out,
            "days_past_due": max(0, days_past_due),
            "aging_bucket": aging_bucket,
            "source": c.source,
        })

    return result


# ── Integration Settings ──────────────────────────────────────────────────────

@router.get("/integration-settings")
def get_integration_settings(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    settings = _get_or_create_integration_settings(client_id, db)
    db.commit()
    return {
        "client_id": settings.client_id,
        "mercury_revenue_enabled": settings.mercury_revenue_enabled,
        "stripe_enabled": settings.stripe_enabled,
        "stripe_api_key": "***" if settings.stripe_api_key else None,
        "billcom_enabled": settings.billcom_enabled,
        "billcom_username": settings.billcom_username,
        "billcom_org_id": settings.billcom_org_id,
        "billcom_dev_key": "***" if settings.billcom_dev_key else None,
        "last_stripe_sync": settings.last_stripe_sync.isoformat() if settings.last_stripe_sync else None,
        "last_billcom_sync": settings.last_billcom_sync.isoformat() if settings.last_billcom_sync else None,
    }


@router.put("/integration-settings")
def update_integration_settings(
    client_id: int,
    body: RevenueIntegrationSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    settings = _get_or_create_integration_settings(client_id, db)
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(settings, field, val)
    db.commit()
    return {"ok": True}


# ── Sync ──────────────────────────────────────────────────────────────────────

@router.post("/sync")
def sync_revenue_sources(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Pull data from all enabled revenue sources (Mercury, Stripe, Bill.com),
    create RevenueContract records for new invoices, and run AI analysis to
    match them to revenue streams and set service periods.
    """
    client = _get_client(client_id, current_user, db)
    settings = _get_or_create_integration_settings(client_id, db)
    db.commit()

    streams = db.query(RevenueStream).filter(
        RevenueStream.client_id == client_id, RevenueStream.active == True
    ).all()
    streams_dicts = [
        {"id": s.id, "name": s.name, "billing_type": s.billing_type.value if hasattr(s.billing_type, "value") else s.billing_type,
         "revenue_account": s.revenue_account, "deferred_revenue_account": s.deferred_revenue_account}
        for s in streams
    ]

    imported = []
    errors = []

    # ── Mercury ───────────────────────────────────────────────────────────────
    if settings.mercury_revenue_enabled:
        try:
            imported += _sync_mercury_revenue(client_id, client, streams_dicts, db)
        except Exception as exc:
            errors.append(f"Mercury: {exc}")

    # ── Stripe ────────────────────────────────────────────────────────────────
    if settings.stripe_enabled and settings.stripe_api_key:
        try:
            imported += _sync_stripe(client_id, settings.stripe_api_key, client, streams_dicts, db)
            settings.last_stripe_sync = datetime.utcnow()
        except Exception as exc:
            errors.append(f"Stripe: {exc}")

    # ── Bill.com ──────────────────────────────────────────────────────────────
    if settings.billcom_enabled and settings.billcom_username and settings.billcom_password:
        try:
            imported += _sync_billcom(
                client_id, settings.billcom_username, settings.billcom_password,
                settings.billcom_org_id or "", settings.billcom_dev_key or "",
                client, streams_dicts, db,
            )
            settings.last_billcom_sync = datetime.utcnow()
        except Exception as exc:
            errors.append(f"Bill.com: {exc}")

    db.commit()
    return {"imported": len(imported), "contracts": imported, "errors": errors}


# ── Private sync helpers ──────────────────────────────────────────────────────

def _upsert_contract(
    client_id: int, raw_contract: dict, client, streams_dicts: list, db: Session
) -> Optional[dict]:
    """Create or update a RevenueContract from raw import data. Returns the external_id if new."""
    external_id = raw_contract.get("external_id")
    if external_id:
        existing = db.query(RevenueContract).filter(
            RevenueContract.client_id == client_id,
            RevenueContract.external_id == external_id,
        ).first()
        if existing:
            # Update payment status
            if raw_contract.get("payment_received") and not existing.payment_received:
                existing.payment_received = True
                existing.payment_date = raw_contract.get("payment_date")
            return None  # already exists

    # AI analysis
    import ai_coder
    analysis = ai_coder.analyze_revenue_contract(raw_contract, streams_dicts, client)

    service_start = None
    service_end = None
    if analysis.get("service_period_start"):
        try:
            service_start = datetime.strptime(analysis["service_period_start"][:10], "%Y-%m-%d")
        except Exception:
            pass
    if analysis.get("service_period_end"):
        try:
            service_end = datetime.strptime(analysis["service_period_end"][:10], "%Y-%m-%d")
        except Exception:
            pass

    # Fallback: infer from billing_date if AI didn't set it
    if not service_start and raw_contract.get("period_start"):
        service_start = raw_contract["period_start"]
    if not service_end and raw_contract.get("period_end"):
        service_end = raw_contract["period_end"]

    contract = RevenueContract(
        client_id=client_id,
        revenue_stream_id=analysis.get("revenue_stream_id"),
        customer_name=raw_contract.get("customer_name", "Unknown"),
        external_id=external_id,
        source=raw_contract.get("source", "manual"),
        invoice_number=raw_contract.get("invoice_number"),
        total_contract_value=raw_contract.get("total_contract_value", 0.0),
        billing_date=raw_contract.get("billing_date"),
        due_date=raw_contract.get("due_date"),
        service_period_start=service_start,
        service_period_end=service_end,
        payment_received=raw_contract.get("payment_received", False),
        payment_date=raw_contract.get("payment_date"),
        ai_confidence=analysis.get("confidence"),
        ai_reasoning=analysis.get("reasoning"),
        raw_data=json.dumps(raw_contract.get("raw") or {}, default=str)[:4000],
        status=RevenueContractStatus.active,
    )
    db.add(contract)
    db.flush()

    # Generate schedule entries if we have all needed data
    if contract.revenue_stream_id and service_start and service_end:
        stream = next((s for s in db.query(RevenueStream).filter(RevenueStream.id == contract.revenue_stream_id).all()), None)
        if stream:
            _create_schedule_entries(contract, stream, db)

    return external_id


def _create_schedule_entries(contract: RevenueContract, stream: RevenueStream, db: Session):
    """Generate RevenueScheduleEntry rows for a contract."""
    # Remove any existing entries
    db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.contract_id == contract.id
    ).delete()

    periods = _build_schedule(contract, stream)
    for p in periods:
        entry = RevenueScheduleEntry(
            contract_id=contract.id,
            client_id=contract.client_id,
            period=p["period"],
            amount=p["amount"],
            recognized=False,
        )
        db.add(entry)


def _sync_mercury_revenue(client_id: int, client, streams_dicts: list, db: Session) -> list:
    """Pull Mercury transactions that look like revenue (incoming payments)."""
    # Incoming positive transactions sourced from Mercury that aren't internal transfers
    cutoff = datetime.utcnow() - timedelta(days=365)
    txns = db.query(Transaction).filter(
        Transaction.client_id == client_id,
        Transaction.amount > 0,
        Transaction.source == "mercury",
        Transaction.date >= cutoff,
        Transaction.status != TransactionStatus.transfer,
    ).all()

    imported = []
    for tx in txns:
        # Skip if already linked to a contract
        existing = db.query(RevenueContract).filter(
            RevenueContract.client_id == client_id,
            RevenueContract.external_id == tx.mercury_transaction_id,
        ).first()
        if existing:
            continue

        raw = {
            "external_id": tx.mercury_transaction_id or f"mercury-{tx.id}",
            "source": "mercury",
            "customer_name": tx.counterparty_name or tx.description or "Unknown",
            "invoice_number": tx.invoice_number,
            "total_contract_value": tx.amount,
            "billing_date": tx.date,
            "payment_received": True,
            "payment_date": tx.date,
            "description": tx.description or "",
            "raw": {"invoice_text": (tx.invoice_text or "")[:200]},
        }
        ext_id = _upsert_contract(client_id, raw, client, streams_dicts, db)
        if ext_id:
            imported.append(ext_id)
    return imported


def _sync_stripe(client_id: int, api_key: str, client, streams_dicts: list, db: Session) -> list:
    import stripe_client
    invoices = stripe_client.get_invoices(api_key)
    imported = []
    for inv in invoices:
        ext_id = _upsert_contract(client_id, inv, client, streams_dicts, db)
        if ext_id:
            imported.append(ext_id)
    return imported


def _sync_billcom(client_id: int, username: str, password: str, org_id: str, dev_key: str,
                  client, streams_dicts: list, db: Session) -> list:
    import billcom_client
    invoices = billcom_client.get_billcom_invoices(username, password, org_id, dev_key)
    imported = []
    for inv in invoices:
        ext_id = _upsert_contract(client_id, inv, client, streams_dicts, db)
        if ext_id:
            imported.append(ext_id)
    return imported
