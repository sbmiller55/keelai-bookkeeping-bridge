"""Stripe revenue coding pipeline endpoints.

Mirrors the Mercury pipeline (routers/mercury.py): fetch Stripe money movements,
upsert them as source="stripe" Transactions, deterministically code them into
JournalEntries via stripe_revenue_je, and let them flow through the same Review
Queue → QBO export path. Manual trigger only (no scheduler), like Mercury.

Routes:
  POST /stripe/sync      — fetch + upsert + code new Stripe transactions
  POST /stripe/code      — (re)code pending Stripe transactions from config
  GET  /stripe/settings  — read per-client config (key masked)
  PUT  /stripe/settings  — update per-client config
  POST /stripe/test      — verify the API key connects
  GET  /stripe/status    — lightweight health
"""
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import stripe_coding_client
import stripe_revenue_je
from schemas import StripeConfigRead, StripeConfigUpdate

router = APIRouter(prefix="/stripe", tags=["stripe"])

DateRangeOption = Literal[
    "since_last_sync", "last_30", "last_90", "last_180", "last_365", "custom",
]


class StripeSyncRequest(BaseModel):
    client_id: int
    date_range: DateRangeOption = "since_last_sync"
    custom_start: Optional[str] = None  # YYYY-MM-DD
    custom_end: Optional[str] = None


class StripeSyncResult(BaseModel):
    client_id: int
    client_name: str
    imported: int
    skipped: int
    je_created: int
    errors: list[str]
    range_start: Optional[str]
    range_end: Optional[str]
    last_sync: Optional[str]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_client(client_id: int, user: models.User, db: Session) -> models.Client:
    c = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == user.id)
        .first()
    )
    if not c:
        raise HTTPException(404, "Client not found.")
    return c


def _get_or_create_config(client_id: int, db: Session) -> models.StripeConfig:
    cfg = (
        db.query(models.StripeConfig)
        .filter(models.StripeConfig.client_id == client_id)
        .first()
    )
    if not cfg:
        cfg = models.StripeConfig(client_id=client_id)
        db.add(cfg)
        db.flush()
    return cfg


def _resolve_key(cfg: models.StripeConfig, client_id: int, db: Session) -> str:
    if cfg.api_key:
        return cfg.api_key
    rev = (
        db.query(models.RevenueIntegrationSettings)
        .filter(models.RevenueIntegrationSettings.client_id == client_id)
        .first()
    )
    if rev and rev.stripe_api_key:
        return rev.stripe_api_key
    raise HTTPException(
        422,
        "No Stripe API key configured for this client. Add a restricted key in Settings.",
    )


def _compute_range(cfg: models.StripeConfig, opt: DateRangeOption,
                   custom_start: Optional[str], custom_end: Optional[str]):
    """Return (start_dt, end_dt) datetimes, or (None, None) for unbounded."""
    now = datetime.utcnow()
    end = now
    if opt == "since_last_sync":
        if cfg.last_sync:
            return cfg.last_sync - timedelta(hours=1), end
        return now - timedelta(days=90), end
    days = {"last_30": 30, "last_90": 90, "last_180": 180, "last_365": 365}
    if opt in days:
        return now - timedelta(days=days[opt]), end
    if opt == "custom":
        s = datetime.strptime(custom_start, "%Y-%m-%d") if custom_start else None
        e = (datetime.strptime(custom_end, "%Y-%m-%d") + timedelta(days=1)) if custom_end else None
        return s, e
    return None, None


def _config_read(cfg: models.StripeConfig) -> dict:
    return {
        "client_id": cfg.client_id,
        "enabled": cfg.enabled,
        "stripe_api_key": "***" if cfg.api_key else None,
        "treatment": cfg.treatment,
        "granularity": cfg.granularity,
        "recognition_timing": cfg.recognition_timing,
        "attribute_customer": cfg.attribute_customer,
        "revenue_account": cfg.revenue_account,
        "stripe_fees_account": cfg.stripe_fees_account,
        "stripe_clearing_account": cfg.stripe_clearing_account,
        "dispute_fees_account": cfg.dispute_fees_account,
        "bank_account": cfg.bank_account,
        "payout_match_text": cfg.payout_match_text,
        "last_sync": cfg.last_sync.isoformat() if cfg.last_sync else None,
    }


def _add_jes(txn, cfg, db, je_num: int) -> int:
    """Build + persist JEs for one Stripe transaction. Returns next je_number."""
    for jd in stripe_revenue_je.build_jes_for_stripe_txn(txn, cfg):
        db.add(models.JournalEntry(
            je_number=je_num,
            transaction_id=txn.id,
            debit_account=jd["debit_account"],
            credit_account=jd["credit_account"],
            amount=jd["amount"],
            je_date=jd["je_date"],
            memo=jd["memo"],
            description=jd["description"],
            customer_name=jd["customer_name"],
            ai_confidence=jd["ai_confidence"],
            ai_reasoning=jd["ai_reasoning"],
        ))
        je_num += 1
    return je_num


# ── Settings ─────────────────────────────────────────────────────────────────

@router.get("/settings", response_model=StripeConfigRead)
def get_settings(client_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    _get_client(client_id, current_user, db)
    cfg = _get_or_create_config(client_id, db)
    db.commit()
    return _config_read(cfg)


@router.put("/settings")
def update_settings(client_id: int, body: StripeConfigUpdate,
                    db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    _get_client(client_id, current_user, db)
    cfg = _get_or_create_config(client_id, db)
    data = body.model_dump(exclude_unset=True)
    # Map the UI's stripe_api_key → api_key column; ignore blanks so the saved
    # key isn't wiped when the user leaves the masked field untouched.
    if "stripe_api_key" in data:
        key = data.pop("stripe_api_key")
        if key and key != "***":
            cfg.api_key = key
    for field, val in data.items():
        setattr(cfg, field, val)
    db.commit()
    return {"ok": True}


@router.post("/test")
def test_connection(client_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    _get_client(client_id, current_user, db)
    cfg = _get_or_create_config(client_id, db)
    key = _resolve_key(cfg, client_id, db)
    try:
        result = stripe_coding_client.test_connection(key)
        return {"ok": True, **result}
    except Exception as exc:
        raise HTTPException(400, f"Stripe connection failed: {type(exc).__name__}: {exc}")


@router.get("/status")
def status(current_user: models.User = Depends(get_current_user)):
    return {"ok": True}


# ── Sync ─────────────────────────────────────────────────────────────────────

@router.post("/sync", response_model=StripeSyncResult)
def sync_stripe(payload: StripeSyncRequest, db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    client = _get_client(payload.client_id, current_user, db)
    cfg = _get_or_create_config(client.id, db)
    if not cfg.enabled:
        raise HTTPException(422, "Stripe is not enabled for this client.")
    key = _resolve_key(cfg, client.id, db)

    start, end = _compute_range(cfg, payload.date_range, payload.custom_start, payload.custom_end)
    errors: list[str] = []

    # Fetch the money movements. per_payout mode records summaries; otherwise
    # per-charge (+ refunds/disputes as they occur).
    normalized: list[dict] = []
    try:
        if cfg.granularity == "per_payout":
            normalized += stripe_coding_client.get_payout_summaries(key, start, end)
        else:
            normalized += stripe_coding_client.get_charges(key, start, end)
            try:
                normalized += stripe_coding_client.get_refunds(key, start, end)
            except Exception as exc:
                errors.append(f"Refunds: {exc}")
            try:
                normalized += stripe_coding_client.get_disputes(key, start, end)
            except Exception as exc:
                errors.append(f"Disputes: {exc}")
    except Exception as exc:
        raise HTTPException(400, f"Stripe sync failed: {type(exc).__name__}: {exc}")

    existing = {
        row.stripe_charge_id: row
        for row in db.query(models.Transaction).filter(
            models.Transaction.client_id == client.id,
            models.Transaction.source == "stripe",
            models.Transaction.stripe_charge_id.isnot(None),
        ).all()
    }

    imported = 0
    skipped = 0
    new_txns: list[models.Transaction] = []
    for n in normalized:
        sid = n["stripe_charge_id"]
        if sid in existing:
            # Refresh the stored raw/fee data but don't recode.
            existing[sid].raw_data = n["raw_data"]
            skipped += 1
            continue
        txn = models.Transaction(
            client_id=client.id,
            source="stripe",
            stripe_charge_id=sid,
            stripe_object_type=n["stripe_object_type"],
            date=n["date"] or datetime.utcnow(),
            description=n["description"],
            amount=n["amount"],
            counterparty_name=n.get("counterparty_name"),
            raw_data=n["raw_data"],
            status=models.TransactionStatus.pending,
            imported_at=datetime.utcnow(),
        )
        db.add(txn)
        existing[sid] = txn
        new_txns.append(txn)
        imported += 1

    db.flush()

    je_created = 0
    if new_txns:
        for t in new_txns:
            db.refresh(t)
        je_num = models.next_je_number(db)
        for txn in new_txns:
            before = je_num
            je_num = _add_jes(txn, cfg, db, je_num)
            je_created += (je_num - before)

    cfg.last_sync = datetime.utcnow()
    db.commit()

    return StripeSyncResult(
        client_id=client.id,
        client_name=client.name,
        imported=imported,
        skipped=skipped,
        je_created=je_created,
        errors=errors,
        range_start=start.strftime("%Y-%m-%d") if start else None,
        range_end=end.strftime("%Y-%m-%d") if end else None,
        last_sync=cfg.last_sync.isoformat(),
    )


@router.post("/code")
def code_stripe(client_id: int, limit: Optional[int] = None,
                db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    """(Re)code pending Stripe transactions from the current config. Drops and
    rebuilds JEs for pending (not approved/exported) rows, so changing the
    account mappings and re-running fixes existing entries."""
    client = _get_client(client_id, current_user, db)
    cfg = _get_or_create_config(client_id, db)

    q = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.source == "stripe",
            models.Transaction.status == models.TransactionStatus.pending,
        )
        .order_by(models.Transaction.date.asc(), models.Transaction.id.asc())
    )
    pending = q.limit(limit).all() if (limit and limit > 0) else q.all()
    if not pending:
        return {"je_created": 0, "message": "No pending Stripe transactions to code."}

    pending_ids = [t.id for t in pending]
    db.query(models.JournalEntry).filter(
        models.JournalEntry.transaction_id.in_(pending_ids)
    ).delete(synchronize_session=False)
    db.flush()

    je_num = models.next_je_number(db)
    je_created = 0
    for txn in pending:
        before = je_num
        je_num = _add_jes(txn, cfg, db, je_num)
        je_created += (je_num - before)

    db.commit()
    return {"je_created": je_created,
            "message": f"Coded {len(pending)} Stripe transaction(s) into {je_created} journal entries."}
