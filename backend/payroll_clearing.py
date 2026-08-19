"""
Deterministic coding for Rippling / PEOPLE CENTER debits pulled from Mercury.

Rippling's own QBO integration already books payroll expense and the matching
payroll liability. The Mercury bank debits below are only the *cash* settling
that liability, so coding them as fresh expenses double-books payroll. They
clear the liability instead:

  Rippling employer tax contribution  DR Payroll Liabilities - Rippling / CR bank
  PEOPLE CENTER PEO benefits fees     DR Payroll Liabilities - Rippling / CR bank
  PEOPLE CENTER benefits contribution DR Employee benefits             / CR bank
  PEOPLE CENTER software fee          DR Software Subscriptions        / CR bank

Account names below are the live QBO chart's own spellings ("Employee benefits"
with a lower-case b, "Software Subscriptions" with no ampersand); they still go
through canonical_account so a rename in QBO is picked up rather than silently
posting to a stale name.

Every entry carries CLEARING_NOTE and lands in the Review Queue unapproved —
nothing here can reach QBO without a human approving it, because the duplicate
check against the Rippling→QBO integration can only be done by a person.

Two exclusions matter, both drawn from the live Mercury data:

  - The full payroll runs (Mercury describes them "RIPPLING PAYMENT; GLOBAL_PAY",
    $9.6k-$18k) are already handled and must not be touched. They are excluded
    by amount and, belt-and-braces, by the GLOBAL_PAY descriptor itself, so a
    payroll run that happens to fall under the amount ceiling is still skipped.
  - Mercury's API reports no distinct "ACH Pull" kind for these — `kind` comes
    back None or "other" — so the pull is identified by direction (a debit)
    rather than by kind. Gating on kind would match nothing.

This fires ahead of the general rules engine / AI coder and takes priority for
these transactions — see the pre-pass loops in routers/mercury.py. In
particular it pre-empts the GLOBAL_PAY / PEO_* / HSACONTRBT / Payroll-category
reject rules, which would otherwise drop these debits from the review queue.
"""
from datetime import datetime
from typing import Optional

from interest_accrual import canonical_account

PAYROLL_LIABILITIES    = "Payroll wages and tax to pay:Payroll Liabilities - Rippling"
EMPLOYEE_BENEFITS      = "Employee benefits"
SOFTWARE_SUBSCRIPTIONS = "Software Subscriptions"
# Fallback only — normally we credit the transaction's own Mercury account.
DEFAULT_BANK_ACCOUNT   = "Mercury Checking (9882) - 1"

# Applies to transactions dated on or after this date only. Everything earlier
# is already in the system coded (or rejected) the old way; re-running a sync or
# a re-code must not restate it.
EFFECTIVE_FROM = datetime(2026, 8, 1)

# Rippling debits above this are the full payroll runs, already handled.
LARGE_PAYROLL_FLOOR = 5000.0
# PEO benefits fees arrive in this band (observed: $4,586.74/month).
PEO_FEE_MIN, PEO_FEE_MAX = 4000.0, 5000.0
# The two small monthly PEO charges: a ~$9.00 software fee and a ~$48.33
# benefits contribution. Mercury names them in the description, so the
# descriptor decides; the amounts only break a tie when neither name is
# present, split at a threshold that sits well clear of both.
PEO_SMALL_MAX    = 100.0
PEO_SOFTWARE_MAX = 25.0

# Mercury's descriptor for a full payroll run — never a liability-clearing debit.
_PAYROLL_RUN_MARKER = "global_pay"
# Descriptors on the two small charges: PEO_WORKER (workers' comp) and
# PEO_EPLI_A (the Rippling software fee).
_PEO_BENEFITS_MARKER = "peo_worker"
_PEO_SOFTWARE_MARKER = "peo_epli"

CLEARING_NOTE = (
    "Rippling liability clearing entry — verify against Rippling→QBO "
    "integration to confirm no duplicate exists in QBO before approving"
)

# kind -> (debit account, memo label)
_TREATMENTS = {
    "rippling_tax": (PAYROLL_LIABILITIES,    "Rippling employer tax contribution"),
    "peo_fees":     (PAYROLL_LIABILITIES,    "People Center PEO benefits fees"),
    "peo_benefits": (EMPLOYEE_BENEFITS,      "People Center benefits contribution"),
    "peo_software": (SOFTWARE_SUBSCRIPTIONS, "Rippling software fee"),
}


def classify(txn) -> Optional[str]:
    """
    Which treatment this transaction takes, or None to leave it to the normal
    rules engine / AI coder.

    Returns one of _TREATMENTS' keys. Amounts outside the bands below are
    deliberately *not* claimed — an unrecognized Rippling or PEOPLE CENTER
    amount falls through to existing handling rather than being guessed at.
    """
    if (getattr(txn, "source", None) or "mercury") != "mercury":
        return None
    if (txn.amount or 0) >= 0:            # an ACH pull is money out
        return None
    if (txn.date or datetime.utcnow()) < EFFECTIVE_FROM:
        return None                       # pre-existing transaction — leave alone

    desc = (txn.description or "").lower()
    amount = abs(txn.amount or 0)

    if _PAYROLL_RUN_MARKER in desc:       # full payroll run — already handled
        return None

    if "rippling" in desc:
        if amount > LARGE_PAYROLL_FLOOR:  # large payroll run — already handled
            return None
        return "rippling_tax"

    if "people center" in desc:
        if amount <= PEO_SMALL_MAX:
            if _PEO_BENEFITS_MARKER in desc:
                return "peo_benefits"
            if _PEO_SOFTWARE_MARKER in desc:
                return "peo_software"
            # Unnamed small charge — fall back to the amount.
            return "peo_software" if amount <= PEO_SOFTWARE_MAX else "peo_benefits"
        if PEO_FEE_MIN <= amount <= PEO_FEE_MAX:
            return "peo_fees"
        return None                       # outside both bands — not ours to code

    return None


def resolve_bank_account(txn, coa_names=None) -> str:
    """The chart's name for the Mercury account the pull came out of."""
    raw = getattr(txn, "mercury_account_name", None) or DEFAULT_BANK_ACCOUNT
    return canonical_account(raw, coa_names)


def build_payroll_clearing_jes(txn, coa_names=None) -> list[dict]:
    """
    Return the single clearing journal entry for a Rippling / PEOPLE CENTER
    debit, as a one-item list so the caller loops over it exactly like the other
    deterministic pre-passes.

    Returns [] when classify() doesn't claim the transaction.

    Keys map directly onto models.JournalEntry columns. approved_by /
    approved_at are deliberately absent: the entry must sit in the Review Queue
    until a person approves it.
    """
    treatment = classify(txn)
    if treatment is None:
        return []

    debit_raw, label = _TREATMENTS[treatment]
    txn_date = txn.date or datetime.utcnow()
    period   = txn_date.strftime("%B %Y")               # e.g. "August 2026"
    memo     = f"{label} - {period}"

    return [{
        "debit_account":  canonical_account(debit_raw, coa_names),
        "credit_account": resolve_bank_account(txn, coa_names),
        "amount":         abs(txn.amount or 0),
        "je_date":        txn_date,
        "memo":           memo,
        "description":    memo,
        "customer_name":  None,
        "ai_confidence":  1.0,
        "ai_reasoning":   CLEARING_NOTE,
    }]
