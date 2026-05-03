"""
Stripe API integration for revenue recognition.
Pulls invoices, subscriptions, charges, and refunds.
"""

from datetime import datetime
from typing import Optional


def _stripe(api_key: str):
    """Return a configured stripe module."""
    import stripe as _stripe_lib
    _stripe_lib.api_key = api_key
    return _stripe_lib


def get_invoices(api_key: str, limit: int = 100) -> list[dict]:
    """Fetch all invoices (paid + open) from Stripe."""
    s = _stripe(api_key)
    results = []
    params = {"limit": limit, "expand": ["data.subscription", "data.customer"]}
    invoices = s.Invoice.list(**params)
    for inv in invoices.auto_paging_iter():
        customer_name = ""
        if inv.get("customer_name"):
            customer_name = inv["customer_name"]
        elif inv.get("customer") and isinstance(inv["customer"], dict):
            customer_name = inv["customer"].get("name") or inv["customer"].get("email") or ""
        results.append({
            "external_id": inv["id"],
            "source": "stripe",
            "customer_name": customer_name,
            "invoice_number": inv.get("number") or inv["id"],
            "total_contract_value": inv["amount_due"] / 100.0,
            "amount_paid": inv.get("amount_paid", 0) / 100.0,
            "status": inv["status"],  # draft, open, paid, uncollectible, void
            "billing_date": datetime.fromtimestamp(inv["created"]) if inv.get("created") else None,
            "due_date": datetime.fromtimestamp(inv["due_date"]) if inv.get("due_date") else None,
            "payment_received": inv["status"] == "paid",
            "payment_date": datetime.fromtimestamp(inv["status_transitions"]["paid_at"])
                           if inv.get("status_transitions", {}).get("paid_at") else None,
            "period_start": datetime.fromtimestamp(inv["period_start"]) if inv.get("period_start") else None,
            "period_end": datetime.fromtimestamp(inv["period_end"]) if inv.get("period_end") else None,
            "subscription_id": inv.get("subscription") if isinstance(inv.get("subscription"), str) else None,
            "description": inv.get("description") or "",
            "raw": {
                "id": inv["id"],
                "status": inv["status"],
                "currency": inv.get("currency"),
                "amount_due": inv.get("amount_due"),
                "amount_paid": inv.get("amount_paid"),
                "lines": [{"description": li.get("description"), "amount": li.get("amount")} for li in inv.get("lines", {}).get("data", [])[:5]],
            },
        })
    return results


def get_subscriptions(api_key: str, limit: int = 100) -> list[dict]:
    """Fetch active subscriptions from Stripe."""
    s = _stripe(api_key)
    results = []
    for sub in s.Subscription.list(limit=limit, expand=["data.customer"]).auto_paging_iter():
        customer_name = ""
        if isinstance(sub.get("customer"), dict):
            customer_name = sub["customer"].get("name") or sub["customer"].get("email") or ""
        results.append({
            "external_id": sub["id"],
            "source": "stripe",
            "type": "subscription",
            "customer_name": customer_name,
            "status": sub["status"],  # active, canceled, trialing, etc.
            "billing_date": datetime.fromtimestamp(sub["current_period_start"]) if sub.get("current_period_start") else None,
            "period_start": datetime.fromtimestamp(sub["current_period_start"]) if sub.get("current_period_start") else None,
            "period_end": datetime.fromtimestamp(sub["current_period_end"]) if sub.get("current_period_end") else None,
            "amount": sum(item["price"]["unit_amount"] * item.get("quantity", 1) for item in sub.get("items", {}).get("data", []) if item.get("price", {}).get("unit_amount")) / 100.0,
            "interval": sub.get("items", {}).get("data", [{}])[0].get("price", {}).get("recurring", {}).get("interval", "month"),
        })
    return results
