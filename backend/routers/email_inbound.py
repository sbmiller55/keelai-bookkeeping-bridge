"""
Email inbound webhook — receives forwarded invoices and creates journal entries.

Uses Cloudmailin JSON format (free forever, no domain needed).
1. Sign up at cloudmailin.com
2. You'll get a free address like abc123@cloudmailin.net
3. Set Target URL to: https://your-server/email/inbound?token=$INBOUND_EMAIL_TOKEN
   (substitute the real value; never write the token down in this repo — it is
   the only thing standing between the public internet and a write into the
   books, and this repo is public)
4. Set format to "JSON (Normalized)"
5. Set INBOUND_EMAIL_ADDRESS=abc123@cloudmailin.net in .env

Optionally append &client_id=N to bind the address to one client. Without it the
webhook only accepts mail when exactly one client is Mercury-connected; it will
not guess between several.
"""
import base64
import json
import os
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
import ratelimit
import models
import ai_coder
import mercury as mercury_client

router = APIRouter(prefix="/email", tags=["email"])


def _verify_token(token: Optional[str]) -> None:
    """Reject anything without the shared secret.

    This used to return early when INBOUND_EMAIL_TOKEN was unset, which meant a
    missing env var silently opened an unauthenticated write path into the
    books. It now fails closed: no configured token, no inbound mail.
    """
    expected = os.getenv("INBOUND_EMAIL_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Inbound email is not configured.",
        )
    if not token or not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token")


def _extract_pdf_text(attachments: list) -> Optional[str]:
    for att in attachments:
        fname = (att.get("file_name") or "").lower()
        ct = (att.get("content_type") or "").lower()
        content = att.get("content", "")
        if not content:
            continue
        if fname.endswith(".pdf") or "pdf" in ct:
            try:
                pdf_bytes = base64.b64decode(content)
                return mercury_client.extract_pdf_text(pdf_bytes)
            except Exception:
                continue
    return None


def _pick_client(db: Session, client_id: Optional[int] = None) -> Optional[models.Client]:
    """Resolve which client's books an inbound invoice belongs to.

    An explicit client_id from the webhook URL wins. Otherwise this only
    resolves when exactly one client is Mercury-connected: the old behaviour
    took the *first* such client, so with more than one on the account a
    forwarded invoice landed in whichever row the database returned first,
    with no way for the sender to tell.
    """
    if client_id is not None:
        return db.query(models.Client).filter(models.Client.id == client_id).first()

    candidates = (
        db.query(models.Client)
        .filter(models.Client.mercury_api_key_encrypted.isnot(None))
        .order_by(models.Client.id)
        .limit(2)
        .all()
    )
    if len(candidates) == 1:
        return candidates[0]
    return None                          # none configured, or ambiguous


def _create_transaction_and_jes(
    db: Session, client: models.Client, subject: str, invoice_text: Optional[str]
) -> dict:
    txn = models.Transaction(
        client_id=client.id,
        mercury_transaction_id=None,
        date=datetime.utcnow(),
        description=subject,
        amount=0.0,
        kind="outgoingPayment",
        counterparty_name=None,
        mercury_status="scheduled",
        invoice_text=invoice_text,
        status=models.TransactionStatus.pending,
        imported_at=datetime.utcnow(),
    )
    db.add(txn)
    db.flush()
    db.refresh(txn)

    je_created = 0
    if invoice_text:
        je_list = ai_coder.code_outgoing_payment_with_invoice(txn, invoice_text, client)
        for je_data in je_list:
            amount = abs(je_data.get("amount", 0))
            if txn.amount == 0.0 and amount > 0:
                txn.amount = -amount
            db.add(models.JournalEntry(
                je_number=models.next_je_number(db),
                transaction_id=txn.id,
                debit_account=je_data["debit_account"],
                credit_account=je_data["credit_account"],
                amount=amount,
                je_date=je_data.get("je_date"),
                memo=je_data.get("memo"),
                ai_confidence=je_data.get("ai_confidence"),
                ai_reasoning=je_data.get("ai_reasoning"),
            ))
            je_created += 1

    db.commit()
    return {"status": "ok", "transaction_id": txn.id, "je_created": je_created}


@router.post("/inbound")
async def inbound_email(
    request: Request,
    token: Optional[str] = None,
    client_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    # The shared token is the only thing guarding this write path, so cap how
    # fast it can be guessed. A real mail provider posts a handful of times a
    # minute at most.
    ratelimit.guard(
        request, "email_inbound", max_hits=20, window=300,
        message="Too many requests.",
    )
    _verify_token(token)

    payload = await request.json()

    headers = payload.get("headers", {})
    subject = headers.get("subject") or headers.get("Subject") or "Forwarded Invoice"

    attachments = payload.get("attachments", [])
    invoice_text = _extract_pdf_text(attachments)

    if not invoice_text:
        plain = payload.get("plain", "") or payload.get("html", "")
        invoice_text = plain[:10000] or None

    client = _pick_client(db, client_id)
    if not client:
        return {"status": "no_client"}

    return _create_transaction_and_jes(db, client, subject, invoice_text)


@router.get("/address")
def get_inbound_address(current_user: models.User = Depends(get_current_user)):
    address = os.getenv("INBOUND_EMAIL_ADDRESS", "")
    return {"address": address}
