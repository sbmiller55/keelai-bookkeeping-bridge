"""Mercury REST API client."""
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
import urllib.error
import urllib.request

MERCURY_BASE_URL = "https://api.mercury.com/api/v1"
DEBUG_LOG = Path(__file__).parent / "sync_debug.log"

# Transaction kinds Mercury treats as outgoing (should be stored as negative amounts)
OUTGOING_KINDS = {
    "externalTransfer", "outgoing", "debit", "checkDeposit",
    "outgoingDomesticWire", "outgoingInternationalWire",
    "ach", "achOut", "cardTransaction", "creditCardTransaction",
}


def _debug(section: str, url: str, response: Any) -> None:
    with DEBUG_LOG.open("a") as f:
        f.write(f"\n{'='*80}\n")
        f.write(f"[{datetime.utcnow().isoformat()}] {section}\n")
        f.write(f"URL: {url}\n")
        f.write(f"RESPONSE:\n{json.dumps(response, indent=2, default=str)}\n")


class MercuryError(Exception):
    pass


def _request(path: str, api_key: str, section: str = "") -> Any:
    url = f"{MERCURY_BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Accept", "application/json")
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            _debug(section or path, url, data)
            return data
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        _debug(f"ERROR {section or path}", url, {"http_error": e.code, "body": body})
        raise MercuryError(f"Mercury API {e.code}: {body}")
    except Exception as e:
        _debug(f"ERROR {section or path}", url, {"error": str(e)})
        raise MercuryError(f"Mercury API error: {e}")


def _paginate(base_path: str, list_key: str, api_key: str, extra_params: Optional[dict] = None) -> list[dict]:
    """Generic cursor-based paginator. Returns all items from list_key."""
    results = []
    cursor = None
    page = 0
    while True:
        page += 1
        params: dict[str, str] = {"limit": "500", **(extra_params or {})}
        if cursor:
            params["start_after"] = cursor
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        sep = "&" if "?" in base_path else "?"
        data = _request(f"{base_path}{sep}{qs}", api_key, f"{list_key.upper()} page={page}")
        items = data.get(list_key, [])
        results.extend(items)
        next_cursor = data.get("page", {}).get("nextPage")
        if not next_cursor or not items:
            break
        cursor = next_cursor
    return results


def download_attachment_bytes(url: str) -> bytes:
    """Download file from S3 pre-signed URL."""
    req = urllib.request.Request(url)
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using pdfplumber."""
    import pdfplumber
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def get_transaction_detail(mercury_txn_id: str, api_key: str) -> Optional[dict]:
    """Fetch a single transaction by its Mercury ID to get attachments etc."""
    try:
        return _request(f"/transaction/{mercury_txn_id}", api_key, "TXN_DETAIL")
    except MercuryError:
        try:
            # Some transactions live under /payment/<id>
            return _request(f"/payment/{mercury_txn_id}", api_key, "PAYMENT_DETAIL")
        except MercuryError:
            return None


def get_all_pending_payments(api_key: str) -> list[dict]:
    """Fetch ALL pending outgoing payments regardless of date range."""
    return _paginate("/transactions", "transactions", api_key, {"status": "pending", "limit": "500"})


def get_accounts(api_key: str) -> list[dict]:
    data = _request("/accounts", api_key, "ACCOUNTS")
    return data.get("accounts", [])


def get_treasury_accounts(api_key: str) -> list[dict]:
    data = _request("/treasury", api_key, "TREASURY_ACCOUNTS")
    return data.get("accounts", [])


def get_treasury_transactions(treasury_id: str, api_key: str) -> list[dict]:
    return _paginate(f"/treasury/{treasury_id}/transactions", "transactions", api_key)


def get_all_transactions_global(api_key: str, start: Optional[str] = None, end: Optional[str] = None) -> list[dict]:
    """
    GET /transactions — global endpoint that returns ALL transaction types
    across ALL accounts including credit cards. This is the primary source.
    """
    params: dict[str, str] = {}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    return _paginate("/transactions", "transactions", api_key, params)


def get_account_transactions(account_id: str, api_key: str, start: Optional[str] = None, end: Optional[str] = None) -> list[dict]:
    """GET /account/{id}/transactions for a specific account."""
    params: dict[str, str] = {}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    return _paginate(f"/account/{account_id}/transactions", "transactions", api_key, params)


def _parse_amount(raw: Any) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _parse_date(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def _payment_method(kind: str) -> str:
    mapping = {
        "externalTransfer": "ACH",
        "ach": "ACH",
        "achOut": "ACH",
        "incomingDomesticWire": "Wire",
        "outgoingDomesticWire": "Wire",
        "outgoingInternationalWire": "Wire (International)",
        "internalTransfer": "Internal Transfer",
        "treasuryTransfer": "Treasury Transfer",
        "creditCardTransaction": "Credit Card",
        "cardTransaction": "Debit Card",
        "checkDeposit": "Check",
        "fee": "Fee",
        "other": "Other",
    }
    return mapping.get(kind, kind)


def normalize_transaction(txn: dict, account_name: str = "") -> dict:
    txn_id = txn.get("id", "")
    kind = txn.get("kind", "")

    date_raw = txn.get("postedAt") or txn.get("createdAt") or txn.get("canonicalDay") or txn.get("estimatedDeliveryDate")
    date = _parse_date(date_raw) or datetime.utcnow()

    counterparty = txn.get("counterpartyName") or txn.get("recipientName") or ""

    description = (
        txn.get("bankDescription")
        or txn.get("externalMemo")
        or txn.get("note")
        or txn.get("memo")
        or txn.get("description")
        or counterparty
        or "No description"
    )

    amount_raw = _parse_amount(txn.get("amount", 0))
    # Mercury stores outgoing as negative already in some cases; trust the sign if present
    amount = amount_raw

    category_data = txn.get("categoryData") or {}
    is_settled = bool(txn.get("postedAt"))
    category = category_data.get("name") or (txn.get("mercuryCategory") if is_settled else None)

    # Invoice number — sometimes in details or attachments
    invoice_number = (
        txn.get("invoiceNumber")
        or (txn.get("details") or {}).get("invoiceNumber")
        or None
    )
    if not invoice_number:
        for att in txn.get("attachments", []):
            inv = att.get("invoiceNumber") or att.get("invoice_number")
            if inv:
                invoice_number = str(inv)
                break

    return {
        "mercury_transaction_id": txn_id,
        "date": date,
        "description": str(description)[:500],
        "amount": amount,
        "mercury_category": str(category)[:255] if category else None,
        "kind": kind[:100] if kind else None,
        "counterparty_name": str(counterparty)[:255] if counterparty else None,
        "mercury_account_id": txn.get("accountId", "")[:100] or None,
        "mercury_account_name": account_name[:255] if account_name else None,
        "payment_method": _payment_method(kind)[:100] if kind else None,
        "invoice_number": str(invoice_number)[:100] if invoice_number else None,
        "raw_data": json.dumps(txn, default=str),
        "mercury_status": txn.get("status"),
    }


def get_transaction_rules(api_key: str) -> list[dict]:
    """
    Try to fetch saved transaction rules from Mercury.
    Returns empty list on any error (Mercury may not expose this endpoint).
    """
    try:
        data = _request("/rules", api_key, "RULES")
        return data.get("rules", []) if isinstance(data, dict) else []
    except Exception:
        return []


def sync_for_client(api_key: str, start: Optional[str] = None, end: Optional[str] = None) -> dict:
    # Reset log for this sync run
    with DEBUG_LOG.open("w") as f:
        f.write(f"SYNC STARTED {datetime.utcnow().isoformat()}\n")
        f.write(f"Date range: start={start} end={end}\n")

    accounts = get_accounts(api_key)
    if not accounts:
        raise MercuryError("No accounts found for this API key.")

    # Build account name lookup from accountId
    account_name_map: dict[str, str] = {
        a["id"]: (a.get("name") or a.get("accountNumber") or a["id"])
        for a in accounts
    }

    errors: list[str] = []
    all_txns: list[dict] = []
    account_summaries: list[dict] = []

    # ── 1. Global /transactions endpoint (catches credit cards + all account types) ──
    try:
        global_txns = get_all_transactions_global(api_key, start=start, end=end)

        # Resolve any account IDs not in the map (e.g. credit card accounts)
        unknown_ids = {
            t.get("accountId", "")
            for t in global_txns
            if t.get("accountId") and t.get("accountId") not in account_name_map
        }
        for acct_id in unknown_ids:
            try:
                acct_data = _request(f"/account/{acct_id}", api_key, f"ACCOUNT_{acct_id}")
                name = acct_data.get("name") or acct_data.get("accountNumber") or acct_id
                account_name_map[acct_id] = name
            except Exception:
                pass

        for t in global_txns:
            acct_name = account_name_map.get(t.get("accountId", ""), "")
            all_txns.append(normalize_transaction(t, account_name=acct_name))
    except MercuryError as e:
        errors.append(f"Global transactions: {e}")

    # ── 2. Treasury accounts and their transactions ──
    try:
        treasury_accounts = get_treasury_accounts(api_key)
        for ta in treasury_accounts:
            ta_id = ta["id"]
            ta_name = ta.get("name") or ta.get("accountNumber") or "Mercury Treasury"
            account_name_map[ta_id] = ta_name
            try:
                t_txns = get_treasury_transactions(ta_id, api_key)
                start_dt = _parse_date(start) if start else None
                end_dt = _parse_date(end) if end else None
                filtered = []
                for t in t_txns:
                    day = t.get("canonicalDay") or t.get("postedAt") or t.get("createdAt")
                    txn_dt = _parse_date(day)
                    if start_dt and txn_dt and txn_dt.date() < start_dt.date():
                        continue
                    if end_dt and txn_dt and txn_dt.date() > end_dt.date():
                        continue
                    if not any(n["mercury_transaction_id"] == t.get("id") for n in all_txns):
                        all_txns.append(normalize_transaction(t, account_name=ta_name))
                        filtered.append(t)
                account_summaries.append({"name": ta_name, "transactions": len(filtered), "scheduled": 0})
            except MercuryError as e:
                errors.append(f"Treasury account [{ta_name}]: {e}")
                account_summaries.append({"name": ta_name, "transactions": 0, "scheduled": 0})
    except MercuryError as e:
        errors.append(f"Treasury accounts: {e}")

    # ── 3. Per-account /account/{id}/transactions (catches anything global missed) ──
    for account in accounts:
        acct_id = account["id"]
        acct_name = account_name_map[acct_id]
        try:
            per_acct = get_account_transactions(acct_id, api_key, start=start, end=end)
            for t in per_acct:
                # Only add if not already captured by global call
                if not any(n["mercury_transaction_id"] == t.get("id") for n in all_txns):
                    all_txns.append(normalize_transaction(t, account_name=acct_name))
            account_summaries.append({"name": acct_name, "transactions": len(per_acct), "scheduled": 0})
        except MercuryError as e:
            errors.append(f"Account [{acct_name}]: {e}")
            account_summaries.append({"name": acct_name, "transactions": 0, "scheduled": 0})

    # ── 4. Deduplicate by mercury_transaction_id ──
    seen: set[str] = set()
    deduped: list[dict] = []
    for n in all_txns:
        tid = n["mercury_transaction_id"]
        if tid and tid not in seen:
            seen.add(tid)
            deduped.append(n)
        elif not tid:
            deduped.append(n)

    return {"transactions": deduped, "errors": errors, "accounts": account_summaries}
