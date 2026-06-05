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

import json
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
    needs_reconnect:  bool = False
    reconnect_reason: Optional[str] = None


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
    has_tokens = bool(client.qbo_access_token and client.qbo_realm_id)
    if not has_tokens:
        return QboStatus(connected=False)

    # We have stored tokens, but the OAuth refresh token may have expired
    # (Intuit invalidates them after 100 days of inactivity, and they're
    # single-use — a failed refresh leaves the row "connected" in name
    # only). Probe the live API cheaply; if it fails with an auth error,
    # flag needs_reconnect so the UI can prompt the user.
    try:
        qbo_c = _get_qbo_client(client)
        qbo_c.get_coa_names()  # cheap, paginated query
        _persist_token_refresh(client, qbo_c, db)
        return QboStatus(
            connected=True,
            realm_id=client.qbo_realm_id,
            token_expires_at=client.qbo_token_expires_at,
        )
    except Exception as exc:
        msg = str(exc)
        # Surface a friendly reconnect prompt for known auth-failure shapes.
        looks_like_auth = any(
            s in msg
            for s in ("400 Bad Request", "401", "invalid_grant", "Token", "oauth", "OAuth")
        )
        return QboStatus(
            connected=True,                # tokens exist
            realm_id=client.qbo_realm_id,
            token_expires_at=client.qbo_token_expires_at,
            needs_reconnect=True,
            reconnect_reason=(
                "QuickBooks token refresh failed — please disconnect and "
                "reconnect QBO." if looks_like_auth else f"QBO check failed: {msg[:200]}"
            ),
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


@router.get("/_debug_raw_accounts")
def _debug_raw_accounts(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Temporary diagnostic: return every Account row Intuit gives us
    (active and inactive), so we can see what the API actually exposes
    for parent/header accounts. REMOVE after debugging."""
    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)
    rows = qbo_c._query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 1000")
    out = [
        {
            "Name": r.get("Name"),
            "FullyQualifiedName": r.get("FullyQualifiedName"),
            "Active": r.get("Active"),
            "AccountType": r.get("AccountType"),
            "SubAccount": r.get("SubAccount"),
            "ParentRefValue": (r.get("ParentRef") or {}).get("value"),
            "Id": r.get("Id"),
        }
        for r in rows
    ]
    _persist_token_refresh(client, qbo_c, db)
    return {"count": len(out), "accounts": out}


def _cache_is_current(client: Client) -> bool:
    """Cache is current if it was refreshed in the same calendar month as today (UTC)."""
    if not client.qbo_coa_cache or not client.qbo_coa_cached_at:
        return False
    now = datetime.utcnow()
    cached = client.qbo_coa_cached_at
    return cached.year == now.year and cached.month == now.month


def _refresh_qbo_coa_cache(client: Client, db: Session) -> list[str]:
    """Pull live COA from QBO, persist to the client row, and return it."""
    qbo_c = _get_qbo_client(client)
    names = qbo_c.get_coa_names()
    client.qbo_coa_cache = json.dumps(names)
    client.qbo_coa_cached_at = datetime.utcnow()
    _persist_token_refresh(client, qbo_c, db)
    db.commit()
    return names


@router.get("/accounts")
def get_accounts(
    client_id: int,
    refresh: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return the Chart of Accounts pulled from QBO.

    Cached on the Client row and refreshed on the 1st of each month by a
    scheduled job; falls back to refreshing on first request of a new month
    or if the cache is empty. Pass `refresh=true` to force-refresh.
    """
    client = _get_client(client_id, current_user, db)

    if not refresh and _cache_is_current(client):
        try:
            return {"accounts": json.loads(client.qbo_coa_cache or "[]"), "cached_at": client.qbo_coa_cached_at}
        except Exception:
            pass  # fall through and refresh

    try:
        names = _refresh_qbo_coa_cache(client, db)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"QBO error fetching accounts: {exc}")
    return {"accounts": names, "cached_at": client.qbo_coa_cached_at}


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

    # Load approved transactions only. Force re-sync re-pushes the JEs of
    # already-API-synced approved transactions (delete + recreate); it must
    # NOT reach into status='exported' transactions — those are locked in.
    transactions = (
        db.query(Transaction)
        .filter(
            Transaction.client_id == client_id,
            Transaction.status == TransactionStatus.approved,
        )
        .all()
    )
    if not transactions:
        return SyncResult(synced=0, created_vendors=[], errors=[])

    # Build account name → QBO ID map and id → AccountType map once for the
    # whole sync. The type map drives the Purchase-vs-JournalEntry choice.
    try:
        account_map, account_types = qbo_c.build_account_lookup()
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

            # Resolve account names to QBO IDs via FullyQualifiedName.
            # build_account_map indexes both case-sensitive and lowercased keys,
            # so fall back to lowercase if the exact-case key misses (e.g. AI
            # returned "Employee Benefits" but QBO stores "Employee benefits").
            debit_fqn  = qbo.normalize_account_name(je.debit_account)
            credit_fqn = qbo.normalize_account_name(je.credit_account)
            debit_id   = account_map.get(debit_fqn)  or account_map.get(debit_fqn.lower())
            credit_id  = account_map.get(credit_fqn) or account_map.get(credit_fqn.lower())

            if not debit_id or not credit_id:
                missing = [n for n, i in [(debit_fqn, debit_id), (credit_fqn, credit_id)] if not i]
                je.qbo_export_error = f"Account(s) not found in QBO: {', '.join(missing)}"
                errors.append(f"JE {je.je_number or je.id}: {je.qbo_export_error}")
                continue

            txn_date = (je.je_date or tx.date).strftime("%Y-%m-%d")
            memo     = je.memo or tx.description

            try:
                # Use Purchase for vendor expenses paid from a real bank/card
                # account. These surface vendor names in QBO reports. Fall back
                # to JournalEntry for everything else (payroll, depreciation,
                # contra-expense, non-vendor entries). We key off QBO's actual
                # AccountType — substring matching the name was unreliable
                # (e.g. "Credit Card Rewards" is Income, not CreditCard).
                credit_type = account_types.get(credit_id, "")
                is_bank_or_card = credit_type in ("Bank", "CreditCard")
                use_purchase = bool(vendor_id and is_bank_or_card)

                if use_purchase:
                    payment_type = "CreditCard" if credit_type == "CreditCard" else "Cash"
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


# ── Rollback (recovery from a bad force re-sync) ─────────────────────────────

class RollbackResult(BaseModel):
    dry_run:           bool
    candidate_count:   int
    deleted_count:     int
    errors:            list[str]


@router.post("/rollback-all-synced", response_model=RollbackResult)
def rollback_all_synced(
    client_id: int,
    confirm: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Recovery endpoint. Deletes from QBO every JE for this client that has
    qbo_je_id set, then clears the cached qbo_je_id / qbo_object_type and
    reverts the parent transaction's status from 'exported' back to 'approved'.

    Pass confirm="DELETE_ALL_167" to actually run. Otherwise returns a dry-run
    count and changes nothing.
    """
    client = _get_client(client_id, current_user, db)

    candidates = (
        db.query(JournalEntry)
        .join(Transaction, JournalEntry.transaction_id == Transaction.id)
        .filter(
            Transaction.client_id == client_id,
            JournalEntry.qbo_je_id.isnot(None),
        )
        .all()
    )
    candidate_count = len(candidates)

    if confirm != "DELETE_ALL_167":
        return RollbackResult(
            dry_run=True,
            candidate_count=candidate_count,
            deleted_count=0,
            errors=[],
        )

    qbo_c = _get_qbo_client(client)
    errors: list[str] = []
    deleted_count = 0
    affected_tx_ids: set[int] = set()

    for je in candidates:
        try:
            qbo_c.delete_object(je.qbo_object_type or "JournalEntry", je.qbo_je_id)
            je.qbo_je_id = None
            je.qbo_object_type = None
            je.qbo_export_error = None
            je.exported_at = None
            affected_tx_ids.add(je.transaction_id)
            deleted_count += 1
        except Exception as exc:
            errors.append(f"JE {je.je_number or je.id}: {exc}")

    # Revert affected transactions from 'exported' back to 'approved'
    if affected_tx_ids:
        db.query(Transaction).filter(
            Transaction.id.in_(affected_tx_ids),
            Transaction.status == TransactionStatus.exported,
        ).update(
            {"status": TransactionStatus.approved},
            synchronize_session=False,
        )

    db.commit()
    _persist_token_refresh(client, qbo_c, db)

    return RollbackResult(
        dry_run=False,
        candidate_count=candidate_count,
        deleted_count=deleted_count,
        errors=errors,
    )
