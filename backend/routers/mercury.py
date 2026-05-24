"""Mercury sync endpoint."""
import json as _json
import os
import re
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_

from auth import get_current_user
from database import get_db
import models
import mercury as mercury_client
import ai_coder
import rules_engine


_VENDOR_TOKEN_RE = re.compile(r"[^a-z0-9]+")
_VENDOR_SUFFIX_RE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|llp|lp|the)\b")


def _norm_vendor(name: str) -> str:
    """Normalize a vendor name for fuzzy matching: lowercase, strip suffixes, collapse punctuation."""
    if not name:
        return ""
    s = name.lower().strip()
    s = _VENDOR_SUFFIX_RE.sub(" ", s)
    s = _VENDOR_TOKEN_RE.sub(" ", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s


def _vendor_match(a: str, b: str) -> bool:
    """True if vendor names match: one is a substring of the other after normalization, with min 3 chars."""
    na, nb = _norm_vendor(a), _norm_vendor(b)
    if not na or not nb or len(na) < 3 or len(nb) < 3:
        return False
    return na in nb or nb in na


def _find_matching_invoice(payment_tx: models.Transaction, db: Session) -> Optional[tuple[models.Transaction, float]]:
    """
    Look for an unpaid invoice that matches an incoming Mercury payment.

    Match criteria:
      - same client
      - source='invoice' OR mercury_status='invoice'
      - bill_status is 'unpaid', 'partial', or NULL (treated as unpaid for legacy rows)
      - vendor fuzzy match (substring after normalization)
      - amount within ±2%
      - invoice date <= payment date

    Returns (invoice_tx, confidence 0..1) or None.
    """
    if payment_tx.amount >= 0:
        return None  # only outgoing payments
    pay_amt = abs(payment_tx.amount)
    pay_vendor = payment_tx.counterparty_name or payment_tx.description or ""
    pay_date = payment_tx.date

    candidates = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == payment_tx.client_id,
            models.Transaction.id != payment_tx.id,
            or_(
                models.Transaction.source == "invoice",
                models.Transaction.mercury_status == "invoice",
            ),
            or_(
                models.Transaction.bill_status == None,
                models.Transaction.bill_status.in_(["unpaid", "partial"]),
            ),
            models.Transaction.matched_payment_id == None,
        )
        .all()
    )

    best: Optional[tuple[models.Transaction, float]] = None
    for inv in candidates:
        if pay_date and inv.date and inv.date > pay_date:
            continue
        if not _vendor_match(pay_vendor, inv.counterparty_name or inv.description or ""):
            continue
        inv_amt = abs(float(inv.amount or 0))
        if inv_amt == 0:
            continue
        diff = abs(inv_amt - pay_amt) / inv_amt
        if diff > 0.02:
            continue
        # Confidence: 1.0 at exact match, scaled down toward 0.7 at the 2% edge
        conf = 1.0 - (diff / 0.02) * 0.3
        if best is None or conf > best[1]:
            best = (inv, conf)
    return best


def _apply_invoice_match(
    payment_tx: models.Transaction,
    invoice: models.Transaction,
    confidence: float,
    db: Session,
    je_num: int,
) -> int:
    """
    Pre-code a Mercury payment as clearing a matched invoice (DR accrued liability / CR bank).
    Updates invoice.bill_status='paid' and links matched_payment_id.

    Returns the next je_number to use after this allocation (caller increments).
    """
    inv_je = invoice.journal_entries[0] if invoice.journal_entries else None
    accrued_account = (inv_je.credit_account if inv_je else None) or "Accrued Expenses"
    bank_account = payment_tx.mercury_account_name or "Mercury Checking"
    amount = abs(payment_tx.amount)

    je = models.JournalEntry(
        je_number=je_num,
        transaction_id=payment_tx.id,
        debit_account=accrued_account,
        credit_account=bank_account,
        amount=amount,
        je_date=payment_tx.date,
        memo=f"Payment for {invoice.counterparty_name or invoice.description}"[:80],
        ai_confidence=round(confidence, 3),
        ai_reasoning=(
            f"AI matched to invoice #{invoice.id} ({invoice.counterparty_name or 'vendor'}, "
            f"{(invoice.date.date().isoformat() if invoice.date else '?')}, "
            f"${abs(invoice.amount):.2f}). Coded DR {accrued_account} / CR {bank_account} "
            f"to avoid double-booking expense."
        ),
        matched_invoice_id=invoice.id,
        is_ai_matched=True,
        match_confidence=round(confidence, 3),
    )
    db.add(je)
    invoice.bill_status = "paid"
    invoice.matched_payment_id = payment_tx.id

    # If the invoice has a linked AccruedExpense, mark it cleared too.
    ae = (
        db.query(models.AccruedExpense)
        .filter(models.AccruedExpense.source_transaction_id == invoice.id)
        .first()
    )
    if ae:
        ae.status = models.AccruedExpenseStatus.cleared
        ae.payment_je_id = je.id
    return je_num + 1

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

    # ── Coding: AI invoice match → rules → AI coding ──
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

        # ── Pre-pass: AI payment matching to existing invoices ──
        # For each new outgoing Mercury payment, look for an unmatched invoice
        # (same vendor + amount within 2%). If matched, pre-code as
        # DR accrued / CR bank to prevent double-booking the expense.
        for txn in new_txn_objects:
            if (txn.kind or "") != "outgoingPayment":
                continue
            if (txn.amount or 0) >= 0:
                continue
            match = _find_matching_invoice(txn, db)
            if match is None:
                continue
            invoice, conf = match
            _je_num = _apply_invoice_match(txn, invoice, conf, db, _je_num)
            rule_coded_ids.add(txn.id)
            je_created += 1
        db.flush()

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
    """Run AI coding + rules on pending transactions that have no journal entries
    or whose existing journal entries still have placeholder 'Uncoded' accounts."""
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    # ── Rematch pass: re-check ALREADY-CODED pending payments against invoices.
    # This catches the case where a payment was imported and AI-coded before its
    # invoice was uploaded — without this, the payment never gets matched. Only
    # touches outgoing payments that are still pending (not approved/exported)
    # and not already AI-matched or hand-corrected via a rule.
    rematched = 0
    _rematch_je_num = models.next_je_number(db)
    rematch_candidates = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status == models.TransactionStatus.pending,
            models.Transaction.kind == "outgoingPayment",
            models.Transaction.amount < 0,
        )
        .all()
    )
    for txn in rematch_candidates:
        existing_jes = (
            db.query(models.JournalEntry)
            .filter(models.JournalEntry.transaction_id == txn.id)
            .all()
        )
        if not existing_jes:
            continue   # uncoded — main loop below will handle
        # Skip if already matched or hand-corrected via a rule
        if any(je.matched_invoice_id for je in existing_jes):
            continue
        if any(je.rule_applied for je in existing_jes):
            continue
        match = _find_matching_invoice(txn, db)
        if match is None:
            continue
        invoice, conf = match
        # Replace existing JEs with the matched coding
        for je in existing_jes:
            db.delete(je)
        db.flush()
        _rematch_je_num = _apply_invoice_match(txn, invoice, conf, db, _rematch_je_num)
        rematched += 1
    if rematched:
        db.flush()

    # A transaction counts as "really coded" only if it has at least one JE whose
    # debit AND credit are real accounts (neither equals "Uncoded" nor begins with
    # "Uncoded [", which is the AI's "couldn't validate against COA" marker).
    really_coded_ids = {
        row[0]
        for row in db.query(models.JournalEntry.transaction_id)
        .join(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.JournalEntry.debit_account != "Uncoded",
            models.JournalEntry.credit_account != "Uncoded",
            ~models.JournalEntry.debit_account.like("Uncoded [%"),
            ~models.JournalEntry.credit_account.like("Uncoded [%"),
        )
        .all()
    }
    pending = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status == models.TransactionStatus.pending,
            ~models.Transaction.id.in_(really_coded_ids) if really_coded_ids else True,
        )
        .all()
    )

    if not pending:
        if rematched:
            db.commit()
            return {
                "je_created": 0,
                "rematched": rematched,
                "message": f"Rematched {rematched} existing payment{'s' if rematched != 1 else ''} to invoices. No other uncoded transactions.",
            }
        return {"je_created": 0, "message": "No uncoded pending transactions found."}

    # Drop any stale placeholder JEs on these transactions so we don't end up
    # with both the old "Uncoded" rows and the freshly-coded ones.
    pending_ids = [t.id for t in pending]
    db.query(models.JournalEntry).filter(
        models.JournalEntry.transaction_id.in_(pending_ids)
    ).delete(synchronize_session=False)
    db.flush()

    active_rules = (
        db.query(models.Rule)
        .filter(models.Rule.client_id == client_id, models.Rule.active == True)
        .all()
    )

    je_created = 0
    rule_coded_ids: set[int] = set()
    _je_num = models.next_je_number(db)

    # ── Pre-pass: AI payment matching to existing invoices (same as live sync) ──
    for txn in pending:
        if (txn.kind or "") != "outgoingPayment" or (txn.amount or 0) >= 0:
            continue
        match = _find_matching_invoice(txn, db)
        if match is None:
            continue
        invoice, conf = match
        _je_num = _apply_invoice_match(txn, invoice, conf, db, _je_num)
        rule_coded_ids.add(txn.id)
        je_created += 1
    db.flush()

    for txn in pending:
        if txn.id in rule_coded_ids:
            continue
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
    if rematched:
        msg += f" Rematched {rematched} existing payment{'s' if rematched != 1 else ''} to invoices."
    if merged:
        msg += f" Merged {merged} internal transfer duplicate(s)."
    return {"je_created": je_created, "rematched": rematched, "merged_transfers": merged, "message": msg}


@router.get("/payments")
def get_payments(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Return Mercury transactions that are part of the accrual workflow:
    - Outgoing payments (kind=outgoingPayment) — formal vendor bill payments
    - Pending/scheduled invoices (mercury_status in pending/scheduled)
    - Transactions whose JEs debit 'Accrued Expenses' — payments clearing accruals
    """
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == current_user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found.")

    from sqlalchemy import or_, exists
    from models import JournalEntry

    clears_accrual = exists().where(
        JournalEntry.transaction_id == models.Transaction.id,
        JournalEntry.debit_account.ilike("Accrued Expenses%"),
    )

    # Exclude credit card transactions — they belong in the Review Queue, not the
    # Payments tab. CC charges show up with kind='creditCardTransaction' or with
    # a payment_method like 'Credit Card'.
    payments = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status != models.TransactionStatus.transfer,
            models.Transaction.source == "mercury",
            models.Transaction.kind != "creditCardTransaction",
            or_(
                models.Transaction.payment_method == None,
                ~models.Transaction.payment_method.ilike("%credit card%"),
            ),
            or_(
                models.Transaction.kind == "outgoingPayment",
                models.Transaction.mercury_status.in_(["pending", "scheduled"]),
                clears_accrual,
            ),
        )
        .order_by(models.Transaction.date.desc())
        .all()
    )

    # Build a map of matched_invoice_id → summary for any JE on these payments
    payment_ids = [p.id for p in payments]
    matched_invoice_ids: set[int] = set()
    payment_je_match_map: dict[int, int] = {}   # payment_tx_id → matched_invoice_id
    if payment_ids:
        for je in (
            db.query(JournalEntry)
            .filter(
                JournalEntry.transaction_id.in_(payment_ids),
                JournalEntry.matched_invoice_id.isnot(None),
            )
            .all()
        ):
            payment_je_match_map[je.transaction_id] = je.matched_invoice_id
            matched_invoice_ids.add(je.matched_invoice_id)

    invoice_summary_map: dict[int, dict] = {}
    if matched_invoice_ids:
        for inv in (
            db.query(models.Transaction)
            .filter(models.Transaction.id.in_(matched_invoice_ids))
            .all()
        ):
            invoice_summary_map[inv.id] = {
                "id": inv.id,
                "vendor": inv.counterparty_name or "",
                "invoice_number": inv.invoice_number,
                "date": inv.date.isoformat() if inv.date else None,
                "amount": abs(float(inv.amount or 0)),
            }

    result = []
    for txn in payments:
        je_count = len(txn.journal_entries)
        matched_inv_id = payment_je_match_map.get(txn.id)
        matched_invoice = invoice_summary_map.get(matched_inv_id) if matched_inv_id else None
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
            "matched_invoice": matched_invoice,
        })

    return result


@router.post("/refresh-invoices")
def refresh_invoices_from_mercury(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Re-fetch invoice attachments from Mercury for every outgoing payment that
    doesn't have invoice_text yet. Catches the case where the PDF was attached
    in Mercury after our initial sync ran (or where the initial sync silently
    failed to download). Stores extracted text in transactions.invoice_text.
    """
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
        return {"fetched": 0, "scanned": 0, "errors": ["No Mercury API key configured."]}

    candidates = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.kind == "outgoingPayment",
            models.Transaction.mercury_transaction_id.isnot(None),
            or_(
                models.Transaction.invoice_text == None,
                models.Transaction.invoice_text == "",
            ),
        )
        .all()
    )

    fetched = 0
    errors: list[str] = []
    for txn in candidates:
        try:
            detail = mercury_client.get_transaction_detail(txn.mercury_transaction_id, api_key)
            if not detail:
                continue
            for att in (detail.get("attachments") or []):
                url = att.get("url", "")
                fname = (att.get("fileName") or "").lower()
                if not url:
                    continue
                if fname.endswith(".pdf"):
                    pdf_bytes = mercury_client.download_attachment_bytes(url)
                    text = mercury_client.extract_pdf_text(pdf_bytes)
                    if text.strip():
                        txn.invoice_text = text[:10000]
                        fetched += 1
                        break
                elif fname.endswith((".png", ".jpg", ".jpeg", ".webp")):
                    # For images, just note that we have an attachment — full OCR
                    # would require Claude vision. Save a marker so the row no
                    # longer says "No invoice attached" and the user knows to
                    # check the Mercury attachment manually.
                    txn.invoice_text = f"[Image attachment in Mercury: {att.get('fileName') or 'invoice'}]"
                    fetched += 1
                    break
        except Exception as exc:
            errors.append(f"{txn.mercury_transaction_id}: {exc}")
            continue
    db.commit()
    return {
        "scanned": len(candidates),
        "fetched": fetched,
        "errors": errors[:10],   # cap to avoid huge payloads
    }


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
