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
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db, SessionLocal
from models import Client, JournalEntry, Transaction, TransactionStatus, User
import qbo_client as qbo
import qbo_idempotency
import schedule_tieout
import audit

router = APIRouter(prefix="/clients/{client_id}/qbo", tags=["qbo"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_client(client_id: int, user: User, db: Session) -> Client:
    client = db.query(Client).filter(Client.id == client_id, Client.user_id == user.id).first()
    if not client:
        raise HTTPException(404, "Client not found")
    return client


def _qbo_error_detail(exc: Exception, action: str) -> str:
    """Turn a raw QBO/httpx failure into a message a bookkeeper can act on.

    The common failure is a token-refresh 400 on Intuit's OAuth endpoint
    (`.../tokens/bearer`) — the QBO connection has expired or the refresh token
    was rotated out from under us. That surfaced as a raw
    "Client error '400 Bad Request' for url '.../tokens/bearer'" string, which
    reads like the account NAMES are wrong when the real fix is to reconnect
    QuickBooks. Detect that case and say so plainly; otherwise pass the detail
    through so genuine COA problems are still visible.

    `action` completes the sentence "Couldn't {action}".
    """
    s = str(exc).lower()
    is_auth = (
        "tokens/bearer" in s
        or "invalid_grant" in s
        or ("refresh" in s and "token" in s)
        or "401" in s
        or ("oauth" in s and "400" in s)
    )
    if is_auth:
        return (
            f"Couldn't {action} — your QuickBooks connection has expired and needs "
            "to be reconnected. Go to Settings → Connect QuickBooks to re-authorize. "
            "(This is a QuickBooks sign-in issue, not a problem with your account names.)"
        )
    return f"Couldn't {action}: {exc}"


def _persist_tokens_standalone(client_id: int, tokens: dict) -> None:
    """
    Persist rotated QBO tokens in their OWN short-lived, committed transaction.

    Used as the QBOClient.on_refresh callback. Isolated from the request's
    session on purpose: Intuit invalidates the previous refresh token the
    moment a new one is issued, so the new token MUST survive even if the rest
    of the request later fails and rolls back.
    """
    db = SessionLocal()
    try:
        c = db.query(Client).filter(Client.id == client_id).first()
        if c:
            c.qbo_access_token     = tokens["access_token"]
            c.qbo_refresh_token    = tokens["refresh_token"]
            c.qbo_token_expires_at = tokens["token_expires_at"]
            db.commit()
    finally:
        db.close()


def _load_tokens_standalone(client_id: int) -> Optional[dict]:
    """Return the latest persisted QBO tokens for a client (own session)."""
    db = SessionLocal()
    try:
        c = db.query(Client).filter(Client.id == client_id).first()
        if not c:
            return None
        return {
            "access_token":     c.qbo_access_token,
            "refresh_token":    c.qbo_refresh_token,
            "token_expires_at": c.qbo_token_expires_at,
        }
    finally:
        db.close()


def _get_qbo_client(client: Client) -> qbo.QBOClient:
    if not client.qbo_access_token or not client.qbo_realm_id:
        raise HTTPException(400, "QuickBooks is not connected for this client")
    client_id = client.id
    return qbo.QBOClient(
        access_token=client.qbo_access_token,
        refresh_token=client.qbo_refresh_token or "",
        realm_id=client.qbo_realm_id,
        token_expires_at=client.qbo_token_expires_at or datetime.utcnow(),
        on_refresh=lambda tokens: _persist_tokens_standalone(client_id, tokens),
        reload_tokens=lambda: _load_tokens_standalone(client_id),
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
    synced:            int
    created_vendors:   list[str]
    created_customers: list[str] = []
    errors:            list[str]
    # Entries QuickBooks already held, which this run therefore did not push.
    # Surfaced rather than swallowed: a non-empty list after a clean run means
    # a previous push reached QuickBooks without being recorded here, which is
    # worth a look even though the duplicate was prevented.
    already_in_qbo:    list[str] = []


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/auth-url")
def get_auth_url(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the Intuit OAuth URL. The client_id is passed as OAuth state."""
    # /callback already refuses to attach tokens to a client you don't own, so
    # this was not exploitable — but there is no reason to mint a URL carrying
    # someone else's client id as state, so it is checked here too.
    _get_client(client_id, current_user, db)
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


# How long a cached chart of accounts is trusted. This used to be "the same
# calendar month", which meant an account added in QuickBooks on the 2nd could
# not appear in any dropdown until the 1st of the next month — the only way to
# see it sooner was a buried refresh link, so the practical workaround became
# disconnecting and reconnecting QuickBooks. Ten minutes keeps the cache doing
# its job (one QBO round trip instead of one per page load) while making a new
# account show up on its own, without anyone having to know the button exists.
COA_CACHE_TTL = timedelta(minutes=10)


def _cache_is_current(client: Client) -> bool:
    """Whether the cached chart of accounts is still within COA_CACHE_TTL."""
    if not client.qbo_coa_cache or not client.qbo_coa_cached_at:
        return False
    return datetime.utcnow() - client.qbo_coa_cached_at < COA_CACHE_TTL


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

    Cached on the Client row for COA_CACHE_TTL and re-pulled on the first
    request after that, so an account added in QuickBooks appears on its own
    within minutes. The monthly scheduled job stays as a backstop for clients
    nobody has opened. Pass `refresh=true` to force-refresh now.
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
        raise HTTPException(502, _qbo_error_detail(exc, "load your QuickBooks chart of accounts"))
    return {"accounts": names, "cached_at": client.qbo_coa_cached_at}


@router.get("/customers")
def get_customers(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the list of active customer names pulled live from QBO."""
    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)
    try:
        names = qbo_c.get_customer_names()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, _qbo_error_detail(exc, "load your QuickBooks customer list"))
    _persist_token_refresh(client, qbo_c, db)
    return {"customers": names}


@router.get("/journal-entries")
def list_qbo_journal_entries(
    client_id: int,
    start: str,
    end: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What QuickBooks actually holds for a date range, and which of it we know about.

    Read-only diagnostic. Entries QuickBooks has that no journal entry here
    points at are the footprint of an interrupted push — the batch reached
    Intuit but the ids never made it back — and they are what a retry turns
    into duplicates.
    """
    client = _get_client(client_id, current_user, db)
    qbo_c = _get_qbo_client(client)
    try:
        entries = qbo_c.list_journal_entries(start, end)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, _qbo_error_detail(exc, "read your QuickBooks journal entries"))
    _persist_token_refresh(client, qbo_c, db)

    known = {
        str(row[0])
        for row in db.query(JournalEntry.qbo_je_id)
        .join(Transaction, JournalEntry.transaction_id == Transaction.id)
        .filter(Transaction.client_id == client_id, JournalEntry.qbo_je_id.isnot(None))
        .all()
    }
    out = []
    for e in entries:
        lines = []
        for ln in e.get("Line") or []:
            d = ln.get("JournalEntryLineDetail") or {}
            lines.append({
                "posting": d.get("PostingType"),
                "account": (d.get("AccountRef") or {}).get("name"),
                "amount": ln.get("Amount"),
                "description": ln.get("Description"),
            })
        out.append({
            "qbo_id": e.get("Id"),
            "doc_number": e.get("DocNumber"),
            "txn_date": e.get("TxnDate"),
            "total": e.get("TotalAmt"),
            "created": (e.get("MetaData") or {}).get("CreateTime"),
            "known_to_app": str(e.get("Id")) in known,
            "lines": lines,
        })
    return {
        "count": len(out),
        "known_to_app": sum(1 for e in out if e["known_to_app"]),
        "unknown_to_app": sum(1 for e in out if not e["known_to_app"]),
        "entries": out,
    }


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
        raise HTTPException(502, _qbo_error_detail(exc, "load your QuickBooks chart of accounts"))

    # ── Ask QuickBooks what it already holds ────────────────────────────────
    # The local export flag is written after the POST returns, so a push that
    # QuickBooks accepted while the response was lost leaves no trace here and
    # would be sent again. The only record of that entry is in QuickBooks, so
    # read it back before pushing anything. One read per object type over the
    # batch's own date range, not one per entry.
    #
    # A failure here must not become a licence to double-post: if the read
    # fails the sync stops, because the alternative is exactly the September
    # 2026 duplicate.
    _tx_by_id = {t.id: t for t in transactions}
    _batch_jes = (
        db.query(JournalEntry)
        .filter(JournalEntry.transaction_id.in_(list(_tx_by_id)))
        .all()
    ) if _tx_by_id else []
    _dates = [
        d for d in (
            (je.je_date or _tx_by_id[je.transaction_id].date)
            for je in _batch_jes
            if je.transaction_id in _tx_by_id
        ) if d is not None
    ]
    existing = qbo_idempotency.ExistingIndex()
    if _dates:
        _lo = min(_dates).strftime("%Y-%m-%d")
        _hi = max(_dates).strftime("%Y-%m-%d")
        try:
            existing = qbo_idempotency.ExistingIndex.build(
                qbo_c.list_journal_entries(_lo, _hi),
                qbo_c.list_purchases(_lo, _hi),
            )
        except Exception as exc:
            raise HTTPException(502, _qbo_error_detail(
                exc,
                "read back what QuickBooks already holds. Nothing was pushed — "
                "pushing without this check is what duplicated September 2026",
            ))

    skipped_already_in_qbo: list[str] = []

    # Vendor cache: display_name → QBO vendor Id (avoids redundant API calls)
    vendor_cache: dict[str, str]  = {}
    created_vendors: list[str]    = []
    # Customer cache: display_name → QBO customer Id (for income/deposit lines)
    customer_cache: dict[str, str] = {}
    created_customers: list[str]   = []
    errors: list[str]             = []
    synced                        = 0
    skipped_already_exported      = 0

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
            # The flag is the authority, not the id. An entry can reach
            # QuickBooks and lose its id here — that is exactly what happened
            # when a push died mid-batch before the per-entry commit, and the
            # retry sent the whole batch again. Once this is set, the entry is
            # never pushed again, whatever the app has been through since.
            if getattr(je, "exported_to_qbo", False) and not force:
                synced += 1
                skipped_already_exported += 1
                continue
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
            # Fall back to the bare account name when the parent-qualified name
            # misses. QBO_PARENT is a hand-maintained map; when it disagrees with
            # the real chart (an account moved to top level, or was never a child)
            # the FQN it builds doesn't exist and the export dies on a perfectly
            # valid account. The bare name is what QBO indexes anyway, so try it
            # before giving up.
            def _resolve_account(name: str) -> tuple[str, Optional[str]]:
                fqn = qbo.normalize_account_name(name)
                for key in (fqn, fqn.lower(), name, name.lower()):
                    acct_id = account_map.get(key)
                    if acct_id:
                        return fqn, acct_id
                return fqn, None

            debit_fqn,  debit_id  = _resolve_account(je.debit_account)
            credit_fqn, credit_id = _resolve_account(je.credit_account)

            if not debit_id or not credit_id:
                missing = [n for n, i in [(debit_fqn, debit_id), (credit_fqn, credit_id)] if not i]
                je.qbo_export_error = f"Account(s) not found in QBO: {', '.join(missing)}"
                errors.append(f"JE {je.je_number or je.id}: {je.qbo_export_error}")
                continue

            # ── Resolve customer (for income/deposit lines) ─────────────────
            customer_id: Optional[str] = None
            if je.customer_name and je.customer_name.strip():
                cname = je.customer_name.strip()
                if cname not in customer_cache:
                    try:
                        cid, was_created = qbo_c.get_or_create_customer(cname)
                        customer_cache[cname] = cid
                        if was_created:
                            created_customers.append(cname)
                    except Exception as exc:
                        errors.append(f"Customer '{cname}': {exc}")
                        customer_cache[cname] = ""   # don't retry this customer
                customer_id = customer_cache.get(cname) or None

            # QBO requires the customer on any Accounts Receivable line. Place it
            # on whichever side is A/R; for an A/R debit (DR A/R / CR Income) tag
            # both lines so the income line still attributes by customer.
            debit_type_je  = account_types.get(debit_id, "")
            credit_type_je = account_types.get(credit_id, "")
            if debit_type_je == "Accounts Receivable":
                customer_line = "both"
            elif credit_type_je == "Accounts Receivable":
                customer_line = "credit"
            else:
                customer_line = "credit"

            txn_date  = (je.je_date or tx.date).strftime("%Y-%m-%d")
            memo      = je.memo or tx.description
            doc_number = str(je.je_number or je.id)

            # Does QuickBooks already hold this entry? Checked against what was
            # just read back, not against our own flags — the whole point is
            # that our flags can be wrong in the one direction that duplicates.
            _key = qbo_idempotency.entry_key(
                client_id, memo, je.je_date or tx.date, je.amount,
                je.debit_account, je.credit_account,
            )
            if not force:
                _hit, _how = existing.find(_key, doc_number, txn_date, je.amount)
                if _hit:
                    # Adopt the id so the app stops being blind to it, and mark
                    # it exported so this is a one-time reconciliation.
                    je.qbo_je_id       = _hit
                    je.exported_to_qbo = True
                    if not je.exported_at:
                        je.exported_at = datetime.utcnow()
                    db.commit()
                    audit.record(
                        db, current_user.id, "je_already_in_qbo",
                        transaction_id=tx.id, client_id=client_id,
                        after={"je_number": je.je_number, "qbo_id": _hit,
                               "matched_on": _how, "key": _key},
                    )
                    skipped_already_in_qbo.append(
                        "JE %s ($%.2f, %s): already in QuickBooks as %s (matched on %s)"
                        % (je.je_number or je.id, je.amount or 0, txn_date, _hit, _how)
                    )
                    synced += 1
                    continue

            # Stamp the key so the next run recognises this entry exactly,
            # rather than falling back to the weaker document-number match.
            memo = qbo_idempotency.stamp(memo, _key)

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
                        doc_number=doc_number,
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
                        doc_number=doc_number,
                        txn_date=txn_date,
                        memo=memo,
                        debit_account_id=debit_id,
                        credit_account_id=credit_id,
                        amount=je.amount,
                        vendor_id=vendor_id or "",
                        vendor_name=tx.counterparty_name or "",
                        customer_id=customer_id or "",
                        customer_name=je.customer_name or "",
                        customer_line=customer_line,
                    )
                je.qbo_je_id        = qbo_id
                je.qbo_object_type  = "Purchase" if use_purchase else "JournalEntry"
                je.qbo_export_error = None
                # Written and committed before the next entry is pushed, so an
                # interruption can never lose the fact that QuickBooks already
                # holds this one.
                je.exported_to_qbo  = True
                if not je.exported_at:
                    je.exported_at  = datetime.utcnow()
                db.commit()
                audit.record(
                    db, current_user.id, "je_exported_to_qbo",
                    transaction_id=tx.id, client_id=client_id,
                    after={"je_number": je.je_number, "qbo_id": qbo_id,
                           "qbo_object_type": je.qbo_object_type,
                           "amount": je.amount,
                           "debit_account": je.debit_account,
                           "credit_account": je.credit_account},
                )
                if mark_exported:
                    je.exported_at  = datetime.utcnow()
                synced += 1
            except Exception as exc:
                je.qbo_export_error = str(exc)
                errors.append(f"JE {je.je_number or je.id}: {exc}")

        # Mark transaction exported when every JE for it has a QBO ID (only if requested)
        if mark_exported and all(j.qbo_je_id for j in jes):
            tx.status = TransactionStatus.exported

        # Commit per transaction, not once at the end. Each iteration has
        # already pushed real journal entries into QuickBooks, and a batch of
        # seventy runs for minutes — long enough to meet an edge timeout, a
        # deploy restart or a dropped connection. With a single commit at the
        # end, any of those loses every qbo_je_id for work Intuit has already
        # accepted, and the obvious next move — press export again — posts the
        # whole batch a second time. Committing as it goes makes a retry resume
        # from where it stopped instead of duplicating.
        db.commit()

    db.commit()
    _persist_token_refresh(client, qbo_c, db)

    if skipped_already_exported:
        errors.append(
            f"Skipped {skipped_already_exported} journal entr"
            f"{'ies' if skipped_already_exported != 1 else 'y'} already pushed to QuickBooks."
        )
    return SyncResult(
        synced=synced,
        created_vendors=created_vendors,
        created_customers=created_customers,
        errors=errors,
        already_in_qbo=skipped_already_in_qbo,
    )


# ── Month-end close check ────────────────────────────────────────────────────

class CloseCheckResult(BaseModel):
    period:             str
    qbo_entries:        int
    duplicates:         list[dict]
    recurring_series:   list[dict]
    orphans:            list[dict]
    clean:              bool


@router.get("/close-check", response_model=CloseCheckResult)
def close_check(
    client_id: int,
    period: str,                      # "YYYY-MM"
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read-only month-end check: would this period close clean?

    Three questions, all answered from what QuickBooks actually holds rather
    than from this app's record of what it pushed — the September 2026
    duplicate was invisible here precisely because the app's record was the
    thing that was wrong.

      duplicates        two entries sharing a document number, date and amount
      recurring_series  each recurring entry that should appear once a month —
                        amortization, depreciation, accruals — counted for this
                        period, so a missing one and a doubled one both show
      orphans           entries QuickBooks holds that nothing here points at

    Pushes nothing and changes nothing.
    """
    import calendar
    from collections import defaultdict

    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)

    try:
        year, month = (int(x) for x in period.split("-"))
        start = f"{year:04d}-{month:02d}-01"
        end   = f"{year:04d}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}"
    except Exception:
        raise HTTPException(400, "period must be YYYY-MM, e.g. 2026-09")

    try:
        jes       = qbo_c.list_journal_entries(start, end)
        purchases = qbo_c.list_purchases(start, end)
    except Exception as exc:
        raise HTTPException(502, _qbo_error_detail(exc, "read your QuickBooks entries"))

    rows = [(e, qbo_idempotency.debit_total(e), "JournalEntry") for e in jes]
    rows += [(e, qbo_idempotency.purchase_total(e), "Purchase") for e in purchases]

    # ── duplicates ──────────────────────────────────────────────────────────
    by_sig = defaultdict(list)
    for entry, amount, kind in rows:
        doc = (entry.get("DocNumber") or "").strip()
        if not doc:
            continue                      # Rippling's own entries carry none
        by_sig[qbo_idempotency.signature(doc, entry.get("TxnDate"), amount)].append(
            (entry, amount, kind)
        )
    duplicates = []
    for sig, group in sorted(by_sig.items()):
        if len(group) < 2:
            continue
        duplicates.append({
            "doc_number": sig[0],
            "txn_date":   sig[1],
            "amount":     float(sig[2]),
            "count":      len(group),
            "qbo_ids":    [e.get("Id") for e, _, _ in group],
            "memo":       (group[0][0].get("PrivateNote") or "")[:120],
            "overstated_by": round(float(sig[2]) * (len(group) - 1), 2),
        })

    # ── recurring series ────────────────────────────────────────────────────
    # Count alone is the wrong signal, and saying so costs nothing: August 2026
    # legitimately holds two Vanta entries (the prepaid being set up, $8,832.60,
    # and that month's amortization, $736.05), ContextBridge runs three
    # depreciation schedules, and Rippling's employer tax posts twice a month.
    # A check that called those duplicates would be ignored by the second month.
    #
    # The real signal is a REPEATED AMOUNT inside one series in one period. Two
    # entries for $106.67 of Carta amortization in September is a duplicate;
    # $8,832.60 and $736.05 of Vanta is a prepaid and its first amortization.
    RECURRING = [
        ("Carta",                 "accrual: carta ("),
        ("Carta (equity mgmt)",   "accrual: carta (equity management)"),
        ("Vanta",                 "vanta"),
        ("Buckner",               "accrual: the buckner company"),
        ("Hanover",               "hanover insurance"),
        # The domain is one of the three schedules the Depreciation row already
        # counts ("Depreciation - Domain Name - September 2026"); listing it
        # separately reported a phantom "missing" every month, which is exactly
        # the kind of noise that gets a close check ignored.
        ("Depreciation",          "depreciation - "),
        ("Mercury Treasury fee",  "treasury fee"),
        ("Rippling employer tax", "rippling employer tax contribution"),
        ("People Center PEO",     "people center peo benefits fees"),
    ]
    notes = {str(e.get("Id")): (e.get("PrivateNote") or "").lower() for e, _, _ in rows}
    series = []
    for label, needle in RECURRING:
        hits = []
        for entry, amount, kind in rows:
            note = notes.get(str(entry.get("Id")), "")
            if needle not in note:
                continue
            # "Carta" would otherwise swallow "Carta (equity management)".
            if label == "Carta" and "equity management" in note:
                continue
            hits.append({"qbo_id": entry.get("Id"), "amount": amount,
                         "txn_date": entry.get("TxnDate"), "type": kind,
                         "memo": (entry.get("PrivateNote") or "")[:80]})
        repeated = defaultdict(list)
        for h in hits:
            repeated["%.2f" % h["amount"]].append(h["qbo_id"])
        dup_amounts = {a: ids for a, ids in repeated.items() if len(ids) > 1}
        series.append({
            "name": label,
            "count": len(hits),
            "total": round(sum(h["amount"] for h in hits), 2),
            "entries": hits,
            "repeated_amounts": dup_amounts,
            "status": "DUPLICATED" if dup_amounts else ("missing" if not hits else "ok"),
            "overstated_by": round(
                sum(float(a) * (len(ids) - 1) for a, ids in dup_amounts.items()), 2
            ),
        })

    # ── orphans ─────────────────────────────────────────────────────────────
    known = {
        str(j.qbo_je_id)
        for j in db.query(JournalEntry)
        .join(Transaction, JournalEntry.transaction_id == Transaction.id)
        .filter(Transaction.client_id == client_id, JournalEntry.qbo_je_id.isnot(None))
        .all()
    }
    orphans = []
    for entry, amount, kind in rows:
        if str(entry.get("Id")) in known:
            continue
        note = (entry.get("PrivateNote") or "").strip()
        orphans.append({
            "qbo_id": entry.get("Id"), "type": kind,
            "doc_number": entry.get("DocNumber"), "txn_date": entry.get("TxnDate"),
            "amount": amount, "memo": note[:100],
            # A blank note is the signature of a QuickBooks entry this app never
            # wrote — Rippling's own integration posts these.
            "likely_external": not note,
        })

    dup_free   = not duplicates
    series_ok  = all(x["status"] != "DUPLICATED" for x in series)
    return CloseCheckResult(
        period=period,
        qbo_entries=len(rows),
        duplicates=duplicates,
        recurring_series=series,
        orphans=orphans,
        clean=dup_free and series_ok,
    )


# ── Schedule tie-out ─────────────────────────────────────────────────────────

class TieOutResult(BaseModel):
    period:         str
    schedules:      list[dict]
    unscheduled:    list[dict]
    clean:          bool
    total_variance: float


@router.get("/schedule-tieout", response_model=TieOutResult)
def schedule_tieout_report(
    client_id: int,
    period: str,                      # "YYYY-MM" — close through this month
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read-only: does every amortization and depreciation schedule tie to the GL?

    For each schedule, three numbers that have to agree — what the schedule
    says should have posted by now, what this app generated, and what
    QuickBooks actually holds — plus the prepaid balance that should remain.
    A schedule can fail in four directions and they need different fixes, so
    each is named rather than lumped into one "variance".

    Also lists recurring series QuickBooks holds that no schedule here backs.
    That is how Vanta and Hanover surface: real amortization posted by hand,
    with nothing in this app that would notice a skipped month.

    Pushes nothing and changes nothing.
    """
    from collections import defaultdict
    import models as _m

    client = _get_client(client_id, current_user, db)
    qbo_c  = _get_qbo_client(client)

    if not re.match(r"^\d{4}-\d{2}$", period or ""):
        raise HTTPException(400, "period must be YYYY-MM, e.g. 2026-09")

    assets = db.query(_m.FixedAsset).filter(_m.FixedAsset.client_id == client_id).all()
    rules  = (db.query(_m.StandingAccrualRule)
              .filter(_m.StandingAccrualRule.client_id == client_id).all())
    accrual_rows = (db.query(_m.AccruedExpense)
                    .filter(_m.AccruedExpense.client_id == client_id).all())

    starts = [schedule_tieout.asset_first_period(a) for a in assets]
    starts += [r.service_period for r in accrual_rows if r.service_period]
    starts = [s for s in starts if s]
    first = min(starts) if starts else period
    if first > period:
        first = period

    lo = schedule_tieout.month_end(first).replace(day=1).isoformat()
    hi = schedule_tieout.month_end(period).isoformat()
    try:
        qbo_rows = qbo_c.list_journal_entries(lo, hi) + qbo_c.list_purchases(lo, hi)
    except Exception as exc:
        raise HTTPException(502, _qbo_error_detail(exc, "read your QuickBooks entries"))

    def _amount(e):
        return (qbo_idempotency.debit_total(e) if e.get("Line")
                else qbo_idempotency.purchase_total(e))

    # QuickBooks entries are matched to a schedule by the ACCOUNT they post to
    # and the amount, not by their memo. Memo matching failed in both
    # directions on live data: the Domain Name's first four months carry no
    # memo (they predate this app) and Hanover's April reads "Business Owners
    # Advantage Policy - April 2026". Both were invisible, and the tie-out
    # reported confident variances that were not real.
    qbo_entries = []
    for e in qbo_rows:
        txn_date = (e.get("TxnDate") or "")[:7]
        if txn_date:
            qbo_entries.append((txn_date, e))

    def qbo_hits(account, amount, periods, posting=None):
        """QBO entries posting `amount` to `account`, grouped by month."""
        found = defaultdict(list)
        wanted = set(periods)
        for per, e in qbo_entries:
            if per in wanted and schedule_tieout.entry_hits(e, account, amount, posting):
                found[per].append(e.get("Id"))
        return found

    keel_accrual = defaultdict(list)
    keel_asset   = defaultdict(list)
    for je in (db.query(JournalEntry)
               .join(Transaction, JournalEntry.transaction_id == Transaction.id)
               .filter(Transaction.client_id == client_id).all()):
        memo = je.memo or ""
        hit = schedule_tieout.parse_accrual_memo(memo)
        if hit:
            keel_accrual[hit].append((je.id, float(je.amount or 0)))
            continue
        hit = schedule_tieout.parse_asset_memo(memo)
        if hit:
            keel_asset[hit].append((je.id, float(je.amount or 0)))

    schedules: list[dict] = []
    seen_vendors: set = set()
    seen_assets: set  = set()

    # ── prepaid / amortization schedules ────────────────────────────────────
    # Keyed on the vendor, not on StandingAccrualRule. A prepaid created from
    # the Payments tab has no standing rule — Hanover is twelve real rows with
    # standing_rule_id None — and reading only standing rules called that
    # "unscheduled" and skipped it. The accrued-expense rows ARE the schedule;
    # a standing rule, where one exists, just states the promise more exactly.
    rows_by_vendor = defaultdict(list)
    for a in accrual_rows:
        if a.vendor_name:
            rows_by_vendor[a.vendor_name].append(a)
    rule_by_vendor = {r.vendor_name: r for r in rules}

    for vendor_name, own in sorted(rows_by_vendor.items()):
        rule = rule_by_vendor.get(vendor_name)
        derived = schedule_tieout.derive_schedule(own)
        if rule is not None and rule.schedule_end_month and rule.amount:
            monthly = round(float(rule.amount), 2)
            start_p = min((a.service_period for a in own if a.service_period),
                          default=(derived or {}).get("start"))
            end_p   = rule.schedule_end_month
            source  = "standing rule"
        elif derived:
            monthly, start_p, end_p = derived["monthly"], derived["start"], derived["end"]
            source = "prepaid schedule"
        else:
            continue                    # variable accrual: no fixed promise to test
        if not start_p:
            continue

        vendor  = schedule_tieout._norm(vendor_name)
        seen_vendors.add(vendor)
        through = min(period, end_p)
        periods = schedule_tieout.months_between(start_p, through)
        if not periods:
            continue
        expected = round(monthly * len(periods), 2)
        keel_total = round(sum(a for p in periods
                               for _, a in keel_accrual.get((vendor, p), [])), 2)
        # The expense account this schedule debits each month is its anchor in
        # the ledger. Hanover and Buckner both debit Business insurance, so the
        # amount separates them; both are distinct to the cent.
        expense_acct = (getattr(rule, "expense_account", None)
                        or next((a.debit_account for a in own if a.debit_account), None))
        qbo_by_period = qbo_hits(expense_acct, monthly, periods, "Debit")
        qbo_total = round(monthly * sum(len(v) for v in qbo_by_period.values()), 2)
        all_periods = schedule_tieout.months_between(start_p, end_p)
        original = round(monthly * len(all_periods), 2)

        schedules.append({
            "kind": "prepaid", "name": vendor_name,
            "rule_id": rule.id if rule else None, "source": source,
            "monthly": monthly, "start": start_p, "end": end_p,
            "months_elapsed": len(periods), "months_total": len(all_periods),
            "expected_to_date": expected, "keel_to_date": keel_total,
            "qbo_to_date": qbo_total,
            "original_amount": original,
            "balance_expected": round(original - expected, 2),
            "balance_per_gl": round(original - qbo_total, 2),
            "variance_qbo_vs_expected": round(qbo_total - expected, 2),
            "missing_periods": [p for p in periods if not keel_accrual.get((vendor, p))],
            "duplicated_periods": {p: ids for p, ids in qbo_by_period.items()
                                   if len(ids) > 1},
            "missing_in_qbo": [p for p in periods if not qbo_by_period.get(p)],
            "anchor_account": expense_acct,
            "status": schedule_tieout.classify(expected, keel_total, qbo_total),
            "flags": schedule_tieout.flags(expected, keel_total, qbo_total),
        })

    # ── prepaids coded straight to journal entries ──────────────────────────
    # "Code as Prepaid" writes the whole year's amortization as journal entries
    # against the original transaction and never creates accrued-expense rows,
    # so a schedule built this way is invisible to everything above. Vanta is
    # one: twelve $736.05 entries dated each month-end from August 2026, all
    # thirteen of them pushed to QuickBooks in a twelve-second burst on
    # 2026-09-04. Nothing posts monthly — the whole year was posted at once and
    # future-dated, which is why it looks like a monthly entry appears.
    je_rows = (db.query(JournalEntry, Transaction)
               .join(Transaction, JournalEntry.transaction_id == Transaction.id)
               .filter(Transaction.client_id == client_id)
               .filter(JournalEntry.je_date.isnot(None))
               .all())
    by_txn = defaultdict(list)
    for je, tx in je_rows:
        by_txn[je.transaction_id].append(je)

    for txn_id, group in sorted(by_txn.items()):
        if len(group) < 3:
            continue
        amounts = [round(float(j.amount or 0), 2) for j in group]
        modal = max(set(amounts), key=amounts.count)
        monthly_jes = [j for j in group
                       if abs(round(float(j.amount or 0), 2) - modal) <= 0.05]
        if len(monthly_jes) < 3 or modal <= 0:
            continue
        months = sorted({j.je_date.strftime("%Y-%m") for j in monthly_jes})
        if len(months) != len(monthly_jes):
            continue                    # two in a month: not one-per-month
        if months != schedule_tieout.months_between(months[0], months[-1]):
            continue                    # not consecutive
        credit = next((j.credit_account for j in monthly_jes if j.credit_account), "")
        if "prepaid" not in (credit or "").lower():
            continue                    # only prepaid amortization, not payroll etc.
        # "Vanta Aug 2026 amortization" and "Vanta amortization (2026-08)" both
        # name the same schedule; strip the month either way so the row reads
        # "Vanta" rather than "Vanta Aug 2026".
        raw_memo = (monthly_jes[0].memo or "").strip()
        vendor_label = re.sub(
            r"\s*(?:\(\d{4}-\d{2}\)|[A-Z][a-z]{2,8}\s+\d{4})\s*|\s*amorti[sz]ation\s*",
            " ", raw_memo).strip() or raw_memo
        vendor = schedule_tieout._norm(vendor_label)
        if vendor in seen_vendors:
            continue
        seen_vendors.add(vendor)

        debit = next((j.debit_account for j in monthly_jes if j.debit_account), None)
        through = min(period, months[-1])
        periods = schedule_tieout.months_between(months[0], through)
        if not periods:
            continue
        expected = round(modal * len(periods), 2)
        keel_total = round(modal * len([m for m in months if m in set(periods)]), 2)
        qbo_by_period = qbo_hits(debit, modal, periods, "Debit")
        qbo_total = round(modal * sum(len(v) for v in qbo_by_period.values()), 2)
        original = round(modal * len(months), 2)

        schedules.append({
            "kind": "prepaid", "rule_id": None, "source": "coded as prepaid",
            "name": vendor_label,
            "monthly": modal, "start": months[0], "end": months[-1],
            "months_elapsed": len(periods), "months_total": len(months),
            "expected_to_date": expected, "keel_to_date": keel_total,
            "qbo_to_date": qbo_total,
            "original_amount": original,
            "balance_expected": round(original - expected, 2),
            "balance_per_gl": round(original - qbo_total, 2),
            "variance_qbo_vs_expected": round(qbo_total - expected, 2),
            "missing_periods": [],
            "duplicated_periods": {p: ids for p, ids in qbo_by_period.items() if len(ids) > 1},
            "missing_in_qbo": [p for p in periods if not qbo_by_period.get(p)],
            "anchor_account": debit,
            "status": schedule_tieout.classify(expected, keel_total, qbo_total),
            "flags": schedule_tieout.flags(expected, keel_total, qbo_total),
        })

    # ── fixed assets ────────────────────────────────────────────────────────
    for a in assets:
        name = schedule_tieout._norm(a.name)
        seen_assets.add(name)
        periods = schedule_tieout.asset_expected_periods(a, period)
        if not periods:
            continue
        monthly  = schedule_tieout.asset_monthly(a)
        expected = round(monthly * len(periods), 2)
        keel_total = round(sum(x for p in periods
                               for _, x in keel_asset.get((name, p), [])), 2)
        # Credits to this asset's accumulated account ARE its depreciation to
        # date. The two MacBooks share one accumulated account, so the monthly
        # amount tells them apart ($62.75 against $74.74).
        accum_acct = (getattr(a, "qbo_accum_dep_account", None)
                      or getattr(a, "qbo_dep_expense_account", None))
        qbo_by_period = qbo_hits(accum_acct, monthly, periods, "Credit")
        qbo_total = round(monthly * sum(len(v) for v in qbo_by_period.values()), 2)
        depreciable = round(float(a.purchase_price or 0) - float(a.salvage_value or 0), 2)

        schedules.append({
            "kind": "fixed_asset", "name": a.name, "asset_id": a.id,
            "monthly": monthly, "start": periods[0], "end": None,
            "months_elapsed": len(periods),
            "months_total": int(a.useful_life_months or 0),
            "expected_to_date": expected, "keel_to_date": keel_total,
            "qbo_to_date": qbo_total,
            "original_amount": depreciable,
            "balance_expected": round(depreciable - expected, 2),
            "balance_per_gl": round(depreciable - qbo_total, 2),
            "variance_qbo_vs_expected": round(qbo_total - expected, 2),
            "missing_periods": [p for p in periods if not keel_asset.get((name, p))],
            "duplicated_periods": {p: ids for p, ids in qbo_by_period.items()
                                   if len(ids) > 1},
            "missing_in_qbo": [p for p in periods if not qbo_by_period.get(p)],
            "anchor_account": accum_acct,
            "status": schedule_tieout.classify(expected, keel_total, qbo_total),
            "flags": schedule_tieout.flags(expected, keel_total, qbo_total),
        })

    # ── recurring in QuickBooks that no schedule here accounts for ─────────
    # Found by looking for a repeating monthly charge against Prepaid expenses
    # that none of the schedules above claimed. This is how Vanta shows up: it
    # amortizes $736.05 a month in QuickBooks with no accrued-expense rows here
    # at all, so nothing would notice if a month were skipped.
    claimed = set()
    for sch in schedules:
        for per in schedule_tieout.months_between(sch["start"], sch["end"] or period):
            claimed.add((round(sch["monthly"], 2), per))

    by_amount = defaultdict(list)
    for per, e in qbo_entries:
        for name, posting, amt in schedule_tieout.entry_lines(e):
            if posting != "Credit" or amt <= 0:
                continue
            if not schedule_tieout.account_matches(name, "Prepaid expenses"):
                continue
            if (amt, per) in claimed:
                continue
            by_amount[amt].append((per, e.get("Id"), (e.get("PrivateNote") or "")[:60]))

    unscheduled = []
    for amt, hits in sorted(by_amount.items(), key=lambda kv: -kv[0]):
        periods_seen = sorted({p for p, _, _ in hits})
        if len(periods_seen) < 2:
            continue            # a one-off prepaid release, not a schedule
        label = next((n for _, _, n in hits if n), "$%.2f monthly" % amt)
        unscheduled.append({
            "kind": "prepaid",
            "name": re.sub(r"\s*\(?\d{4}-\d{2}\)?|\s+[A-Z][a-z]{2} \d{4}", "", label).strip()
                    or ("$%.2f monthly" % amt),
            "periods": periods_seen,
            "total": round(amt * len(hits), 2),
            "note": "amortizing in QuickBooks with no schedule in this app",
        })

    return TieOutResult(
        period=period,
        schedules=sorted(schedules, key=lambda s: (s["status"] == "ok", s["name"])),
        unscheduled=unscheduled,
        clean=all(s["status"] == "ok" for s in schedules),
        total_variance=round(sum(abs(s["variance_qbo_vs_expected"]) for s in schedules), 2),
    )


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
