"""
QuickBooks Online API client.

Handles OAuth token management, account lookup, vendor lookup/creation,
and journal entry creation.
"""

import base64
import os
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlencode

import httpx

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
}

# Mercury API name normalization — same as frontend MERCURY_NAME_MAP
MERCURY_NAME_MAP: dict[str, str] = {
    "Mercury Checking ••9882": "Mercury Checking (9882) - 1",
    "Mercury Savings ••3117":  "Mercury Savings (3117) - 1",
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
    ):
        self.access_token     = access_token
        self.refresh_token    = refresh_token
        self.realm_id         = realm_id
        self.token_expires_at = token_expires_at
        self.updated_tokens: Optional[dict] = None
        self._last_intuit_tid: str = ""

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _base_url(self) -> str:
        _, _, _, sandbox = _cfg()
        host = "sandbox-quickbooks.api.intuit.com" if sandbox else "quickbooks.api.intuit.com"
        return f"https://{host}/v3/company/{self.realm_id}"

    def _ensure_fresh_token(self):
        if datetime.utcnow() >= self.token_expires_at - timedelta(minutes=5):
            data = refresh_tokens(self.refresh_token)
            self.access_token     = data["access_token"]
            self.refresh_token    = data.get("refresh_token", self.refresh_token)
            self.token_expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 3600))
            self.updated_tokens   = {
                "access_token":     self.access_token,
                "refresh_token":    self.refresh_token,
                "token_expires_at": self.token_expires_at,
            }

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
        accounts = self.get_active_accounts()
        m: dict[str, str] = {}
        for acc in accounts:
            acc_id = acc.get("Id", "")
            fqn    = acc.get("FullyQualifiedName", "")
            name   = acc.get("Name", "")
            if fqn:
                m[fqn] = acc_id
            if name and name not in m:
                m[name] = acc_id
        return m

    def get_coa_names(self) -> list[str]:
        """
        Return sorted, deduplicated list of account names.
        Includes both FullyQualifiedName (e.g. "Expenses:Amortization Expense")
        AND the short Name (e.g. "Amortization Expense") so users can find
        accounts by either form.
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
    ) -> str:
        """
        Create a balanced two-line journal entry in QBO.
        Returns the QBO-assigned JournalEntry Id.
        """
        def _line(line_id: str, posting_type: str, account_id: str, include_entity: bool = False) -> dict:
            detail: dict = {
                "PostingType": posting_type,
                "AccountRef":  {"value": account_id},
            }
            if include_entity and vendor_id:
                detail["Entity"] = {
                    "Type":      "Vendor",
                    "EntityRef": {"value": vendor_id, "name": vendor_name},
                }
            return {
                "Id":          line_id,
                "Amount":      round(abs(amount), 2),
                "DetailType":  "JournalEntryLineDetail",
                "Description": memo or "",
                "JournalEntryLineDetail": detail,
            }

        payload = {
            "DocNumber":   doc_number,
            "TxnDate":     txn_date,
            "PrivateNote": memo,
            "Line": [
                _line("0", "Debit",  debit_account_id,  include_entity=True),
                _line("1", "Credit", credit_account_id, include_entity=False),
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
