"""
Bill.com API integration for AR (invoices) and AP (bills).
Bill.com uses a session-based REST API (v2).
"""

from datetime import datetime
from typing import Optional
import httpx


BILLCOM_API_URL = "https://api.bill.com/api/v2"


class BillComClient:
    def __init__(self, username: str, password: str, org_id: str, dev_key: str):
        self.username = username
        self.password = password
        self.org_id = org_id
        self.dev_key = dev_key
        self.session_id: Optional[str] = None

    def _login(self):
        resp = httpx.post(
            f"{BILLCOM_API_URL}/Login.json",
            data={
                "devKey": self.dev_key,
                "userName": self.username,
                "password": self.password,
                "orgId": self.org_id,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("response_status") != 0:
            raise RuntimeError(f"Bill.com login failed: {data.get('response_message')}")
        self.session_id = data["response_data"]["sessionId"]

    def _get(self, endpoint: str, payload: dict = None) -> dict:
        if not self.session_id:
            self._login()
        resp = httpx.post(
            f"{BILLCOM_API_URL}/{endpoint}",
            data={
                "devKey": self.dev_key,
                "sessionId": self.session_id,
                **(payload or {}),
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("response_status") != 0:
            raise RuntimeError(f"Bill.com API error: {data.get('response_message')}")
        return data.get("response_data", {})

    def get_invoices(self) -> list[dict]:
        """Fetch AR invoices from Bill.com with customer name resolution."""
        import json as _json

        # Build customer ID → name map first
        try:
            customers_raw = self._get("List/Customer.json", {
                "data": _json.dumps({"start": 0, "max": 999, "filters": [], "sort": []})
            })
            customer_map = {
                c.get("id"): c.get("name") or c.get("printAs") or c.get("id")
                for c in (customers_raw if isinstance(customers_raw, list) else [])
                if c.get("id")
            }
        except Exception:
            customer_map = {}

        results = []
        start = 0
        while True:
            raw = self._get("List/Invoice.json", {
                "data": _json.dumps({
                    "start": start,
                    "max": 999,
                    "filters": [],
                    "sort": [{"field": "createdTime", "asc": False}],
                })
            })
            page = raw if isinstance(raw, list) else []
            for inv in page:
                customer_id = inv.get("customerId")
                customer_name = customer_map.get(customer_id) or customer_id or ""
                # amountDue=0 is the reliable paid signal; paymentStatus codes vary
                amount_due = inv.get("amountDue")
                is_paid = amount_due is not None and float(amount_due) == 0.0 and float(inv.get("amount") or 0) > 0
                results.append({
                    "external_id": inv.get("id"),
                    "source": "billcom",
                    "customer_name": customer_name,
                    "invoice_number": inv.get("invoiceNumber") or inv.get("id"),
                    "total_contract_value": float(inv.get("amount") or 0),
                    "billing_date": _parse_billcom_date(inv.get("invoiceDate")),
                    "due_date": _parse_billcom_date(inv.get("dueDate")),
                    "payment_received": is_paid,
                    "description": inv.get("description") or "",
                    "raw": inv,
                })
            if len(page) < 999:
                break
            start += 999
        return results

    def get_customers(self) -> list[dict]:
        """Fetch customer list from Bill.com."""
        import json
        raw = self._get("List/Customer.json", {
            "data": json.dumps({"start": 0, "max": 999, "filters": [], "sort": []})
        })
        return raw if isinstance(raw, list) else []

    def get_bills(self) -> list[dict]:
        """Fetch AP bills from Bill.com with pagination."""
        import json as _json
        results = []
        start = 0
        while True:
            raw = self._get("List/Bill.json", {
                "data": _json.dumps({
                    "start": start,
                    "max": 999,
                    "filters": [],
                    "sort": [{"field": "createdTime", "asc": False}],
                })
            })
            page = raw if isinstance(raw, list) else []
            for bill in page:
                results.append({
                    "external_id": bill.get("id"),
                    "vendor_id": bill.get("vendorId"),
                    "vendor_name": bill.get("vendorName") or bill.get("vendorId") or "Unknown Vendor",
                    "invoice_number": bill.get("invoiceNumber") or bill.get("id"),
                    "amount": float(bill.get("amount") or 0),
                    "amount_due": float(bill.get("amountDue") or 0),
                    "payment_status": bill.get("paymentStatus"),
                    "invoice_date": _parse_billcom_date(bill.get("invoiceDate")),
                    "due_date": _parse_billcom_date(bill.get("dueDate")),
                    "description": bill.get("description") or "",
                    # paymentStatus 4 = paid in Bill.com v2
                    "is_paid": bill.get("paymentStatus") in ("4", 4),
                    "raw": bill,
                })
            if len(page) < 999:
                break
            start += 999
        return results

    def get_vendors(self) -> list[dict]:
        """Fetch vendor list from Bill.com."""
        import json
        raw = self._get("List/Vendor.json", {
            "data": json.dumps({"start": 0, "max": 999, "filters": [], "sort": []})
        })
        return raw if isinstance(raw, list) else []


def _parse_billcom_date(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except Exception:
        return None


def get_billcom_invoices(username: str, password: str, org_id: str, dev_key: str) -> list[dict]:
    client = BillComClient(username, password, org_id, dev_key)
    return client.get_invoices()


def get_billcom_bills(username: str, password: str, org_id: str, dev_key: str) -> list[dict]:
    client = BillComClient(username, password, org_id, dev_key)
    return client.get_bills()
