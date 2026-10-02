"""
ASC 606 journal entries for subscription billings with a money-back guarantee.

This is the durable half of the Chargebee work: it knows nothing about where the
events came from, so swapping the synthetic feed in `chargebee_demo` for a real
Chargebee API changes nothing here.

The accounting
--------------
Cash arrives up front for a service delivered over time, so the billing is not
revenue — it is a liability. An annual Plus subscription collects $60 on day one
and earns $5 a month for twelve months.

The 7-day money-back guarantee makes part of that consideration *variable*
(ASC 606-10-32-10): the seller does not have an unconditional right to the
portion it expects to refund, so that slice is a refund liability rather than
deferred revenue. Three states follow:

  billing     DR Chargebee Clearing          60.00
              CR Deferred Revenue                      57.60   (1 - reserve)
              CR Refund Liability                       2.40   (reserve)

  window      DR Refund Liability             2.40             (day 8, unrefunded:
  closes      CR Deferred Revenue                       2.40    the right lapses)

  refunded    DR Refund Liability             2.40
              DR Deferred Revenue            57.60
              CR Chargebee Clearing                    60.00

Renewals carry no guarantee — SuperSummary's applies to first-time subscribers
only — so a renewal books the full amount to deferred revenue with no reserve.

Recognition itself (DR Deferred Revenue / CR Subscription Revenue, monthly) runs
off the RevenueScheduleEntry rows the revenue router already builds, so it is
not duplicated here.

Why the reserve matters even though the window is short: recognition happens at
month end, so a purchase on the 3rd has its guarantee lapse long before any
revenue is booked and the reserve is cosmetic. A purchase on the 28th does not —
its window spans month end, and without the reserve the first month's revenue is
recognized on money the subscriber can still claw back.
"""
from datetime import datetime, timedelta
from typing import Optional

# ── Chart of accounts ────────────────────────────────────────────────────────
# Free text, matching how the app handles any client without a live QBO chart.
# A real client would map these to their own account names.
CLEARING_ACCOUNT   = "Chargebee Clearing"
DEFERRED_ACCOUNT   = "Deferred Revenue - Subscriptions"
REFUND_LIABILITY   = "Refund Liability - Money-Back Guarantee"
PROCESSING_FEES    = "Payment Processing Fees"
BANK_ACCOUNT       = "Operating Bank"

REVENUE_ACCOUNTS = {
    "Plus":       "Subscription Revenue - Plus",
    "Essentials": "Subscription Revenue - Essentials",
}

# Share of first-time billings expected to be refunded under the guarantee.
# This is an accounting policy input, not a constant of nature: it should be set
# from the client's own refund history and revisited, since over-reserving
# understates revenue and under-reserving overstates it.
REFUND_RESERVE_RATE = 0.04

GUARANTEE_DAYS = 7

_NOTE = (
    "Auto-coded from Chargebee. Review before posting: subscription billings are "
    "deferred revenue, not revenue, and the money-back guarantee is reserved as "
    "variable consideration under ASC 606."
)


def _split_reserve(amount: float) -> tuple[float, float]:
    """Divide a first-time billing into (deferred, reserved).

    The reserve is derived by subtraction so the two halves always re-add to the
    cash collected — rounding each independently can leave the entry a cent out
    of balance.
    """
    reserved = round(amount * REFUND_RESERVE_RATE, 2)
    return round(amount - reserved, 2), reserved


def billing_jes(sub: dict) -> list[dict]:
    """Entries for one subscription billing (new or renewal)."""
    amount = round(float(sub["amount"]), 2)
    when = sub["billing_date"]
    label = f"{sub['plan_label']} - {sub['customer_name']}"
    memo = f"Chargebee billing - {label}"

    if not sub.get("guarantee_eligible"):
        return [{
            "debit_account": CLEARING_ACCOUNT,
            "credit_account": DEFERRED_ACCOUNT,
            "amount": amount,
            "je_date": when,
            "memo": f"Renewal billing - {label}",
            "description": memo,
            "customer_name": sub["customer_name"],
            "ai_confidence": 1.0,
            "ai_reasoning": (
                f"Renewal of {sub['plan_label']} billed {when:%Y-%m-%d}, "
                f"{sub['term_months']}-month service period. Renewals are outside the "
                f"first-time-subscriber money-back guarantee, so the full amount is "
                f"deferred with no refund reserve. {_NOTE}"
            ),
        }]

    deferred, reserved = _split_reserve(amount)
    expires = sub.get("guarantee_expires")
    reasoning_tail = (
        f"Guarantee lapses {expires:%Y-%m-%d}. {_NOTE}" if expires else _NOTE
    )
    return [
        {
            "debit_account": CLEARING_ACCOUNT,
            "credit_account": DEFERRED_ACCOUNT,
            "amount": deferred,
            "je_date": when,
            "memo": f"New billing - {label}",
            "description": memo,
            "customer_name": sub["customer_name"],
            "ai_confidence": 1.0,
            "ai_reasoning": (
                f"New {sub['plan_label']} billed {when:%Y-%m-%d}, {sub['term_months']}-month "
                f"service period, recognized monthly. Net of the "
                f"{REFUND_RESERVE_RATE:.0%} money-back reserve. {reasoning_tail}"
            ),
        },
        {
            "debit_account": CLEARING_ACCOUNT,
            "credit_account": REFUND_LIABILITY,
            "amount": reserved,
            "je_date": when,
            "memo": f"Refund reserve - {label}",
            "description": memo,
            "customer_name": sub["customer_name"],
            "ai_confidence": 1.0,
            "ai_reasoning": (
                f"{REFUND_RESERVE_RATE:.0%} of the billing held as a refund liability: the "
                f"7-day money-back guarantee makes this consideration variable, so it is "
                f"not an unconditional right to payment. {reasoning_tail}"
            ),
        },
    ]


def reserve_release_jes(sub: dict, as_of: Optional[datetime] = None) -> list[dict]:
    """Release the reserve once the guarantee window has closed unrefunded."""
    if not sub.get("guarantee_eligible"):
        return []
    expires = sub.get("guarantee_expires")
    if not expires:
        return []
    now = as_of or datetime.utcnow()
    if expires > now:
        return []                       # still claimable — the reserve stands

    _, reserved = _split_reserve(round(float(sub["amount"]), 2))
    if reserved <= 0:
        return []
    label = f"{sub['plan_label']} - {sub['customer_name']}"
    return [{
        "debit_account": REFUND_LIABILITY,
        "credit_account": DEFERRED_ACCOUNT,
        "amount": reserved,
        "je_date": expires,
        "memo": f"Guarantee lapsed - {label}",
        "description": f"Refund reserve released - {label}",
        "customer_name": sub["customer_name"],
        "ai_confidence": 1.0,
        "ai_reasoning": (
            f"7-day money-back window closed {expires:%Y-%m-%d} with no refund claimed, so "
            f"the right of return has lapsed and the reserved amount becomes deferred "
            f"revenue to be recognized over the remaining service period. {_NOTE}"
        ),
    }]


def refund_jes(refund: dict) -> list[dict]:
    """Entries for a guarantee refund, unwinding both halves of the billing."""
    amount = round(float(refund["amount"]), 2)
    deferred, reserved = _split_reserve(amount)
    when = refund["refund_date"]
    label = f"{refund['plan_label']} - {refund['customer_name']}"
    days = refund.get("days_after_purchase")
    reasoning = (
        f"Money-back guarantee refund {days} day(s) after purchase, inside the 7-day "
        f"window. Reverses the reserved portion against the refund liability and the "
        f"balance against deferred revenue; no revenue had been recognized. {_NOTE}"
    )
    out = [{
        "debit_account": REFUND_LIABILITY,
        "credit_account": CLEARING_ACCOUNT,
        "amount": reserved,
        "je_date": when,
        "memo": f"Refund (reserved) - {label}",
        "description": f"Chargebee refund - {label}",
        "customer_name": refund["customer_name"],
        "ai_confidence": 1.0,
        "ai_reasoning": reasoning,
    }]
    if deferred > 0:
        out.append({
            "debit_account": DEFERRED_ACCOUNT,
            "credit_account": CLEARING_ACCOUNT,
            "amount": deferred,
            "je_date": when,
            "memo": f"Refund (deferred) - {label}",
            "description": f"Chargebee refund - {label}",
            "customer_name": refund["customer_name"],
            "ai_confidence": 1.0,
            "ai_reasoning": reasoning,
        })
    return out


def processor_fee_je(gross: float, fee: float, when: datetime, txn_count: int) -> list[dict]:
    """Chargebee's cut on a batch of billings, expensed gross."""
    if fee <= 0:
        return []
    return [{
        "debit_account": PROCESSING_FEES,
        "credit_account": CLEARING_ACCOUNT,
        "amount": round(fee, 2),
        "je_date": when,
        "memo": f"Chargebee fees - {txn_count} txns",
        "description": f"Chargebee processing fees on ${gross:,.2f} across {txn_count} transactions",
        "customer_name": None,
        "ai_confidence": 1.0,
        "ai_reasoning": (
            "Processor fees are an operating expense, not a reduction of revenue: revenue "
            f"is recorded gross at the subscription price. {_NOTE}"
        ),
    }]


def payout_je(net: float, when: datetime) -> list[dict]:
    """Cash moving from the processor to the bank, clearing the holding account.

    Billings debit the clearing account; refunds, fees and this payout credit it,
    so a correctly coded batch leaves the clearing balance at zero. A non-zero
    balance is the signal that something in the batch is miscoded.
    """
    if abs(net) < 0.01:
        return []
    return [{
        "debit_account": BANK_ACCOUNT,
        "credit_account": CLEARING_ACCOUNT,
        "amount": round(abs(net), 2),
        "je_date": when,
        "memo": "Chargebee payout",
        "description": f"Chargebee payout to operating bank, ${abs(net):,.2f}",
        "customer_name": None,
        "ai_confidence": 1.0,
        "ai_reasoning": (
            "Net settlement of the batch (billings less refunds and processor fees). "
            f"Clears the holding account to zero. {_NOTE}"
        ),
    }]
