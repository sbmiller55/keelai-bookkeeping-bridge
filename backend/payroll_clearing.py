"""
Deterministic coding for Rippling / PEOPLE CENTER debits pulled from Mercury.

Rippling's own QBO integration already books payroll expense and the matching
payroll liability. Mercury's bank feed then shows the *cash*, and what Keel
should do with it depends entirely on which charge it is:

  RIPPLING PAYMENT    the full payroll run     REJECTED — Rippling posts it
  CONT RIPPLING       employer tax             DR Payroll Liabilities / CR bank
  PEOPLE CENTER PEO_CONSOL  PEO benefits fees  DR Payroll Liabilities / CR bank
  PEOPLE CENTER PEO_WORKER  workers' comp      DR Employee benefits    / CR bank
  PEOPLE CENTER PEO_EPLI_A  software fee       DR Software Subscriptions / CR bank
  PEOPLE CENTER BILL        HR platform        DR Employee benefits    / CR bank

The first line is the one that matters most. The full payroll runs never touch
Payroll Liabilities in QBO — Rippling books the wages and taxes directly — so
coding them here clears the liability a second time. Through October 2026 they
fell past this module to the AI coder, which booked each one against Payroll
Liabilities: $55,206 of double-clearing sitting in the Review Queue, and a
liability overstated by $6,621.79 because the real clearing entries were never
exported. They are now rejected outright, which is what Scott asked for —
only transactions Rippling does *not* sync should appear in Keel at all.

Account names below are the live QBO chart's own spellings ("Employee benefits"
with a lower-case b, "Software Subscriptions" with no ampersand); they still go
through canonical_account so a rename in QBO is picked up rather than silently
posting to a stale name. Verified against the live chart 2026-11-17.

Every coded entry carries CLEARING_NOTE and lands in the Review Queue
unapproved — nothing here can reach QBO without a human approving it, because
the duplicate check against the Rippling→QBO integration can only be done by a
person.

Matching is on Mercury's descriptor, never on the amount. The original version
used amount bands and they were wrong in both directions: a PEO fee that moves
with headcount drops out of its band, and a small payroll run would be taken
for a tax contribution. An unrecognized descriptor returns None and falls
through to the normal rules engine rather than being guessed at.

This fires ahead of the general rules engine / AI coder and takes priority for
these transactions — see the pre-pass loops in routers/mercury.py. In
particular it pre-empts the PEO_* reject rules, which would otherwise drop the
People Center debits that Keel genuinely has to export.
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

# Returned by classify() for a debit Rippling's own QBO integration already
# posts. Keel must not code it at all — the transaction is rejected so it
# leaves the Review Queue instead of being coded a second time.
REJECT = "rippling_already_in_qbo"

# ── Mercury's descriptors ────────────────────────────────────────────────────
# Every one of these is the second field of Mercury's description, e.g.
# "PEOPLE CENTER; PEO_CONSOL; CONTEXTBRIDGE AI INC". They are what Rippling and
# People Center actually send, verified against every Rippling / PEOPLE CENTER
# transaction on this client from August 2026 on.
#
# The descriptor decides, not the amount. Amount bands were the original
# mechanism and they were wrong in two ways: a fee that changes with headcount
# silently falls out of its band and goes to the AI coder instead, and a small
# payroll run would be mistaken for a tax contribution. Amounts now only break
# the one genuine tie (see _PEO_SOFTWARE_MAX).
#
# "RIPPLING PAYMENT" is the full payroll run. Rippling posts the wages and the
# taxes to QBO itself — these never touch Payroll Liabilities in the QBO
# transaction report for any month — so Keel rejects them. Coding them as a
# liability clearing entry would clear the liability a second time; in October
# 2026 that was $55,206 of double-clearing waiting in the Review Queue.
_RIPPLING_PAYROLL_RUN = "rippling payment"
# "CONT RIPPLING" is the employer tax contribution: a real liability settlement.
_RIPPLING_CONTRIBUTION = "cont rippling"

# People Center descriptors, each a distinct charge with its own treatment.
_PEO_FEES_MARKER     = "peo_consol"   # monthly PEO benefits fee
_PEO_BENEFITS_MARKER = "peo_worker"   # workers' compensation
_PEO_SOFTWARE_MARKER = "peo_epli"     # Rippling software fee
_PEO_BILL_MARKER     = "bill"         # HR/benefits platform billing

# The only amount test left. An unnamed small People Center charge is either
# the ~$9 software fee or a benefits charge; this splits them well clear of
# both. Every named descriptor above is matched first.
_PEO_SOFTWARE_MAX = 25.0

CLEARING_NOTE = (
    "Rippling liability clearing entry — verify against Rippling→QBO "
    "integration to confirm no duplicate exists in QBO before approving"
)

# kind -> (debit account, memo label). The memo labels are the ones already in
# QBO for August, September and October 2026 — keep them byte-identical so a
# reconciliation lines the months up.
_TREATMENTS = {
    "rippling_tax": (PAYROLL_LIABILITIES,    "Rippling employer tax contribution"),
    "peo_fees":     (PAYROLL_LIABILITIES,    "People Center PEO benefits fees"),
    "peo_benefits": (EMPLOYEE_BENEFITS,      "People Center benefits contribution"),
    "peo_software": (SOFTWARE_SUBSCRIPTIONS, "Rippling software fee"),
    # People Center's HR/benefits platform billing. Confirmed 2026-11-17: the
    # October charges were absent from QBO and had to be exported from Keel, so
    # Rippling does not post these.
    "peo_bill":     (EMPLOYEE_BENEFITS,      "People Center - HR/benefits platform"),
}


def classify(txn) -> Optional[str]:
    """
    Which treatment this transaction takes.

    Returns one of _TREATMENTS' keys for a debit Keel must code, REJECT for a
    debit Rippling's own QBO integration already posts, or None to leave the
    transaction to the normal rules engine / AI coder.

    Matching is on Mercury's descriptor, never on the amount: see the notes by
    the descriptor constants. A descriptor we have not seen returns None rather
    than being guessed at, so a new charge type surfaces for a human instead of
    being silently mis-coded.
    """
    if (getattr(txn, "source", None) or "mercury") != "mercury":
        return None
    if (txn.amount or 0) >= 0:            # an ACH pull is money out
        return None                       # (also excludes Rippling refunds)
    if (txn.date or datetime.utcnow()) < EFFECTIVE_FROM:
        return None                       # pre-existing transaction — leave alone

    desc = (txn.description or "").lower()
    amount = abs(txn.amount or 0)

    # ── Rippling ────────────────────────────────────────────────────────────
    if _RIPPLING_PAYROLL_RUN in desc:
        return REJECT                     # Rippling already posted it to QBO
    if _RIPPLING_CONTRIBUTION in desc:
        return "rippling_tax"

    # ── People Center ───────────────────────────────────────────────────────
    if "people center" in desc:
        if _PEO_FEES_MARKER in desc:
            return "peo_fees"
        if _PEO_BENEFITS_MARKER in desc:
            return "peo_benefits"
        if _PEO_SOFTWARE_MARKER in desc:
            return "peo_software"
        if _PEO_BILL_MARKER in desc:
            return "peo_bill"
        # Unnamed People Center charge: the only place an amount still decides.
        return "peo_software" if amount <= _PEO_SOFTWARE_MAX else "peo_benefits"

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
    if treatment is None or treatment == REJECT:
        return []                         # REJECT is handled by the caller

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
