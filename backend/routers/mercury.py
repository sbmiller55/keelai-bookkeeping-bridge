"""Mercury sync endpoint."""
import json as _json
import os
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import mercury as mercury_client
import ai_coder
import rules_engine

router = APIRouter(prefix="/mercury", tags=["mercury"])

DateRangeOption = Literal[
    "since_last_sync",
    "last_30",
    "last_90",
    "last_180",
    "last_365",
    "custom",
]


class SyncRequest(BaseModel):
    client_id: Optional[int] = None
    date_range: DateRangeOption = "since_last_sync"
    custom_start: Optional[str] = None  # YYYY-MM-DD
    custom_end: Optional[str] = None    # YYYY-MM-DD


class AccountSummary(BaseModel):
    name: str
    transactions: int
    scheduled: int


class SyncResult(BaseModel):
    client_id: int
    client_name: str
    imported: int
    skipped: int
    je_created: int
    errors: list[str]
    accounts: list[AccountSummary]
    date_earliest: Optional[str]
    date_latest: Optional[str]
    key_source: str
    range_start: Optional[str]
    range_end: Optional[str]
    last_sync_at: Optional[str]


class SyncResponse(BaseModel):
    results: list[SyncResult]
    total_imported: int
    total_skipped: int
    total_je_created: int


def _resolve_api_key(client: models.Client) -> tuple[str, str]:
    env_key = os.getenv("MERCURY_API_KEY")
    if env_key:
        return env_key, "env"
    if client.mercury_api_key_encrypted:
        return client.mercury_api_key_encrypted, "client"
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"No Mercury API key configured for client '{client.name}'. "
               "Add a key in Settings or set the MERCURY_API_KEY environment variable.",
    )


def _compute_date_range(
    option: DateRangeOption,
    client: models.Client,
    custom_start: Optional[str],
    custom_end: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """Returns (start, end) as ISO date strings, or None for no bound."""
    now = datetime.utcnow()
    today = now.strftime("%Y-%m-%d")

    if option == "since_last_sync":
        if client.last_sync_at:
            start_dt = client.last_sync_at - timedelta(hours=1)
            return start_dt.strftime("%Y-%m-%d"), today
        else:
            start_dt = now - timedelta(days=90)
            return start_dt.strftime("%Y-%m-%d"), today

    days_map = {"last_30": 30, "last_90": 90, "last_180": 180, "last_365": 365}
    if option in days_map:
        start_dt = now - timedelta(days=days_map[option])
        return start_dt.strftime("%Y-%m-%d"), today

    if option == "custom":
        return custom_start, custom_end

    return None, None


def _sync_one_client(
    client: models.Client,
    db: Session,
    date_range: DateRangeOption,
    custom_start: Optional[str],
    custom_end: Optional[str],
) -> SyncResult:
    api_key, key_source = _resolve_api_key(client)
    range_start, range_end = _compute_date_range(date_range, client, custom_start, custom_end)

    try:
        data = mercury_client.sync_for_client(api_key, start=range_start, end=range_end)
    except mercury_client.MercuryError as e:
        return SyncResult(
            client_id=client.id,
            client_name=client.name,
            imported=0,
            skipped=0,
            je_created=0,
            errors=[str(e)],
            accounts=[],
            date_earliest=None,
            date_latest=None,
            key_source=key_source,
            range_start=range_start,
            range_end=range_end,
            last_sync_at=client.last_sync_at.isoformat() if client.last_sync_at else None,
        )

    normalized = data["transactions"]
    errors = data["errors"]
    account_summaries = [
        AccountSummary(
            name=a["name"],
            transactions=a.get("settled", 0),
            scheduled=a.get("scheduled", 0),
        )
        for a in data.get("accounts", [])
    ]

    # Also fetch ALL pending payments (regardless of date range) and merge in
    try:
        pending_raw = mercury_client.get_all_pending_payments(api_key)
        seen_ids = {t["mercury_transaction_id"] for t in normalized if t.get("mercury_transaction_id")}
        for t in pending_raw:
            norm = mercury_client.normalize_transaction(t, account_name="")
            if norm["mercury_transaction_id"] not in seen_ids:
                normalized.append(norm)
                seen_ids.add(norm["mercury_transaction_id"])
    except Exception as e:
        errors.append(f"Pending payments fetch: {e}")

    existing_map: dict[str, models.Transaction] = {
        row.mercury_transaction_id: row
        for row in db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client.id,
            models.Transaction.mercury_transaction_id.isnot(None),
        )
        .all()
    }

    imported = 0
    skipped = 0
    imported_dates: list[datetime] = []
    new_txn_objects: list[models.Transaction] = []

    for txn in normalized:
        mid = txn["mercury_transaction_id"]
        # Skip failed/declined transactions
        raw_json = txn.get("raw_data") or "{}"
        _raw = _json.loads(raw_json)
        if _raw.get("status") == "failed":
            skipped += 1
            # Delete existing failed transaction if it was previously imported
            if mid and mid in existing_map:
                db.delete(existing_map[mid])
                del existing_map[mid]
            continue

        if mid and mid in existing_map:
            # Update mutable fields that may have changed (category, date, raw_data, mercury_status)
            existing = existing_map[mid]
            existing.mercury_category = txn.get("mercury_category")
            existing.date = txn["date"]
            existing.raw_data = txn.get("raw_data")
            existing.mercury_status = txn.get("mercury_status")
            skipped += 1
            continue

        _TRANSFER_KINDS = {"treasuryTransfer", "internalTransfer", "externalTransfer"}
        initial_status = (
            models.TransactionStatus.transfer
            if txn.get("kind") in _TRANSFER_KINDS
            else models.TransactionStatus.pending
        )
        new_txn = models.Transaction(
            client_id=client.id,
            mercury_transaction_id=mid or None,
            date=txn["date"],
            description=txn["description"],
            amount=txn["amount"],
            mercury_category=txn.get("mercury_category"),
            kind=txn.get("kind"),
            counterparty_name=txn.get("counterparty_name"),
            mercury_account_id=txn.get("mercury_account_id"),
            mercury_account_name=txn.get("mercury_account_name"),
            payment_method=txn.get("payment_method"),
            invoice_number=txn.get("invoice_number"),
            raw_data=txn.get("raw_data"),
            mercury_status=txn.get("mercury_status"),
            status=initial_status,
            imported_at=datetime.utcnow(),
        )

        # For new outgoing payments, try to extract invoice PDF text
        if txn.get("kind") == "outgoingPayment":
            try:
                attachments = _raw.get("attachments", [])
                for att in attachments:
                    url = att.get("url", "")
                    fname = (att.get("fileName") or "").lower()
                    if url and fname.endswith(".pdf"):
                        pdf_bytes = mercury_client.download_attachment_bytes(url)
                        text = mercury_client.extract_pdf_text(pdf_bytes)
                        new_txn.invoice_text = text[:10000]
                        break
            except Exception:
                pass

        db.add(new_txn)
        if mid:
            existing_map[mid] = new_txn
        imported += 1
        imported_dates.append(txn["date"])
        new_txn_objects.append(new_txn)

    # Flush to get IDs assigned (needed for FK in JournalEntry)
    client.last_sync_at = datetime.utcnow()
    db.flush()

    # ── Coding: apply rules first, then AI for anything unmatched ──
    je_created = 0
    if new_txn_objects:
        for t in new_txn_objects:
            db.refresh(t)

        active_rules = (
            db.query(models.Rule)
            .filter(models.Rule.client_id == client.id, models.Rule.active == True)
            .all()
        )

        rule_coded_ids: set[int] = set()
        _je_num = models.next_je_number(db)
        for txn in new_txn_objects:
            matched_rule = rules_engine.match_rule(txn, active_rules)
            if matched_rule:
                if (matched_rule.rule_action or "expense") == "reject":
                    txn.status = models.TransactionStatus.rejected
                    rule_coded_ids.add(txn.id)
                    continue
                je_data_list = rules_engine.apply_rule_jes(matched_rule, txn)
                if not je_data_list:
                    continue
                for jd in je_data_list:
                    db.add(models.JournalEntry(
                        je_number=_je_num,
                        transaction_id=txn.id,
                        debit_account=jd["debit_account"],
                        credit_account=jd["credit_account"],
                        amount=abs(jd.get("amount", txn.amount)),
                        je_date=jd.get("je_date"),
                        memo=jd.get("memo"),
                        rule_applied=matched_rule.id,
                        ai_confidence=jd.get("ai_confidence", 1.0),
                        ai_reasoning=jd.get("ai_reasoning"),
                        is_recurring=jd.get("is_recurring", False),
                        recur_frequency=jd.get("recur_frequency"),
                        recur_end_date=jd.get("recur_end_date"),
                    ))
                    je_created += 1
                    _je_num += 1
                rule_coded_ids.add(txn.id)

        # AI codes whatever rules didn't catch
        ai_candidates = [t for t in new_txn_objects if t.id not in rule_coded_ids]
        if ai_candidates:
            # Split: outgoing payments with invoice text get accrual coding; rest get standard coding
            invoice_candidates = [t for t in ai_candidates if t.kind == "outgoingPayment" and t.invoice_text]
            standard_candidates = [t for t in ai_candidates if t not in invoice_candidates]

            if standard_candidates:
                ai_coded = ai_coder.code_transactions(standard_candidates, client)
                for txn_id, je_data_list in ai_coded:
                    for je_data in je_data_list:
                        db.add(models.JournalEntry(
                            je_number=_je_num,
                            transaction_id=txn_id,
                            debit_account=je_data["debit_account"],
                            credit_account=je_data["credit_account"],
                            amount=abs(je_data.get("amount") or next((t.amount for t in standard_candidates if t.id == txn_id), 0)),
                            je_date=je_data.get("je_date"),
                            memo=je_data.get("memo"),
                            ai_confidence=je_data.get("ai_confidence"),
                            ai_reasoning=je_data.get("ai_reasoning"),
                            service_period_start=je_data.get("service_period_start"),
                            service_period_end=je_data.get("service_period_end"),
                            is_recurring=je_data.get("is_recurring", False),
                            recur_frequency=je_data.get("recur_frequency"),
                            recur_end_date=je_data.get("recur_end_date"),
                        ))
                        je_created += 1
                        _je_num += 1

            for txn in invoice_candidates:
                je_list = ai_coder.code_outgoing_payment_with_invoice(txn, txn.invoice_text, client)
                for je_data in je_list:
                    db.add(models.JournalEntry(
                        je_number=_je_num,
                        transaction_id=txn.id,
                        debit_account=je_data["debit_account"],
                        credit_account=je_data["credit_account"],
                        amount=abs(je_data.get("amount", txn.amount)),
                        je_date=je_data.get("je_date"),
                        memo=je_data.get("memo"),
                        ai_confidence=je_data.get("ai_confidence"),
                        ai_reasoning=je_data.get("ai_reasoning"),
                        service_period_start=je_data.get("service_period_start"),
                        service_period_end=je_data.get("service_period_end"),
                        is_recurring=je_data.get("is_recurring", False),
                        recur_frequency=je_data.get("recur_frequency"),
                        recur_end_date=je_data.get("recur_end_date"),
                    ))
                    je_created += 1
                    _je_num += 1

    db.commit()

    date_earliest = min(imported_dates).strftime("%Y-%m-%d") if imported_dates else None
    date_latest = max(imported_dates).strftime("%Y-%m-%d") if imported_dates else None

    return SyncResult(
        client_id=client.id,
        client_name=client.name,
        imported=imported,
        skipped=skipped,
        je_created=je_created,
        errors=errors,
        accounts=account_summaries,
        date_earliest=date_earliest,
        date_latest=date_latest,
        key_source=key_source,
        range_start=range_start,
        range_end=range_end,
        last_sync_at=client.last_sync_at.isoformat() if client.last_sync_at else None,
    )


@router.post("/sync", response_model=SyncResponse)
def sync_mercury(
    payload: SyncRequest = SyncRequest(),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if payload.client_id is not None:
        client = (
            db.query(models.Client)
            .filter(
                models.Client.id == payload.client_id,
                models.Client.user_id == current_user.id,
            )
            .first()
        )
        if not client:
            raise HTTPException(status_code=404, detail="Client not found.")
        clients = [client]
    else:
        clients = (
            db.query(models.Client)
            .filter(models.Client.user_id == current_user.id)
            .all()
        )
        if not clients:
            raise HTTPException(status_code=404, detail="No clients found. Add a client first.")

    results = [
        _sync_one_client(c, db, payload.date_range, payload.custom_start, payload.custom_end)
        for c in clients
    ]

    # After syncing all clients, collapse internal transfer duplicates
    for c in clients:
        rules_engine.detect_and_merge_transfers(db, c.id)

    return SyncResponse(
        results=results,
        total_imported=sum(r.imported for r in results),
        total_skipped=sum(r.skipped for r in results),
        total_je_created=sum(r.je_created for r in results),
    )


@router.post("/code", response_model=dict)
def code_pending(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Run AI coding + rules on all pending transactions that have no journal entries."""
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    # Find pending transactions without any JEs
    already_coded_ids = {
        row[0]
        for row in db.query(models.JournalEntry.transaction_id)
        .join(models.Transaction)
        .filter(models.Transaction.client_id == client_id)
        .all()
    }
    pending = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status == models.TransactionStatus.pending,
            ~models.Transaction.id.in_(already_coded_ids) if already_coded_ids else True,
        )
        .all()
    )

    if not pending:
        return {"je_created": 0, "message": "No uncoded pending transactions found."}

    active_rules = (
        db.query(models.Rule)
        .filter(models.Rule.client_id == client_id, models.Rule.active == True)
        .all()
    )

    je_created = 0
    rule_coded_ids: set[int] = set()
    _je_num = models.next_je_number(db)

    for txn in pending:
        matched = rules_engine.match_rule(txn, active_rules)
        if matched:
            if (matched.rule_action or "expense") == "reject":
                # Reject action: exclude from review queue / QBO export, no JE
                txn.status = models.TransactionStatus.rejected
                rule_coded_ids.add(txn.id)
                continue
            je_data_list = rules_engine.apply_rule_jes(matched, txn)
            if not je_data_list:
                # Rule couldn't resolve all placeholders; fall through to AI
                continue
            for jd in je_data_list:
                db.add(models.JournalEntry(
                    je_number=_je_num,
                    transaction_id=txn.id,
                    debit_account=jd["debit_account"],
                    credit_account=jd["credit_account"],
                    amount=abs(jd.get("amount", txn.amount)),
                    je_date=jd.get("je_date"),
                    memo=jd.get("memo"),
                    rule_applied=matched.id,
                    ai_confidence=jd.get("ai_confidence", 1.0),
                    ai_reasoning=jd.get("ai_reasoning"),
                    is_recurring=jd.get("is_recurring", False),
                    recur_frequency=jd.get("recur_frequency"),
                    recur_end_date=jd.get("recur_end_date"),
                ))
                je_created += 1
                _je_num += 1
            rule_coded_ids.add(txn.id)

    ai_candidates = [t for t in pending if t.id not in rule_coded_ids]
    if ai_candidates:
        # Auto-fetch Mercury invoices for software/AI/dev payments > $1k without invoice_text
        _PREPAID_CATEGORIES = {"software", "ai and data tools", "developer tools", "saas", "subscriptions"}
        try:
            api_key_val, _ = _resolve_api_key(client)
        except Exception:
            api_key_val = None

        if api_key_val:
            for txn in ai_candidates:
                if (
                    txn.invoice_text is None
                    and txn.mercury_transaction_id
                    and abs(txn.amount) >= 1000
                    and (
                        txn.kind == "outgoingPayment"
                        or (txn.mercury_category or "").lower() in _PREPAID_CATEGORIES
                    )
                ):
                    try:
                        detail = mercury_client.get_transaction_detail(txn.mercury_transaction_id, api_key_val)
                        if detail:
                            for att in (detail.get("attachments") or []):
                                url = att.get("url", "")
                                fname = (att.get("fileName") or "").lower()
                                if url and (fname.endswith(".pdf") or fname.endswith(".png") or fname.endswith(".jpg")):
                                    pdf_bytes = mercury_client.download_attachment_bytes(url)
                                    text = mercury_client.extract_pdf_text(pdf_bytes) if fname.endswith(".pdf") else ""
                                    if text.strip():
                                        txn.invoice_text = text[:10000]
                                        break
                    except Exception:
                        pass

        invoice_candidates = [t for t in ai_candidates if t.kind == "outgoingPayment" and t.invoice_text]
        standard_candidates = [t for t in ai_candidates if t not in invoice_candidates]

        if standard_candidates:
            ai_coded = ai_coder.code_transactions(standard_candidates, client)
            for txn_id, je_data_list in ai_coded:
                for je_data in je_data_list:
                    db.add(models.JournalEntry(
                        je_number=_je_num,
                        transaction_id=txn_id,
                        debit_account=je_data["debit_account"],
                        credit_account=je_data["credit_account"],
                        amount=abs(je_data.get("amount") or next((t.amount for t in standard_candidates if t.id == txn_id), 0)),
                        je_date=je_data.get("je_date"),
                        memo=je_data.get("memo"),
                        ai_confidence=je_data.get("ai_confidence"),
                        ai_reasoning=je_data.get("ai_reasoning"),
                        service_period_start=je_data.get("service_period_start"),
                        service_period_end=je_data.get("service_period_end"),
                        is_recurring=je_data.get("is_recurring", False),
                        recur_frequency=je_data.get("recur_frequency"),
                        recur_end_date=je_data.get("recur_end_date"),
                    ))
                    je_created += 1
                    _je_num += 1

        for txn in invoice_candidates:
            je_list = ai_coder.code_outgoing_payment_with_invoice(txn, txn.invoice_text, client)
            for je_data in je_list:
                db.add(models.JournalEntry(
                    je_number=_je_num,
                    transaction_id=txn.id,
                    debit_account=je_data["debit_account"],
                    credit_account=je_data["credit_account"],
                    amount=abs(je_data.get("amount", txn.amount)),
                    je_date=je_data.get("je_date"),
                    memo=je_data.get("memo"),
                    ai_confidence=je_data.get("ai_confidence"),
                    ai_reasoning=je_data.get("ai_reasoning"),
                    service_period_start=je_data.get("service_period_start"),
                    service_period_end=je_data.get("service_period_end"),
                    is_recurring=je_data.get("is_recurring", False),
                    recur_frequency=je_data.get("recur_frequency"),
                    recur_end_date=je_data.get("recur_end_date"),
                ))
                je_created += 1
                _je_num += 1

    db.commit()

    # Merge internal transfer duplicates (CC payments, treasury sweeps, etc.)
    merged = rules_engine.detect_and_merge_transfers(db, client_id)

    msg = f"Created {je_created} journal entries."
    if merged:
        msg += f" Merged {merged} internal transfer duplicate(s)."
    return {"je_created": je_created, "merged_transfers": merged, "message": msg}


@router.get("/payments")
def get_payments(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return outgoing payment transactions (those with invoice_text or mercury_status=pending)."""
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    _INTERNAL_KINDS = ("treasuryTransfer", "internalTransfer")
    payments = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status != models.TransactionStatus.transfer,
            models.Transaction.source == "mercury",
            models.Transaction.amount < 0,
            ~models.Transaction.kind.in_(_INTERNAL_KINDS),
        )
        .order_by(models.Transaction.date.desc())
        .all()
    )

    result = []
    for txn in payments:
        je_count = len(txn.journal_entries)
        result.append({
            "id": txn.id,
            "client_id": txn.client_id,
            "mercury_transaction_id": txn.mercury_transaction_id,
            "date": txn.date.isoformat() if txn.date else None,
            "description": txn.description,
            "amount": txn.amount,
            "mercury_category": txn.mercury_category,
            "kind": txn.kind,
            "counterparty_name": txn.counterparty_name,
            "mercury_account_id": txn.mercury_account_id,
            "mercury_account_name": txn.mercury_account_name,
            "payment_method": txn.payment_method,
            "invoice_number": txn.invoice_number,
            "invoice_text": txn.invoice_text,
            "mercury_status": txn.mercury_status,
            "status": txn.status.value if txn.status else "pending",
            "imported_at": txn.imported_at.isoformat() if txn.imported_at else None,
            "je_count": je_count,
        })

    return result


@router.post("/import-rules")
def import_mercury_rules(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Try to pull saved transaction rules from Mercury and import them as local rules."""
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    try:
        api_key, _ = _resolve_api_key(client)
    except HTTPException:
        return {"imported": 0, "message": "No Mercury API key configured."}

    mercury_rules = mercury_client.get_transaction_rules(api_key)
    if not mercury_rules:
        return {"imported": 0, "message": "No rules found in Mercury (API may not expose this endpoint)."}

    # Get existing rules to avoid duplicates
    existing = db.query(models.Rule).filter(models.Rule.client_id == client_id).all()
    existing_keys = {(r.match_type, r.match_value.lower()) for r in existing}

    imported = 0
    for mr in mercury_rules:
        # Mercury rule shape is variable — try common fields
        counterparty = (mr.get("counterpartyName") or mr.get("name") or "").strip()
        debit = mr.get("categoryName") or mr.get("ledgerAccount") or "Uncoded"
        if not counterparty:
            continue
        key = ("counterparty_contains", counterparty.lower())
        if key in existing_keys:
            continue
        db.add(models.Rule(
            client_id=client_id,
            match_type="counterparty_contains",
            match_value=counterparty,
            debit_account=debit,
            credit_account="Accrued Expenses",
            rule_action="expense",
            active=True,
        ))
        existing_keys.add(key)
        imported += 1

    db.commit()
    return {"imported": imported, "message": f"Imported {imported} rules from Mercury."}


@router.post("/merge-transfers")
def merge_transfers(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Detect and collapse internal Mercury transfer duplicates (CC payments,
    treasury sweeps, inter-account moves).  Mercury creates two transactions
    for every internal transfer — one per account.  This marks the receiving/
    positive side as status='transfer' so only the originating JE appears in
    the review queue and export.
    """
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    merged = rules_engine.detect_and_merge_transfers(db, client_id)
    return {"merged": merged, "message": f"Merged {merged} internal transfer duplicate(s)."}


@router.get("/status")
def mercury_status(current_user: models.User = Depends(get_current_user)):
    return {"global_key_configured": bool(os.getenv("MERCURY_API_KEY"))}
