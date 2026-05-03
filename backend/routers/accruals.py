"""
Accrued Expenses Schedule endpoints.

Routes:
  GET    /clients/{id}/accruals                       — list accrued expenses + summary
  POST   /clients/{id}/accruals                       — create manually
  PATCH  /clients/{id}/accruals/{ae_id}               — update status / date / amount
  DELETE /clients/{id}/accruals/{ae_id}               — delete
  POST   /clients/{id}/accruals/analyze               — AI scan pending payments
  GET    /clients/{id}/accruals/standing-rules        — list standing rules
  POST   /clients/{id}/accruals/standing-rules        — create rule
  PATCH  /clients/{id}/accruals/standing-rules/{rid}  — update rule
  DELETE /clients/{id}/accruals/standing-rules/{rid}  — delete rule
  POST   /clients/{id}/accruals/standing-rules/generate — generate this month's JEs
"""

import calendar
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import (
    AccruedExpense,
    AccruedExpenseStatus,
    BillingType,
    Client,
    FixedAsset,
    JournalEntry,
    RevenueContract,
    RevenueScheduleEntry,
    RevenueStream,
    StandingAccrualRule,
    Transaction,
    TransactionStatus,
    User,
    next_je_number,
)
from schemas import (
    AccruedExpenseCreate,
    AccruedExpenseRead,
    AccruedExpenseUpdate,
    AccrualSummary,
    StandingAccrualRuleCreate,
    StandingAccrualRuleRead,
    StandingAccrualRuleUpdate,
)

router = APIRouter(prefix="/clients/{client_id}/accruals", tags=["accruals"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_client(client_id: int, user: User, db: Session) -> Client:
    client = db.query(Client).filter(Client.id == client_id, Client.user_id == user.id).first()
    if not client:
        raise HTTPException(404, "Client not found")
    return client


def _current_month() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def _create_synthetic_transaction(client_id: int, vendor: str, amount: float,
                                   tx_date: datetime, db: Session) -> Transaction:
    """Create a synthetic transaction to anchor an accrual JE."""
    tx = Transaction(
        client_id=client_id,
        date=tx_date,
        description=f"Accrual: {vendor}",
        amount=-abs(amount),
        status=TransactionStatus.approved,
        source="accrual",
    )
    db.add(tx)
    db.flush()
    return tx


def _create_accrual_je(tx_id: int, expense_account: str, accrued_account: str,
                        amount: float, je_date: datetime, vendor: str,
                        service_period: str, confidence: float, reasoning: str,
                        db: Session) -> JournalEntry:
    je = JournalEntry(
        transaction_id=tx_id,
        je_number=next_je_number(db),
        debit_account=expense_account,
        credit_account=accrued_account,
        amount=amount,
        je_date=je_date,
        memo=f"Accrual: {vendor} ({service_period})"[:80],
        ai_confidence=confidence,
        ai_reasoning=reasoning,
    )
    db.add(je)
    db.flush()
    return je


def _create_payment_je(tx_id: int, accrued_account: str, bank_account: str,
                        amount: float, pay_date: datetime, vendor: str,
                        db: Session) -> JournalEntry:
    je = JournalEntry(
        transaction_id=tx_id,
        je_number=next_je_number(db),
        debit_account=accrued_account,
        credit_account=bank_account,
        amount=amount,
        je_date=pay_date,
        memo=f"Payment: {vendor}"[:80],
        ai_confidence=1.0,
        ai_reasoning="Payment JE clearing accrued liability.",
    )
    db.add(je)
    db.flush()
    return je


# ── List & summary ────────────────────────────────────────────────────────────

@router.get("")
def list_accruals(
    client_id: int,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    q = db.query(AccruedExpense).filter(AccruedExpense.client_id == client_id)
    if status:
        q = q.filter(AccruedExpense.status == status)
    accruals = q.order_by(AccruedExpense.service_period.asc(), AccruedExpense.created_at.asc()).all()

    this_month = _current_month()
    total_accrued = sum(
        a.amount for a in accruals if a.status != AccruedExpenseStatus.cleared
    )
    pending_count = sum(1 for a in accruals if a.status == AccruedExpenseStatus.accrued)
    cleared_this_month = [
        a for a in accruals
        if a.status == AccruedExpenseStatus.cleared and a.service_period == this_month
    ]

    summary = AccrualSummary(
        total_accrued=round(total_accrued, 2),
        pending_payment_count=pending_count,
        cleared_this_month=len(cleared_this_month),
        cleared_this_month_amount=round(sum(a.amount for a in cleared_this_month), 2),
    )

    return {
        "summary": summary,
        "accruals": [AccruedExpenseRead.model_validate(a) for a in accruals],
    }


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("")
def create_accrual(
    client_id: int,
    body: AccruedExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)

    # Determine the accrual date (last day of service period month)
    try:
        sp_dt = datetime.strptime(body.service_period, "%Y-%m")
    except ValueError:
        raise HTTPException(400, "service_period must be YYYY-MM")

    import calendar
    last_day = calendar.monthrange(sp_dt.year, sp_dt.month)[1]
    accrual_date = datetime(sp_dt.year, sp_dt.month, last_day)

    # Create synthetic transaction to hold the accrual JE
    tx = _create_synthetic_transaction(client_id, body.vendor_name, body.amount, accrual_date, db)

    # Create the accrual JE: DR expense / CR accrued expenses
    accrual_je = _create_accrual_je(
        tx_id=tx.id,
        expense_account=body.expense_account,
        accrued_account=body.accrued_account,
        amount=body.amount,
        je_date=accrual_date,
        vendor=body.vendor_name,
        service_period=body.service_period,
        confidence=1.0,
        reasoning="Manually created accrual.",
        db=db,
    )

    ae = AccruedExpense(
        client_id=client_id,
        vendor_name=body.vendor_name,
        description=body.description,
        service_period=body.service_period,
        amount=body.amount,
        source_transaction_id=body.source_transaction_id,
        accrual_je_id=accrual_je.id,
        expected_payment_date=body.expected_payment_date,
        status=AccruedExpenseStatus.accrued,
        ai_confidence=1.0,
        ai_reasoning="Manually created.",
    )
    db.add(ae)
    db.commit()
    db.refresh(ae)
    return AccruedExpenseRead.model_validate(ae)


# ── Update ────────────────────────────────────────────────────────────────────

@router.patch("/{ae_id}")
def update_accrual(
    client_id: int,
    ae_id: int,
    body: AccruedExpenseUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    ae = db.query(AccruedExpense).filter(
        AccruedExpense.id == ae_id, AccruedExpense.client_id == client_id
    ).first()
    if not ae:
        raise HTTPException(404, "Accrued expense not found")

    if body.status is not None:
        try:
            ae.status = AccruedExpenseStatus(body.status)
        except ValueError:
            raise HTTPException(400, f"Invalid status: {body.status}")
    if body.expected_payment_date is not None:
        ae.expected_payment_date = body.expected_payment_date
    if body.description is not None:
        ae.description = body.description
    if body.amount is not None:
        ae.amount = body.amount

    db.commit()
    db.refresh(ae)
    return AccruedExpenseRead.model_validate(ae)


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{ae_id}")
def delete_accrual(
    client_id: int,
    ae_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    ae = db.query(AccruedExpense).filter(
        AccruedExpense.id == ae_id, AccruedExpense.client_id == client_id
    ).first()
    if not ae:
        raise HTTPException(404, "Accrued expense not found")
    db.delete(ae)
    db.commit()
    return {"ok": True}


# ── Release prepaid accrual to Review Queue ───────────────────────────────────

@router.post("/{ae_id}/release")
def release_accrual(
    client_id: int,
    ae_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Create a pending transaction + JE for a prepaid amortization accrual,
    making it appear in the Review Queue for the current month.
    """
    _get_client(client_id, current_user, db)
    ae = db.query(AccruedExpense).filter(
        AccruedExpense.id == ae_id, AccruedExpense.client_id == client_id
    ).first()
    if not ae:
        raise HTTPException(404, "Accrued expense not found")
    if ae.accrual_je_id:
        raise HTTPException(400, "Accrual already released to Review Queue")
    if not ae.debit_account or not ae.credit_account:
        raise HTTPException(400, "Accrual missing account info — cannot create JE")

    # Parse the service period date
    try:
        period_dt = datetime.strptime(ae.service_period, "%Y-%m")
    except ValueError:
        period_dt = datetime.utcnow()

    # Last day of the service period month
    import calendar
    last_day = calendar.monthrange(period_dt.year, period_dt.month)[1]
    je_date = period_dt.replace(day=last_day)

    # Create a pending transaction for this month's amortization
    tx = Transaction(
        client_id=client_id,
        date=je_date,
        description=f"{ae.vendor_name} prepaid amortization ({ae.service_period})",
        counterparty_name=ae.vendor_name,
        amount=-abs(ae.amount),
        status=TransactionStatus.pending,
        source="accrual",
    )
    db.add(tx)
    db.flush()

    # Create the JE
    je = JournalEntry(
        transaction_id=tx.id,
        je_number=next_je_number(db),
        debit_account=ae.debit_account,
        credit_account=ae.credit_account,
        amount=ae.amount,
        je_date=je_date,
        memo=f"{ae.vendor_name} amortization ({ae.service_period})"[:80],
        ai_confidence=ae.ai_confidence or 0.9,
        ai_reasoning=ae.ai_reasoning or "",
    )
    db.add(je)
    db.flush()

    ae.accrual_je_id = je.id
    db.commit()

    return {
        "accrual_id": ae.id,
        "transaction_id": tx.id,
        "je_id": je.id,
        "service_period": ae.service_period,
    }


# ── Auto-release (called by scheduler + manual endpoint) ─────────────────────

def _auto_release_for_client(client_id: int, target_month: str, db: Session) -> dict:
    """
    Release all unreleased items for `target_month` (YYYY-MM) into the review queue:
      1. AccruedExpense records (prepaid amortization, manual accruals)
      2. FixedAsset depreciation / amortization
      3. Revenue schedule entries

    Returns a dict with counts of what was created.
    """
    try:
        period_dt = datetime.strptime(target_month, "%Y-%m")
    except ValueError:
        raise ValueError(f"target_month must be YYYY-MM, got: {target_month}")

    last_day_num = calendar.monthrange(period_dt.year, period_dt.month)[1]
    je_date = period_dt.replace(day=last_day_num)

    released_accruals = 0
    released_depreciation = 0
    released_revenue = 0

    # ── 1. Prepaid / manual accruals ──────────────────────────────────────────
    unreleased = db.query(AccruedExpense).filter(
        AccruedExpense.client_id == client_id,
        AccruedExpense.service_period == target_month,
        AccruedExpense.accrual_je_id == None,
        AccruedExpense.debit_account != None,
        AccruedExpense.credit_account != None,
    ).all()

    for ae in unreleased:
        tx = Transaction(
            client_id=client_id,
            date=je_date,
            description=f"{ae.vendor_name} accrual release ({ae.service_period})",
            counterparty_name=ae.vendor_name,
            amount=-abs(ae.amount),
            status=TransactionStatus.pending,
            source="accrual",
        )
        db.add(tx)
        db.flush()

        je = JournalEntry(
            transaction_id=tx.id,
            je_number=next_je_number(db),
            debit_account=ae.debit_account,
            credit_account=ae.credit_account,
            amount=ae.amount,
            je_date=je_date,
            memo=f"{ae.vendor_name} accrual ({ae.service_period})"[:80],
            ai_confidence=ae.ai_confidence or 0.9,
            ai_reasoning=ae.ai_reasoning or "",
        )
        db.add(je)
        db.flush()

        ae.accrual_je_id = je.id
        released_accruals += 1

    # ── 2. Fixed asset depreciation / amortization ───────────────────────────
    from routers.fixed_assets import _compute_schedule, _create_dep_transaction

    assets = db.query(FixedAsset).filter(
        FixedAsset.client_id == client_id,
        FixedAsset.status == "active",
    ).all()

    for asset in assets:
        schedule = _compute_schedule(asset)
        period_entry = next((p for p in schedule if p["period"] == target_month), None)
        if not period_entry:
            continue

        # Skip if depreciation tx already exists for this asset + month
        existing = db.query(Transaction).filter(
            Transaction.fixed_asset_id == asset.id,
            Transaction.source == "depreciation",
        ).all()
        existing_months = {
            f"{t.date.year}-{t.date.month:02d}" for t in existing
        }
        if target_month in existing_months:
            continue

        _create_dep_transaction(asset, period_entry, client_id, db)

        # Mark fully depreciated if this is the last period
        if schedule and schedule[-1]["period"] <= target_month:
            asset.status = "fully_depreciated"

        released_depreciation += 1

    # ── 3. Revenue schedule entries ──────────────────────────────────────────
    pending_entries = db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.client_id == client_id,
        RevenueScheduleEntry.period == target_month,
        RevenueScheduleEntry.je_id == None,
    ).all()

    for entry in pending_entries:
        contract = db.query(RevenueContract).filter(
            RevenueContract.id == entry.contract_id
        ).first()
        if not contract or not contract.revenue_stream_id:
            continue

        stream = db.query(RevenueStream).filter(
            RevenueStream.id == contract.revenue_stream_id
        ).first()
        if not stream:
            continue

        billing_type = (
            BillingType(stream.billing_type)
            if isinstance(stream.billing_type, str)
            else stream.billing_type
        )

        if billing_type in (BillingType.monthly_arrears, BillingType.invoice_completion):
            debit_acct = stream.ar_account
        else:
            debit_acct = stream.deferred_revenue_account
        credit_acct = stream.revenue_account
        memo = f"Revenue Recognition - {contract.customer_name} - {period_dt.strftime('%b %Y')}"

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
            ai_reasoning=f"Auto-released: ASC 606 recognition for {contract.customer_name}, {target_month}.",
        )
        db.add(je)
        db.flush()

        entry.je_id = je.id
        contract.amount_recognized = round(
            (contract.amount_recognized or 0.0) + entry.amount, 2
        )
        released_revenue += 1

    db.commit()
    return {
        "month": target_month,
        "released_accruals": released_accruals,
        "released_depreciation": released_depreciation,
        "released_revenue": released_revenue,
    }


@router.post("/auto-release")
def auto_release(
    client_id: int,
    month: Optional[str] = None,  # "YYYY-MM" — defaults to current month
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Manually trigger auto-release for a given month (defaults to current month).
    Releases prepaid accruals, fixed asset depreciation, and revenue schedule entries
    that haven't been pushed to the review queue yet.
    """
    _get_client(client_id, current_user, db)
    target_month = month or _current_month()
    return _auto_release_for_client(client_id, target_month, db)


# ── AI analyze ────────────────────────────────────────────────────────────────

@router.post("/analyze")
def analyze_payments(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    AI-scan pending and recent Mercury payments and suggest accrual entries.
    Returns suggestions; does NOT create anything automatically.
    """
    client = _get_client(client_id, current_user, db)

    # Pull pending + last 30 days of sent payments that don't already have accruals
    existing_source_ids = {
        ae.source_transaction_id
        for ae in db.query(AccruedExpense).filter(AccruedExpense.client_id == client_id).all()
        if ae.source_transaction_id
    }

    from datetime import timedelta
    cutoff = datetime.utcnow() - timedelta(days=60)
    transactions = (
        db.query(Transaction)
        .filter(
            Transaction.client_id == client_id,
            Transaction.date >= cutoff,
            Transaction.amount < 0,  # outgoing payments only
            ~Transaction.id.in_(existing_source_ids),
        )
        .order_by(Transaction.date.desc())
        .limit(50)
        .all()
    )

    if not transactions:
        return {"suggestions": []}

    import ai_coder
    suggestions = ai_coder.analyze_for_accrual(transactions, client)
    return {"suggestions": [s for s in suggestions if s.get("needs_accrual")]}


@router.post("/from-suggestion")
def create_from_suggestion(
    client_id: int,
    body: AccruedExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Accept an AI suggestion and create the accrual JE + AccruedExpense record."""
    return create_accrual(client_id, body, db, current_user)


# ── Standing rules ────────────────────────────────────────────────────────────

@router.get("/standing-rules")
def list_standing_rules(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    rules = (
        db.query(StandingAccrualRule)
        .filter(StandingAccrualRule.client_id == client_id)
        .order_by(StandingAccrualRule.vendor_name)
        .all()
    )
    return [StandingAccrualRuleRead.model_validate(r) for r in rules]


@router.post("/standing-rules")
def create_standing_rule(
    client_id: int,
    body: StandingAccrualRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    rule = StandingAccrualRule(
        client_id=client_id,
        vendor_name=body.vendor_name,
        description=body.description,
        expense_account=body.expense_account,
        accrued_account=body.accrued_account,
        amount=body.amount,
        active=True,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return StandingAccrualRuleRead.model_validate(rule)


@router.patch("/standing-rules/{rule_id}")
def update_standing_rule(
    client_id: int,
    rule_id: int,
    body: StandingAccrualRuleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    rule = db.query(StandingAccrualRule).filter(
        StandingAccrualRule.id == rule_id, StandingAccrualRule.client_id == client_id
    ).first()
    if not rule:
        raise HTTPException(404, "Standing rule not found")

    for field in ("vendor_name", "description", "expense_account", "accrued_account", "amount", "active"):
        val = getattr(body, field, None)
        if val is not None:
            setattr(rule, field, val)

    db.commit()
    db.refresh(rule)
    return StandingAccrualRuleRead.model_validate(rule)


@router.delete("/standing-rules/{rule_id}")
def delete_standing_rule(
    client_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_client(client_id, current_user, db)
    rule = db.query(StandingAccrualRule).filter(
        StandingAccrualRule.id == rule_id, StandingAccrualRule.client_id == client_id
    ).first()
    if not rule:
        raise HTTPException(404, "Standing rule not found")
    db.delete(rule)
    db.commit()
    return {"ok": True}


@router.post("/standing-rules/generate")
def generate_from_standing_rules(
    client_id: int,
    month: Optional[str] = None,  # "YYYY-MM", defaults to current month
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Generate accrual JEs for all active standing rules that haven't been generated
    for the given month yet.
    """
    _get_client(client_id, current_user, db)
    target_month = month or _current_month()

    try:
        sp_dt = datetime.strptime(target_month, "%Y-%m")
    except ValueError:
        raise HTTPException(400, "month must be YYYY-MM")

    import calendar
    last_day = calendar.monthrange(sp_dt.year, sp_dt.month)[1]
    accrual_date = datetime(sp_dt.year, sp_dt.month, last_day)

    rules = (
        db.query(StandingAccrualRule)
        .filter(
            StandingAccrualRule.client_id == client_id,
            StandingAccrualRule.active == True,
        )
        .all()
    )

    generated = []
    skipped = []

    for rule in rules:
        if rule.last_generated == target_month:
            skipped.append(rule.vendor_name)
            continue
        if rule.amount is None:
            skipped.append(f"{rule.vendor_name} (no fixed amount)")
            continue

        tx = _create_synthetic_transaction(client_id, rule.vendor_name, rule.amount, accrual_date, db)
        accrual_je = _create_accrual_je(
            tx_id=tx.id,
            expense_account=rule.expense_account,
            accrued_account=rule.accrued_account,
            amount=rule.amount,
            je_date=accrual_date,
            vendor=rule.vendor_name,
            service_period=target_month,
            confidence=1.0,
            reasoning=f"Standing accrual rule: {rule.description or rule.vendor_name}",
            db=db,
        )

        ae = AccruedExpense(
            client_id=client_id,
            vendor_name=rule.vendor_name,
            description=rule.description,
            service_period=target_month,
            amount=rule.amount,
            accrual_je_id=accrual_je.id,
            status=AccruedExpenseStatus.accrued,
            ai_confidence=1.0,
            ai_reasoning=f"Generated from standing rule #{rule.id}.",
            standing_rule_id=rule.id,
        )
        db.add(ae)
        rule.last_generated = target_month
        generated.append(rule.vendor_name)

    db.commit()
    return {"generated": generated, "skipped": skipped, "month": target_month}
