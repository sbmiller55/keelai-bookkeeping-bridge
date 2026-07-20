"""
QuickBooks Online API client.

Handles OAuth token management, account lookup, vendor lookup/creation,
and journal entry creation.
"""

import base64
import os
import threading
from datetime import datetime, timedelta
from typing import Callable, Optional
from urllib.parse import urlencode

import httpx

# Per-realm refresh locks. Intuit rotates the refresh token on every refresh
# and invalidates the previous one, so two concurrent refreshes of the same
# token will make one of them fail with a 400. Serialize refreshes per realm.
_refresh_locks: dict[str, threading.Lock] = {}
_refresh_locks_guard = threading.Lock()


def _lock_for(realm_id: str) -> threading.Lock:
    with _refresh_locks_guard:
        lock = _refresh_locks.get(realm_id)
        if lock is None:
            lock = threading.Lock()
            _refresh_locks[realm_id] = lock
        return lock

# ── Config ────────────────────────────────────────────────────────────────────
# Read at call time (not module load) so .env changes are picked up after restart.

def _cfg() -> tuple[str, str, str, bool]:
    return (
        os.getenv("QBO_CLIENT_ID", ""),
        os.getenv("QBO_CLIENT_SECRET", ""),
        os.getenv("QBO_REDIRECT_URI", "http://localhost:3000/qbo-callback"),
        os.getenv("QBO_SANDBOX", "true").lower() == "true",
    )

INTUIT_AUTH_URL  = "https://appcenter.intuit.com/connect/oauth2"
INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
INTUIT_SCOPE     = "com.intuit.quickbooks.accounting"

# Sub-account parent map — mirrors the frontend QBO_PARENT constant.
# Used to build FullyQualifiedName for QBO API account lookup.
QBO_PARENT: dict[str, str] = {
    "Mercury Checking (9882) - 1":            "Cash",
    "Mercury Savings (3117) - 1":             "Cash",
    "Mercury Treasury - 1":                   "Cash",
    "Accounting, Tax & Finance fees":         "Legal, Finance & Accounting services",
    "Legal Fees":                             "Legal, Finance & Accounting services",
    "Bridge Loan from Founder":               "Short-term business loans",
    "Payroll Liabilities - Rippling":         "Payroll wages and tax to pay",
    "Payroll taxes Payable":                  "Payroll wages and tax to pay",
    "Long-term office equipment":             "Fixed Assets",
    "Domain Name":                            "Intangible Asset",
    "Accumulated Amortization - Domain Name": "Accumulated amortization",
    "Employee retirement plans":              "Employee benefits",
    "Group term life insurance":              "Employee benefits",
    "Health insurance & accident plans":      "Employee benefits",
    "Officers' life insurance":               "Employee benefits",
    "Workers' compensation insurance":        "Employee benefits",
    "Business insurance":                     "Insurance",
    "Liability insurance":                    "Insurance",
    "Airfare":                                "Travel",
    "Hotels":                                 "Travel",
    "Taxis or shared rides":                  "Travel",
    "Travel meals":                           "Travel",
    "Vehicle rental":                         "Travel",
    "Series Seed":                            "Preferred stock",
    "Interest Earned":                        "Other Income",
}

# Mercury API name normalization — same as frontend MERCURY_NAME_MAP
MERCURY_NAME_MAP: dict[str, str] = {
    "Mercury Checking ••9882": "Mercury Checking (9882) - 1",
    "Mercury Checking":        "Mercury Checking (9882) - 1",
    "Mercury Savings ••3117":  "Mercury Savings (3117) - 1",
    "Mercury Savings":         "Mercury Savings (3117) - 1",
    "Mercury Treasury":        "Mercury Treasury - 1",
}


def normalize_account_name(name: str) -> str:
    """Normalize Mercury bullet-character names and return the QBO FullyQualifiedName."""
    normalized = MERCURY_NAME_MAP.get(name, name)
    parent = QBO_PARENT.get(normalized)
    return f"{parent}:{normalized}" if parent else normalized


# ── OAuth helpers ─────────────────────────────────────────────────────────────

def get_auth_url(state: str) -> str:
    client_id, _, redirect_uri, _ = _cfg()
    params = {
        "client_id":     client_id,
        "scope":         INTUIT_SCOPE,
        "redirect_uri":  redirect_uri,
        "response_type": "code",
        "state":         state,
    }
    return f"{INTUIT_AUTH_URL}?{urlencode(params)}"


def _basic_auth_header() -> str:
    client_id, client_secret, _, _ = _cfg()
    creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return f"Basic {creds}"


def exchange_code(code: str) -> dict:
    """Exchange authorization code for access + refresh tokens."""
    _, _, redirect_uri, _ = _cfg()
    resp = httpx.post(
        INTUIT_TOKEN_URL,
        headers={
            "Authorization":  _basic_auth_header(),
            "Accept":         "application/json",
            "Content-Type":   "application/x-www-form-urlencoded",
        },
        data={
            "grant_type":   "authorization_code",
            "code":         code,
            "redirect_uri": redirect_uri,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_tokens(refresh_token: str) -> dict:
    """Use a refresh token to get a new access token (and possibly new refresh token)."""
    resp = httpx.post(
        INTUIT_TOKEN_URL,
        headers={
            "Authorization":  _basic_auth_header(),
            "Accept":         "application/json",
            "Content-Type":   "application/x-www-form-urlencoded",
        },
        data={
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


# ── QBO REST client ───────────────────────────────────────────────────────────

class QBOClient:
    """
    Authenticated wrapper around the QBO REST API.

    Automatically refreshes the access token when it's near expiry.
    If tokens are refreshed, `updated_tokens` is populated so the caller
    can persist the new values to the database.
    """

    def __init__(
        self,
        access_token: str,
        refresh_token: str,
        realm_id: str,
        token_expires_at: datetime,
        on_refresh: Optional[Callable[[dict], None]] = None,
        reload_tokens: Optional[Callable[[], Optional[dict]]] = None,
    ):
        self.access_token     = access_token
        self.refresh_token    = refresh_token
        self.realm_id         = realm_id
        self.token_expires_at = token_expires_at
        self.updated_tokens: Optional[dict] = None
        self._last_intuit_tid: str = ""
        # on_refresh(tokens): persist the newly-rotated tokens IMMEDIATELY (in
        #   its own committed transaction) so a later failure in the same
        #   request can't lose them. Intuit invalidates the old refresh token
        #   once a new one is issued, so an unpersisted rotation = dead account.
        # reload_tokens(): return the latest {access_token, refresh_token,
        #   token_expires_at} from the DB, so that after waiting on the refresh
        #   lock we can adopt a token another request just rotated instead of
        #   re-refreshing an already-consumed one.
        self.on_refresh     = on_refresh
        self.reload_tokens  = reload_tokens

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _base_url(self) -> str:
        _, _, _, sandbox = _cfg()
        host = "sandbox-quickbooks.api.intuit.com" if sandbox else "quickbooks.api.intuit.com"
        return f"https://{host}/v3/company/{self.realm_id}"

    def _token_is_fresh(self) -> bool:
        return datetime.utcnow() < self.token_expires_at - timedelta(minutes=5)

    def _ensure_fresh_token(self):
        if self._token_is_fresh():
            return

        # Serialize refreshes for this realm so two concurrent requests don't
        # both try to spend the same (single-use) refresh token.
        with _lock_for(self.realm_id):
            # Another request may have refreshed while we waited on the lock.
            # Adopt its freshly-persisted token instead of refreshing again.
            if self.reload_tokens is not None:
                latest = self.reload_tokens()
                if latest:
                    self.refresh_token = latest.get("refresh_token") or self.refresh_token
                    latest_access  = latest.get("access_token")
                    latest_expires = latest.get("token_expires_at")
                    if latest_access and latest_expires:
                        self.access_token     = latest_access
                        self.token_expires_at = latest_expires
                        if self._token_is_fresh():
                            return

            data = refresh_tokens(self.refresh_token)
            self.access_token     = data["access_token"]
            self.refresh_token    = data.get("refresh_token", self.refresh_token)
            self.token_expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 3600))
            self.updated_tokens   = {
                "access_token":     self.access_token,
                "refresh_token":    self.refresh_token,
                "token_expires_at": self.token_expires_at,
            }
            # Persist immediately (own transaction) — do NOT wait for end of
            # request, or a later error would discard the rotated token.
            if self.on_refresh is not None:
                self.on_refresh(self.updated_tokens)

    def _headers(self) -> dict:
        self._ensure_fresh_token()
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Accept":        "application/json",
            "Content-Type":  "application/json",
        }

    def _get(self, path: str, params: Optional[dict] = None) -> dict:
        resp = httpx.get(
            f"{self._base_url()}{path}",
            headers=self._headers(),
            params=params,
            timeout=20,
        )
        self._last_intuit_tid = resp.headers.get("intuit_tid", "")
        if not resp.is_success:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise Exception(f"QBO {resp.status_code} (tid={self._last_intuit_tid}): {detail}")
        return resp.json()

    def _post(self, path: str, body: dict) -> dict:
        resp = httpx.post(
            f"{self._base_url()}{path}",
            headers=self._headers(),
            json=body,
            timeout=20,
        )
        self._last_intuit_tid = resp.headers.get("intuit_tid", "")
        if not resp.is_success:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise Exception(f"QBO {resp.status_code} (tid={self._last_intuit_tid}): {detail}")
        return resp.json()

    # ── Query ─────────────────────────────────────────────────────────────────

    def _query(self, sql: str) -> list:
        result = self._get("/query", {"query": sql, "minorversion": "65"})
        qr = result.get("QueryResponse", {})
        for key, val in qr.items():
            if isinstance(val, list):
                return val
        return []

    # ── Accounts ──────────────────────────────────────────────────────────────

    def get_active_accounts(self) -> list[dict]:
        """Fetch all active accounts. Handles pagination (max 1000 per page)."""
        accounts: list[dict] = []
        start = 1
        while True:
            batch = self._query(
                f"SELECT * FROM Account WHERE Active = true STARTPOSITION {start} MAXRESULTS 1000"
            )
            accounts.extend(batch)
            if len(batch) < 1000:
                break
            start += 1000
        return accounts

    def build_account_map(self) -> dict[str, str]:
        """
        Return {account_display_name: QBO_Id} for all active accounts.

        Indexed by both FullyQualifiedName (e.g. "Cash:Mercury Checking (9882) - 1")
        and Name (e.g. "Mercury Checking (9882) - 1") so lookups work for both
        top-level and sub-accounts.
        """
        return self.build_account_lookup()[0]

    def build_account_lookup(self) -> tuple[dict[str, str], dict[str, str]]:
        """
        Return ({display_name: id}, {id: AccountType}). The type map is needed
        when deciding whether an account is valid as a Purchase's payment
        account (must be Bank or CreditCard) — substring-matching the name is
        unreliable (e.g. "Credit Card Rewards" is an Income account, not a
        credit card payment account).
        """
        accounts = self.get_active_accounts()
        name_to_id: dict[str, str]   = {}
        id_to_type: dict[str, str]   = {}
        for acc in accounts:
            acc_id = acc.get("Id", "")
            fqn    = acc.get("FullyQualifiedName", "")
            name   = acc.get("Name", "")
            acc_type = acc.get("AccountType", "")
            if acc_id:
                id_to_type[acc_id] = acc_type
            if fqn:
                name_to_id[fqn] = acc_id
                name_to_id[fqn.lower()] = acc_id
            if name and name not in name_to_id:
                name_to_id[name] = acc_id
                if name.lower() not in name_to_id:
                    name_to_id[name.lower()] = acc_id
        return name_to_id, id_to_type

    def get_coa_names(self) -> list[str]:
        """
        Return sorted, deduplicated list of all active account names.
        Includes both FullyQualifiedName (e.g. "Expenses:Amortization Expense")
        AND the short Name (e.g. "Amortization Expense") so users can find
        accounts by either form.

        Parent/header accounts ARE included — QBO permits journal entries
        posted to parent accounts (unlike Bills/Invoices/etc), so excluding
        them here would block legitimate JEs.
        """
        accounts = self.get_active_accounts()
        seen: set[str] = set()
        names: list[str] = []
        for acc in accounts:
            fqn  = acc.get("FullyQualifiedName", "").strip()
            name = acc.get("Name", "").strip()
            for n in (fqn, name):
                if n and n not in seen:
                    seen.add(n)
                    names.append(n)
        return sorted(names)

    # ── Vendors ───────────────────────────────────────────────────────────────

    def find_vendor(self, display_name: str) -> Optional[str]:
        """Return QBO vendor Id by DisplayName, or None if not found."""
        safe    = display_name.replace("'", "\\'")
        results = self._query(f"SELECT * FROM Vendor WHERE DisplayName = '{safe}'")
        return results[0]["Id"] if results else None

    def create_vendor(self, display_name: str) -> str:
        """Create a new vendor in QBO and return its Id."""
        result = self._post("/vendor?minorversion=65", {"DisplayName": display_name})
        return result["Vendor"]["Id"]

    def get_or_create_vendor(self, display_name: str) -> tuple[str, bool]:
        """
        Return (vendor_id, was_created).
        Looks up by DisplayName; creates in QBO if not found.
        """
        vendor_id = self.find_vendor(display_name)
        if vendor_id:
            return vendor_id, False
        return self.create_vendor(display_name), True

    # ── Customers ─────────────────────────────────────────────────────────────

    def get_active_customers(self) -> list[dict]:
        """Fetch all active customers. Handles pagination (max 1000 per page)."""
        customers: list[dict] = []
        start = 1
        while True:
            batch = self._query(
                f"SELECT * FROM Customer WHERE Active = true STARTPOSITION {start} MAXRESULTS 1000"
            )
            customers.extend(batch)
            if len(batch) < 1000:
                break
            start += 1000
        return customers

    def get_customer_names(self) -> list[str]:
        """Return sorted, deduplicated list of active customer DisplayNames."""
        seen: set[str] = set()
        names: list[str] = []
        for c in self.get_active_customers():
            n = (c.get("DisplayName") or "").strip()
            if n and n not in seen:
                seen.add(n)
                names.append(n)
        return sorted(names)

    def find_customer(self, display_name: str) -> Optional[str]:
        """Return QBO customer Id by DisplayName, or None if not found."""
        safe    = display_name.replace("'", "\\'")
        results = self._query(f"SELECT * FROM Customer WHERE DisplayName = '{safe}'")
        return results[0]["Id"] if results else None

    def create_customer(self, display_name: str) -> str:
        """Create a new customer in QBO and return its Id."""
        result = self._post("/customer?minorversion=65", {"DisplayName": display_name})
        return result["Customer"]["Id"]

    def get_or_create_customer(self, display_name: str) -> tuple[str, bool]:
        """
        Return (customer_id, was_created).
        Looks up by DisplayName; creates in QBO if not found.
        """
        customer_id = self.find_customer(display_name)
        if customer_id:
            return customer_id, False
        return self.create_customer(display_name), True

    def get_or_create_account(
        self,
        name: str,
        account_type: str,
        account_sub_type: str,
        parent_fqn: str = "",
    ) -> tuple[str, bool]:
        """
        Return (account_id, was_created).
        Looks up by Name; creates in QBO if not found.
        """
        accounts = self.get_active_accounts()
        for acc in accounts:
            if acc.get("Name", "") == name or acc.get("FullyQualifiedName", "") == name:
                return acc["Id"], False
        payload: dict = {
            "Name": name,
            "AccountType": account_type,
            "AccountSubType": account_sub_type,
        }
        result = self._post("/account?minorversion=65", payload)
        return result["Account"]["Id"], True

    def delete_object(self, object_type: str, qbo_id: str):
        """Delete a Purchase or JournalEntry from QBO by fetching its SyncToken first."""
        path = f"/{object_type.lower()}/{qbo_id}"
        try:
            data = self._get(path)
            obj = data.get(object_type, {})
            sync_token = obj.get("SyncToken", "0")
            self._post(
                f"/{object_type.lower()}?operation=delete",
                {"Id": qbo_id, "SyncToken": sync_token},
            )
        except Exception:
            pass  # already deleted or not found — ignore

    # ── Journal Entries ───────────────────────────────────────────────────────

    def create_journal_entry(
        self,
        doc_number: str,
        txn_date: str,
        memo: str,
        debit_account_id: str,
        credit_account_id: str,
        amount: float,
        vendor_id: str = "",
        vendor_name: str = "",
        customer_id: str = "",
        customer_name: str = "",
        customer_line: str = "credit",
    ) -> str:
        """
        Create a balanced two-line journal entry in QBO.

        A Vendor entity (if given) is attached to the debit line. A Customer
        entity (if given) is attached to the line(s) named by `customer_line`
        ("debit", "credit", or "both").

        QBO REQUIRES a customer on any line posting to an Accounts Receivable
        account, so the caller must place the customer on whichever side is A/R.
        For a plain income deposit (DR Bank / CR Income) the customer goes on the
        credit line so it shows in QBO's "by Customer" income reports; for an A/R
        entry (DR A/R / CR Income) it must go on the debit line ("both" also tags
        the income line for reporting).

        Returns the QBO-assigned JournalEntry Id.
        """
        def _line(line_id: str, posting_type: str, account_id: str, entity: Optional[dict] = None) -> dict:
            detail: dict = {
                "PostingType": posting_type,
                "AccountRef":  {"value": account_id},
            }
            if entity:
                detail["Entity"] = entity
            return {
                "Id":          line_id,
                "Amount":      round(abs(amount), 2),
                "DetailType":  "JournalEntryLineDetail",
                "Description": memo or "",
                "JournalEntryLineDetail": detail,
            }

        vendor_entity = (
            {"Type": "Vendor", "EntityRef": {"value": vendor_id, "name": vendor_name}}
            if vendor_id else None
        )
        customer_entity = (
            {"Type": "Customer", "EntityRef": {"value": customer_id, "name": customer_name}}
            if customer_id else None
        )
        debit_customer  = customer_entity if customer_line in ("debit", "both") else None
        credit_customer = customer_entity if customer_line in ("credit", "both") else None
        # A customer on the debit line takes precedence over a vendor there (only
        # relevant for A/R lines, which never legitimately carry a vendor).
        debit_entity  = debit_customer or vendor_entity
        credit_entity = credit_customer

        payload = {
            "DocNumber":   doc_number,
            "TxnDate":     txn_date,
            "PrivateNote": memo,
            "Line": [
                _line("0", "Debit",  debit_account_id,  entity=debit_entity),
                _line("1", "Credit", credit_account_id, entity=credit_entity),
            ],
        }
        result = self._post("/journalentry?minorversion=65", payload)
        return result["JournalEntry"]["Id"]

    def create_purchase(
        self,
        doc_number: str,
        txn_date: str,
        memo: str,
        payment_account_id: str,
        expense_account_id: str,
        amount: float,
        vendor_id: str,
        vendor_name: str,
        payment_type: str = "Cash",
    ) -> str:
        """
        Create a Purchase (Expense) transaction in QBO.
        Use this for vendor expenses paid from a bank or credit card account —
        vendor names will appear in QBO reports.
        Returns the QBO-assigned Purchase Id.
        """
        payload = {
            "DocNumber":  doc_number,
            "TxnDate":    txn_date,
            "PrivateNote": memo,
            "PaymentType": payment_type,
            "AccountRef":  {"value": payment_account_id},
            "EntityRef":   {"value": vendor_id, "name": vendor_name},
            "Line": [
                {
                    "Amount":     round(abs(amount), 2),
                    "DetailType": "AccountBasedExpenseLineDetail",
                    "Description": memo or "",
                    "AccountBasedExpenseLineDetail": {
                        "AccountRef": {"value": expense_account_id},
                    },
                }
            ],
        }
        result = self._post("/purchase?minorversion=65", payload)
        return result["Purchase"]["Id"]
