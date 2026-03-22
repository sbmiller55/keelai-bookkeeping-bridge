"""
Email inbound webhook — receives forwarded invoices and creates journal entries.

Uses Cloudmailin JSON format (free forever, no domain needed).
1. Sign up at cloudmailin.com
2. You'll get a free address like abc123@cloudmailin.net
3. Set Target URL to: https://your-server/email/inbound?token=bb-inbound-2026
4. Set format to "JSON (Normalized)"
5. Set INBOUND_EMAIL_ADDRESS=abc123@cloudmailin.net in .env
"""
import base64
import json
import os
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from database import get_db
import models
import ai_coder
import mercury as mercury_client

router = APIRouter(prefix="/email", tags=["email"])


def _verify_token(token: Optional[str]) -> None:
    expected = os.getenv("INBOUND_EMAIL_TOKEN", "")
    if not expected:
        return
    if token != expected:
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


def _pick_client(db: Session) -> Optional[models.Client]:
    return (
        db.query(models.Client)
        .filter(models.Client.mercury_api_key_encrypted.isnot(None))
        .first()
    )


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
    db: Session = Depends(get_db),
):
    _verify_token(token)

    payload = await request.json()

    headers = payload.get("headers", {})
    subject = headers.get("subject") or headers.get("Subject") or "Forwarded Invoice"

    attachments = payload.get("attachments", [])
    invoice_text = _extract_pdf_text(attachments)

    if not invoice_text:
        plain = payload.get("plain", "") or payload.get("html", "")
        invoice_text = plain[:10000] or None

    client = _pick_client(db)
    if not client:
        return {"status": "no_client"}

    return _create_transaction_and_jes(db, client, subject, invoice_text)


@router.get("/address")
def get_inbound_address():
    address = os.getenv("INBOUND_EMAIL_ADDRESS", "")
    return {"address": address}
