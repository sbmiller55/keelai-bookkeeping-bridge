"""
Stripe API client for the *revenue coding* pipeline (source="stripe").

This is separate from stripe_client.py, which pulls invoices/subscriptions for
the revenue-recognition (RevenueContract) path. Here we pull the raw money
movements — Charges, Refunds, Disputes, and (for per-payout mode) Payouts — and
normalize them into the internal Transaction shape so they flow through the same
coding → Review Queue → QBO export pipeline as Mercury bank transactions.

Fees and net amounts are always read from the associated BalanceTransaction
(settlement currency, already FX-converted) — never computed client-side.
"""
import json
from datetime import datetime
from typing import Optional


# Currencies Stripe represents in whole units (no /100). Everything else is
# in the smallest unit (cents). See stripe.com/docs/currencies.
_ZERO_DECIMAL = {
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg",
    "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
}


def _stripe(api_key: str):
    """Return a configured stripe module (mirrors stripe_client._stripe)."""
    import stripe as _stripe_lib
    _stripe_lib.api_key = api_key
    return _stripe_lib


def _d(obj) -> dict:
    """Convert a Stripe resource object to a plain (recursive) dict.

    In stripe-python 15.x StripeObject is NOT a dict subclass and has no
    .get(); .to_dict() returns a recursively-plain dict we can treat normally.
    """
    return obj.to_dict() if hasattr(obj, "to_dict") else obj


def _major(amount: Optional[int], currency: str) -> float:
    """Convert a Stripe minor-unit integer to a major-unit float for the currency."""
    if amount is None:
        return 0.0
    if (currency or "").lower() in _ZERO_DECIMAL:
        return float(amount)
    return amount / 100.0


def _ts(epoch: Optional[int]) -> Optional[datetime]:
    return datetime.fromtimestamp(epoch) if epoch else None


def _customer_name(obj: dict) -> str:
    """Best-effort customer display name from an expanded charge/refund object."""
    cust = obj.get("customer")
    if isinstance(cust, dict):
        name = cust.get("name") or cust.get("email")
        if name:
            return name
    bd = obj.get("billing_details") or {}
    if bd.get("name"):
        return bd["name"]
    return obj.get("receipt_email") or ""


def _epoch_range(start: Optional[datetime], end: Optional[datetime]) -> dict:
    created: dict = {}
    if start:
        created["gte"] = int(start.timestamp())
    if end:
        created["lte"] = int(end.timestamp())
    return created


# ── Charges ────────────────────────────────────────────────────────────────

def get_charges(api_key: str, start: Optional[datetime], end: Optional[datetime]) -> list[dict]:
    """Fetch succeeded charges in the window, normalized. Fee/net come from the
    expanded balance transaction."""
    s = _stripe(api_key)
    params = {
        "limit": 100,
        "expand": ["data.balance_transaction", "data.customer"],
    }
    created = _epoch_range(start, end)
    if created:
        params["created"] = created

    out: list[dict] = []
    for charge in s.Charge.list(**params).auto_paging_iter():
        charge = _d(charge)
        if charge.get("status") != "succeeded" or not charge.get("paid"):
            continue
        norm = normalize_charge(charge)
        if norm:
            out.append(norm)
    return out


def normalize_charge(charge: dict) -> Optional[dict]:
    currency = charge.get("currency") or "usd"
    bt = charge.get("balance_transaction")
    if isinstance(bt, dict):
        gross = _major(bt.get("amount"), bt.get("currency") or currency)
        fee = _major(bt.get("fee"), bt.get("currency") or currency)
        net = _major(bt.get("net"), bt.get("currency") or currency)
        available_on = _ts(bt.get("available_on"))
        bt_id = bt.get("id")
    else:
        # No settled balance transaction yet — fall back to the charge amount,
        # no fee data. (Rare for succeeded/paid charges.)
        gross = _major(charge.get("amount"), currency)
        fee = 0.0
        net = gross
        available_on = None
        bt_id = None

    if gross <= 0:
        return None

    customer = _customer_name(charge)
    description = (
        charge.get("description")
        or charge.get("statement_descriptor")
        or (f"Stripe charge — {customer}" if customer else "Stripe charge")
    )
    raw = {
        "gross": gross,
        "fee": fee,
        "net": net,
        "currency": currency,
        "available_on": available_on.isoformat() if available_on else None,
        "balance_transaction_id": bt_id,
        "stripe_customer_id": charge.get("customer", {}).get("id")
            if isinstance(charge.get("customer"), dict) else charge.get("customer"),
    }
    return {
        "stripe_charge_id": charge["id"],
        "stripe_object_type": "charge",
        "date": _ts(charge.get("created")),
        "description": description[:255],
        "amount": gross,                 # gross, positive
        "counterparty_name": customer or None,
        "raw_data": json.dumps(raw, default=str),
    }


# ── Refunds ──────────────────────────────────────────────────────────────────

def get_refunds(api_key: str, start: Optional[datetime], end: Optional[datetime]) -> list[dict]:
    s = _stripe(api_key)
    params = {"limit": 100, "expand": ["data.charge.customer"]}
    created = _epoch_range(start, end)
    if created:
        params["created"] = created

    out: list[dict] = []
    for refund in s.Refund.list(**params).auto_paging_iter():
        refund = _d(refund)
        if refund.get("status") not in (None, "succeeded"):
            continue
        norm = normalize_refund(refund)
        if norm:
            out.append(norm)
    return out


def normalize_refund(refund: dict) -> Optional[dict]:
    charge = refund.get("charge") if isinstance(refund.get("charge"), dict) else {}
    currency = refund.get("currency") or (charge.get("currency") if charge else None) or "usd"
    gross = _major(refund.get("amount"), currency)
    if gross <= 0:
        return None
    customer = _customer_name(charge) if charge else ""
    raw = {
        "gross": gross,
        "currency": currency,
        "charge_id": charge.get("id") if charge else refund.get("charge"),
    }
    return {
        "stripe_charge_id": refund["id"],       # "re_..."
        "stripe_object_type": "refund",
        "date": _ts(refund.get("created")),
        "description": (f"Stripe refund — {customer}" if customer else "Stripe refund")[:255],
        "amount": gross,
        "counterparty_name": customer or None,
        "raw_data": json.dumps(raw, default=str),
    }


# ── Disputes / chargebacks ───────────────────────────────────────────────────

def get_disputes(api_key: str, start: Optional[datetime], end: Optional[datetime]) -> list[dict]:
    s = _stripe(api_key)
    params = {"limit": 100, "expand": ["data.charge.customer"]}
    created = _epoch_range(start, end)
    if created:
        params["created"] = created

    out: list[dict] = []
    for dispute in s.Dispute.list(**params).auto_paging_iter():
        norm = normalize_dispute(_d(dispute))
        if norm:
            out.append(norm)
    return out


def normalize_dispute(dispute: dict) -> Optional[dict]:
    charge = dispute.get("charge") if isinstance(dispute.get("charge"), dict) else {}
    currency = dispute.get("currency") or "usd"
    gross = _major(dispute.get("amount"), currency)
    if gross <= 0:
        return None
    # The dispute fee is carried on the balance transaction(s) attached to the dispute.
    fee = 0.0
    for bt in (dispute.get("balance_transactions") or []):
        if isinstance(bt, dict) and bt.get("fee"):
            fee += abs(_major(bt.get("fee"), bt.get("currency") or currency))
    customer = _customer_name(charge) if charge else ""
    raw = {
        "gross": gross,
        "fee": fee,
        "currency": currency,
        "charge_id": charge.get("id") if charge else dispute.get("charge"),
    }
    return {
        "stripe_charge_id": dispute["id"],      # "dp_..."
        "stripe_object_type": "dispute",
        "date": _ts(dispute.get("created")),
        "description": (f"Stripe dispute — {customer}" if customer else "Stripe dispute")[:255],
        "amount": gross,
        "counterparty_name": customer or None,
        "raw_data": json.dumps(raw, default=str),
    }


# ── Payout summaries (per_payout granularity) ────────────────────────────────

def get_payout_summaries(api_key: str, start: Optional[datetime], end: Optional[datetime]) -> list[dict]:
    """One normalized summary row per payout, aggregating the charges it settled.

    Used only when granularity="per_payout". Sums gross/fee/net across the
    payout's charge-type balance transactions.
    """
    s = _stripe(api_key)
    params = {"limit": 100}
    created = _epoch_range(start, end)
    if created:
        params["created"] = created

    out: list[dict] = []
    for payout in s.Payout.list(**params).auto_paging_iter():
        payout = _d(payout)
        if payout.get("status") == "failed":
            continue
        currency = payout.get("currency") or "usd"
        gross = fee = net = 0.0
        charge_count = 0
        for bt in s.BalanceTransaction.list(
            payout=payout["id"], limit=100
        ).auto_paging_iter():
            bt = _d(bt)
            if bt.get("type") == "charge":
                gross += _major(bt.get("amount"), bt.get("currency") or currency)
                fee += _major(bt.get("fee"), bt.get("currency") or currency)
                net += _major(bt.get("net"), bt.get("currency") or currency)
                charge_count += 1
        if charge_count == 0:
            continue
        raw = {"gross": gross, "fee": fee, "net": net, "currency": currency,
               "charge_count": charge_count}
        out.append({
            "stripe_charge_id": payout["id"],   # "po_..."
            "stripe_object_type": "payout_summary",
            "date": _ts(payout.get("arrival_date") or payout.get("created")),
            "description": f"Stripe payout — {charge_count} charge(s)"[:255],
            "amount": gross,
            "counterparty_name": None,
            "raw_data": json.dumps(raw, default=str),
        })
    return out


def test_connection(api_key: str) -> dict:
    """Cheap read to verify the key works and has charge access."""
    s = _stripe(api_key)
    charges = s.Charge.list(limit=1)
    return {"ok": True, "has_charges": len(charges.data) > 0}
