"""
Deterministic journal-entry builders for Stripe revenue (source="stripe").

Mirrors interest_accrual.py: pure functions that return lists of two-legged JE
dicts (keys map directly onto models.JournalEntry columns), keyed off a single
per-client StripeConfig row so all behavior is data-driven — no per-client code.

Accounting (per-charge, GAAP gross + fees broken out) for gross G, fee F, net N:

    JE1:  DR Stripe Clearing  G  /  CR Revenue  G     (customer on the revenue line)
    JE2:  DR Stripe Fees      F  /  CR Stripe Clearing  F     (only when F > 0)

Revenue is credited gross once (clean per-customer income line), fees are
expensed, and Stripe Clearing is left holding +N — the amount that will later be
paid out to the bank. The Stripe payout deposit (imported by Mercury) is coded
DR Bank / CR Stripe Clearing (see build_stripe_payout_jes), so Clearing nets to
zero over time. This module owns the clearing-account name for BOTH sides, so
they can never drift apart.

The "net" treatment and "per_payout" granularity are config switches handled
here — onboarding a differently-configured client needs no new code.
"""
import json
from datetime import datetime
from types import SimpleNamespace

import models

# Fallbacks used only when a client's config leaves a field blank.
DEFAULT_CLEARING = "Stripe Clearing"
DEFAULT_BANK = "Mercury Checking"

_DEFAULTS = dict(
    enabled=False,
    api_key=None,
    treatment="gross_plus_fees",
    granularity="per_charge",
    recognition_timing="charge_date",
    attribute_customer=True,
    revenue_account=None,
    stripe_fees_account=None,
    stripe_clearing_account=DEFAULT_CLEARING,
    dispute_fees_account=None,
    bank_account=None,
    payout_match_text="stripe",
)


def load_stripe_config(client_id: int, db):
    """Return the client's StripeConfig row, or a disabled defaults object so
    callers never crash on a missing row."""
    cfg = (
        db.query(models.StripeConfig)
        .filter(models.StripeConfig.client_id == client_id)
        .first()
    )
    return cfg if cfg else SimpleNamespace(client_id=client_id, **_DEFAULTS)


# ── Predicates ───────────────────────────────────────────────────────────────

def is_stripe_coding_txn(txn) -> bool:
    """True for any Stripe-sourced transaction the /stripe/code path owns."""
    return (getattr(txn, "source", None) == "stripe")


def is_stripe_payout(txn, cfg) -> bool:
    """True for a Mercury bank deposit that is a Stripe payout, per the client's
    payout_match_text. Codes to the Stripe Clearing account."""
    if getattr(txn, "source", None) not in (None, "mercury"):
        return False
    if (txn.amount or 0) <= 0:
        return False
    needle = (getattr(cfg, "payout_match_text", None) or "stripe").lower()
    haystacks = (
        txn.description or "",
        getattr(txn, "counterparty_name", "") or "",
    )
    return any(needle in h.lower() for h in haystacks)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _raw(txn) -> dict:
    try:
        return json.loads(txn.raw_data or "{}")
    except Exception:
        return {}


def _je_date(txn, cfg, data: dict) -> datetime:
    if getattr(cfg, "recognition_timing", "charge_date") == "available_on":
        iso = data.get("available_on")
        if iso:
            try:
                return datetime.fromisoformat(iso)
            except ValueError:
                pass
    return txn.date or datetime.utcnow()


def _customer(txn, cfg):
    return txn.counterparty_name if getattr(cfg, "attribute_customer", True) else None


def _je(debit, credit, amount, date, memo, customer=None, reasoning=""):
    return {
        "debit_account": debit,
        "credit_account": credit,
        "amount": round(float(amount), 2),
        "je_date": date,
        "memo": memo[:255] if memo else None,
        "description": memo[:255] if memo else None,
        "customer_name": customer,
        "ai_confidence": 1.0,
        "ai_reasoning": reasoning,
    }


# ── Builders ─────────────────────────────────────────────────────────────────

def build_stripe_charge_jes(txn, cfg) -> list[dict]:
    data = _raw(txn)
    gross = abs(txn.amount or 0)
    fee = float(data.get("fee") or 0.0)
    net = float(data.get("net") if data.get("net") is not None else (gross - fee))
    customer = _customer(txn, cfg)
    date = _je_date(txn, cfg, data)
    rev = cfg.revenue_account
    clearing = cfg.stripe_clearing_account or DEFAULT_CLEARING
    label = f"Stripe revenue - {customer}" if customer else "Stripe revenue"

    if getattr(cfg, "treatment", "gross_plus_fees") == "net":
        return [_je(
            clearing, rev, net, date, label, customer,
            "Stripe charge (net treatment): DR Stripe Clearing / CR Revenue at net of fees.",
        )]

    jes = [_je(
        clearing, rev, gross, date, label, customer,
        f"Stripe charge: DR Stripe Clearing / CR Revenue at gross ${gross:.2f}; "
        f"fee ${fee:.2f} expensed separately.",
    )]
    if fee > 0 and cfg.stripe_fees_account:
        jes.append(_je(
            cfg.stripe_fees_account, clearing, fee, date,
            "Stripe processing fee",
            None,
            "Stripe processing fee: DR Stripe Fees / CR Stripe Clearing.",
        ))
    return jes


def build_stripe_refund_jes(txn, cfg) -> list[dict]:
    data = _raw(txn)
    gross = abs(txn.amount or 0)
    customer = _customer(txn, cfg)
    date = txn.date or datetime.utcnow()
    clearing = cfg.stripe_clearing_account or DEFAULT_CLEARING
    # Reverse the revenue and reduce clearing. Stripe does not return the
    # processing fee on a refund, so the fee stays expensed (correct).
    return [_je(
        cfg.revenue_account, clearing, gross, date,
        f"Stripe refund - {customer}" if customer else "Stripe refund",
        customer,
        "Stripe refund: DR Revenue / CR Stripe Clearing (fee not returned by Stripe).",
    )]


def build_stripe_dispute_jes(txn, cfg) -> list[dict]:
    data = _raw(txn)
    gross = abs(txn.amount or 0)
    fee = float(data.get("fee") or 0.0)
    customer = _customer(txn, cfg)
    date = txn.date or datetime.utcnow()
    clearing = cfg.stripe_clearing_account or DEFAULT_CLEARING
    jes = [_je(
        cfg.revenue_account, clearing, gross, date,
        f"Stripe dispute - {customer}" if customer else "Stripe dispute",
        customer,
        "Stripe chargeback: DR Revenue / CR Stripe Clearing.",
    )]
    dispute_fees = cfg.dispute_fees_account or cfg.stripe_fees_account
    if fee > 0 and dispute_fees:
        jes.append(_je(
            dispute_fees, clearing, fee, date,
            "Stripe dispute fee", None,
            "Stripe dispute fee: DR Dispute Fees / CR Stripe Clearing.",
        ))
    return jes


def build_stripe_payout_summary_jes(txn, cfg) -> list[dict]:
    """per_payout granularity: one summarized entry per payout."""
    data = _raw(txn)
    gross = abs(txn.amount or 0)
    fee = float(data.get("fee") or 0.0)
    net = float(data.get("net") if data.get("net") is not None else (gross - fee))
    date = txn.date or datetime.utcnow()
    rev = cfg.revenue_account
    clearing = cfg.stripe_clearing_account or DEFAULT_CLEARING
    n = data.get("charge_count")
    label = f"Stripe payout revenue{f' ({n} charges)' if n else ''}"

    if getattr(cfg, "treatment", "gross_plus_fees") == "net":
        return [_je(clearing, rev, net, date, label, None,
                    "Stripe payout (net treatment): DR Stripe Clearing / CR Revenue at net.")]
    jes = [_je(clearing, rev, gross, date, label, None,
               "Stripe payout: DR Stripe Clearing / CR Revenue at gross; fees expensed.")]
    if fee > 0 and cfg.stripe_fees_account:
        jes.append(_je(cfg.stripe_fees_account, clearing, fee, date,
                       "Stripe processing fees (payout)", None,
                       "Stripe fees for the payout: DR Stripe Fees / CR Stripe Clearing."))
    return jes


def build_jes_for_stripe_txn(txn, cfg) -> list[dict]:
    """Dispatch to the right builder by stripe_object_type."""
    t = getattr(txn, "stripe_object_type", None) or "charge"
    if t == "charge":
        return build_stripe_charge_jes(txn, cfg)
    if t == "refund":
        return build_stripe_refund_jes(txn, cfg)
    if t == "dispute":
        return build_stripe_dispute_jes(txn, cfg)
    if t == "payout_summary":
        return build_stripe_payout_summary_jes(txn, cfg)
    return []


def build_stripe_payout_jes(txn, cfg) -> list[dict]:
    """Code a Mercury-imported Stripe payout deposit: DR Bank / CR Stripe Clearing.

    Runs as a deterministic pre-pass in the Mercury coding path (see
    routers/mercury.py), reusing the SAME clearing account the charge side
    credited so the account nets to zero.
    """
    amount = abs(txn.amount or 0)
    bank = cfg.bank_account or getattr(txn, "mercury_account_name", None) or DEFAULT_BANK
    clearing = cfg.stripe_clearing_account or DEFAULT_CLEARING
    return [_je(
        bank, clearing, amount, txn.date or datetime.utcnow(),
        "Stripe payout", None,
        "Stripe payout to bank: DR Bank / CR Stripe Clearing — clears the "
        "clearing balance built up by the coded Stripe charges.",
    )]
