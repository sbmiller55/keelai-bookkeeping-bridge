"""Bill.com AP sync and connection test endpoints."""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Client, RevenueIntegrationSettings, Transaction, TransactionStatus, User

router = APIRouter(prefix="/clients/{client_id}/billcom", tags=["billcom"])


def _get_client(client_id: int, user: User, db: Session) -> Client:
    c = db.query(Client).filter(Client.id == client_id, Client.user_id == user.id).first()
    if not c:
        raise HTTPException(404, "Client not found")
    return c


def _get_settings(client_id: int, db: Session) -> RevenueIntegrationSettings:
    s = db.query(RevenueIntegrationSettings).filter(
        RevenueIntegrationSettings.client_id == client_id
    ).first()
    if not s or not s.billcom_enabled:
        raise HTTPException(400, "Bill.com integration not enabled for this client")
    if not s.billcom_username or not s.billcom_password:
        raise HTTPException(400, "Bill.com credentials not configured")
    return s


@router.post("/test")
def test_connection(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Verify Bill.com credentials by attempting login."""
    _get_client(client_id, current_user, db)
    s = _get_settings(client_id, db)
    import billcom_client
    client = billcom_client.BillComClient(
        username=s.billcom_username,
        password=s.billcom_password,
        org_id=s.billcom_org_id or "",
        dev_key=s.billcom_dev_key or "",
    )
    try:
        client._login()
        return {"ok": True, "message": "Connection successful"}
    except Exception as exc:
        raise HTTPException(400, f"Connection failed: {exc}")


@router.post("/sync-ap")
def sync_ap(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pull AP bills from Bill.com into the transactions table."""
    _get_client(client_id, current_user, db)
    s = _get_settings(client_id, db)
    import billcom_client

    try:
        bills = billcom_client.get_billcom_bills(
            s.billcom_username, s.billcom_password,
            s.billcom_org_id or "", s.billcom_dev_key or "",
        )
    except Exception as exc:
        raise HTTPException(502, f"Bill.com API error: {exc}")

    imported = []
    skipped = 0

    for bill in bills:
        external_id = f"billcom-ap-{bill['external_id']}"

        existing = db.query(Transaction).filter(
            Transaction.client_id == client_id,
            Transaction.mercury_transaction_id == external_id,
        ).first()
        if existing:
            skipped += 1
            continue

        desc = bill["vendor_name"]
        if bill.get("description"):
            desc = f"{bill['vendor_name']} - {bill['description']}"

        tx = Transaction(
            client_id=client_id,
            mercury_transaction_id=external_id,
            date=bill["invoice_date"] or datetime.utcnow(),
            description=desc,
            amount=-abs(bill["amount"]),
            counterparty_name=bill["vendor_name"],
            invoice_number=bill.get("invoice_number"),
            source="billcom",
            status=TransactionStatus.pending,
            raw_data=json.dumps(bill.get("raw") or {}, default=str)[:4000],
        )
        db.add(tx)
        imported.append(external_id)

    db.commit()
    return {"imported": len(imported), "skipped": skipped}
