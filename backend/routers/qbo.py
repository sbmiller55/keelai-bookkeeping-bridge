"""
QuickBooks Online integration endpoints.

Routes:
  GET  /clients/{id}/qbo/auth-url        — generate Intuit OAuth URL
  POST /clients/{id}/qbo/callback        — exchange auth code for tokens
  GET  /clients/{id}/qbo/status          — connection status
  DELETE /clients/{id}/qbo/disconnect    — revoke / clear tokens
  GET  /clients/{id}/qbo/accounts        — live COA from QBO
  POST /clients/{id}/qbo/sync            — push approved JEs to QBO
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Client, JournalEntry, Transaction, TransactionStatus, User
import qbo_client as qbo

router = APIRouter(prefix="/clients/{client_id}/qbo", tags=["qbo"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_client(client_id: int, user: User, db: Session) -> Client:
    client = db.query(Client).filter(Client.id == client_id, Client.user_id == user.id).first()
    if not client:
        raise HTTPException(404, "Client not found")
    return client


def _get_qbo_client(client: Client) -> qbo.QBOClient:
    if not client.qbo_access_token or not client.qbo_realm_id:
        raise HTTPException(400, "QuickBooks is not connected for this client")
    return qbo.QBOClient(
        access_token=client.qbo_access_token,
        refresh_token=client.qbo_refresh_token or "",
        realm_id=client.qbo_realm_id,
        token_expires_at=client.qbo_token_expires_at or datetime.utcnow(),
    )


def _persist_token_refresh(client: Client, qbo_c: qbo.QBOClient, db: Session):
    """If the QBO client refreshed its tokens mid-request, save them."""
    if qbo_c.updated_tokens:
        t = qbo_c.updated_tokens
        client.qbo_access_token     = t["access_token"]
        client.qbo_refresh_token    = t["refresh_token"]
        client.qbo_token_expires_at = t["token_expires_at"]
        db.commit()


# ── Request / response schemas ────────────────────────────────────────────────

class CallbackRequest(BaseModel):
    code:     str
    realm_id: str


class QboStatus(BaseModel):
    connected:        bool
    realm_id:         Optional[str]   = None
    token_expires_at: Optional[datetime] = None


class SyncResult(BaseModel):
    synced:          int
    created_vendors: list[str]
    errors:          list[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/auth-url")
def get_auth_url(
    client_id: int,
    current_user: User = Depends(get_current_user),
):
    """Return the Intuit OAuth URL. The client_id is passed as OAuth state."""
    url = qbo.get_auth_url(state=str(client_id))
    return {"url": url}


@router.post("/callback")
def oauth_callback(
    client_id: int,
    body: CallbackRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Exchange an authorization code for tokens and store them on the client."""
    client = _get_client(client_id, current_user, db)
    try:
        data = qbo.exchange_code(body.code)
    except Exception as exc:
        raise HTTPException(400, f"Token exchange failed: {exc}")

    client.qbo_access_token     = data["access_token"]
    client.qbo_refresh_token    = data.get("refresh_token")
    client.qbo_realm_id         = body.realm_id
    client.qbo_token_expires_at = datetime.utcnow() + timedelta(
        seconds=data.get("expires_in", 3600)
    )
    db.commit()
    return {"ok": True, "realm_id": body.realm_id}


@router.get("/status", response_model=QboStatus)
def get_status(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    client    = _get_client(client_id, current_user, db)
    connected = bool(client.qbo_access_token and client.qbo_realm_id)
    return QboStatus(
        connected=connected,
        realm_id=client.qbo_realm_id if connected else None,
        token_expires_at=client.qbo_token_expires_at if connected else None,
    )


@router.delete("/disconnect")
def disconnect(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    client = _get_client(client_id, current_user, db)
    client.qbo_access_token     = None
    client.qbo_refresh_token    = None
    client.qbo_realm_id         = None
    client.qbo_token_expires_at = None
    db.commit()
    return {"ok": True}


@router.post("/ensure-accounts")
def ensure_standard_accounts(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Ensure the standard depreciation/amortization accounts exist in QBO.
    Creates any that are missing; returns a summary of what was created.
    """
    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)

    STANDARD_ACCOUNTS = [
        ("Depreciation Expense",    "Expense",     "DepreciationAmortization"),
        ("Amortization Expense",    "Expense",     "DepreciationAmortization"),
        ("Accumulated Depreciation","OtherAsset",  "AccumulatedAmortization"),
        ("Accumulated Amortization","OtherAsset",  "AccumulatedAmortization"),
    ]

    created = []
    already_existed = []
    errors = []

    for name, acct_type, sub_type in STANDARD_ACCOUNTS:
        try:
            _, was_created = qbo_c.get_or_create_account(name, acct_type, sub_type)
            (created if was_created else already_existed).append(name)
        except Exception as exc:
            errors.append(f"{name}: {exc}")

    _persist_token_refresh(client, qbo_c, db)
    return {"created": created, "already_existed": already_existed, "errors": errors}


@router.get("/accounts")
def get_accounts(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fetch the live Chart of Accounts from QBO (active accounts only)."""
    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)
    try:
        names = qbo_c.get_coa_names()
    except Exception as exc:
        raise HTTPException(502, f"QBO error fetching accounts: {exc}")
    _persist_token_refresh(client, qbo_c, db)
    return {"accounts": names}


@router.post("/sync", response_model=SyncResult)
def sync_to_qbo(
    client_id: int,
    mark_exported: bool = True,
    force: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Push all approved journal entries to QBO.

    mark_exported: if False, transactions stay in 'approved' state after sync
    (useful for sandbox testing before syncing to production).
    """
    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)

    # Load approved transactions that have journal entries
    transactions = (
        db.query(Transaction)
        .filter(
            Transaction.client_id == client_id,
            Transaction.status    == TransactionStatus.approved,
        )
        .all()
    )
    if not transactions:
        return SyncResult(synced=0, created_vendors=[], errors=[])

    # Build account name → QBO ID map once for the whole sync
    try:
        account_map = qbo_c.build_account_map()
    except Exception as exc:
        raise HTTPException(502, f"Failed to fetch QBO Chart of Accounts: {exc}")

    # Vendor cache: display_name → QBO vendor Id (avoids redundant API calls)
    vendor_cache: dict[str, str]  = {}
    created_vendors: list[str]    = []
    errors: list[str]             = []
    synced                        = 0

    for tx in transactions:
        jes = (
            db.query(JournalEntry)
            .filter(JournalEntry.transaction_id == tx.id)
            .all()
        )
        if not jes:
            continue

        # ── Resolve vendor ──────────────────────────────────────────────────
        vendor_id: Optional[str] = None
        if tx.counterparty_name:
            name = tx.counterparty_name
            if name not in vendor_cache:
                try:
                    vid, was_created = qbo_c.get_or_create_vendor(name)
                    vendor_cache[name] = vid
                    if was_created:
                        created_vendors.append(name)
                except Exception as exc:
                    errors.append(f"Vendor '{name}': {exc}")
                    vendor_cache[name] = ""   # don't retry this vendor
            vendor_id = vendor_cache.get(name) or None

        # ── Push each JE ────────────────────────────────────────────────────
        for je in jes:
            if je.qbo_je_id and not force:   # already synced — skip
                synced += 1
                continue
            if force and je.qbo_je_id:
                obj_type = je.qbo_object_type or "JournalEntry"
                qbo_c.delete_object(obj_type, je.qbo_je_id)
                je.qbo_je_id = None

            # Resolve account names to QBO IDs via FullyQualifiedName
            debit_fqn  = qbo.normalize_account_name(je.debit_account)
            credit_fqn = qbo.normalize_account_name(je.credit_account)
            debit_id   = account_map.get(debit_fqn)
            credit_id  = account_map.get(credit_fqn)

            if not debit_id or not credit_id:
                missing = [n for n, i in [(debit_fqn, debit_id), (credit_fqn, credit_id)] if not i]
                je.qbo_export_error = f"Account(s) not found in QBO: {', '.join(missing)}"
                errors.append(f"JE {je.je_number or je.id}: {je.qbo_export_error}")
                continue

            txn_date = (je.je_date or tx.date).strftime("%Y-%m-%d")
            memo     = je.memo or tx.description

            try:
                # Use Purchase for vendor expenses paid from bank/card accounts.
                # These surface vendor names in QBO reports. Fall back to JE for
                # everything else (payroll, depreciation, non-vendor entries).
                credit_name = (je.credit_account or "").lower()
                is_bank_or_card = any(k in credit_name for k in ("mercury", "checking", "savings", "credit", "cash"))
                use_purchase = bool(vendor_id and is_bank_or_card)

                if use_purchase:
                    payment_type = "CreditCard" if "credit" in credit_name else "Cash"
                    qbo_id = qbo_c.create_purchase(
                        doc_number=str(je.je_number or je.id),
                        txn_date=txn_date,
                        memo=memo,
                        payment_account_id=credit_id,
                        expense_account_id=debit_id,
                        amount=je.amount,
                        vendor_id=vendor_id,
                        vendor_name=tx.counterparty_name or "",
                        payment_type=payment_type,
                    )
                else:
                    qbo_id = qbo_c.create_journal_entry(
                        doc_number=str(je.je_number or je.id),
                        txn_date=txn_date,
                        memo=memo,
                        debit_account_id=debit_id,
                        credit_account_id=credit_id,
                        amount=je.amount,
                        vendor_id=vendor_id or "",
                        vendor_name=tx.counterparty_name or "",
                    )
                je.qbo_je_id        = qbo_id
                je.qbo_object_type  = "Purchase" if use_purchase else "JournalEntry"
                je.qbo_export_error = None
                if mark_exported:
                    je.exported_at  = datetime.utcnow()
                synced += 1
            except Exception as exc:
                je.qbo_export_error = str(exc)
                errors.append(f"JE {je.je_number or je.id}: {exc}")

        # Mark transaction exported when every JE for it has a QBO ID (only if requested)
        if mark_exported and all(j.qbo_je_id for j in jes):
            tx.status = TransactionStatus.exported

    db.commit()
    _persist_token_refresh(client, qbo_c, db)

    return SyncResult(synced=synced, created_vendors=created_vendors, errors=errors)
