"""
Deterministic accrual-basis handling for Mercury interest income.

Mercury pays the interest *earned* in month N on the 1st day of month N+1.
On an accrual basis the income belongs to month N (the period earned), while
the cash only lands in month N+1 (received). So an incoming Mercury interest
deposit is split into two linked journal entries:

  JE 1 (last day of the earned month):  DR Interest Receivable / CR Interest Earned
  JE 2 (actual receipt date):           DR <bank account>      / CR Interest Receivable

Both entries tag the QBO customer "Mercury Interest": every line that posts to
Accounts Receivable (Interest Receivable) requires a customer Name on export,
or QBO rejects the journal entry (business validation error 6000).

This fires ahead of the general rules engine / AI coder and takes priority for
these transactions — see the pre-pass loops in routers/mercury.py.
"""
from datetime import datetime, timedelta

INTEREST_RECEIVABLE = "Interest Receivable"
INTEREST_EARNED     = "Interest Earned"
INTEREST_CUSTOMER   = "Mercury Interest"
# Fallback only — normally we debit the transaction's own Mercury account.
DEFAULT_BANK_ACCOUNT = "Mercury Checking"


def is_mercury_interest(txn) -> bool:
    """
    True for an incoming Mercury interest-income deposit.

    Matches when the transaction is a Mercury deposit (source is Mercury and
    amount is positive) whose description / counterparty / category / kind
    mentions "interest".
    """
    if (getattr(txn, "source", None) or "mercury") != "mercury":
        return False
    if (txn.amount or 0) <= 0:            # income only, not an interest expense
        return False
    haystacks = (
        txn.description or "",
        getattr(txn, "counterparty_name", "") or "",
        getattr(txn, "mercury_category", "") or "",
        getattr(txn, "kind", "") or "",
    )
    return any("interest" in h.lower() for h in haystacks)


def _earned_month_end(receipt_date: datetime) -> datetime:
    """Last calendar day of the month *before* the receipt date."""
    first_of_receipt_month = receipt_date.replace(day=1)
    return first_of_receipt_month - timedelta(days=1)


def build_interest_jes(txn) -> list[dict]:
    """
    Return the two accrual journal-entry dicts for a Mercury interest deposit.
    Both share the transaction, so the Review Queue renders them as two linked
    rows. Keys map directly onto models.JournalEntry columns.
    """
    receipt_date = txn.date or datetime.utcnow()
    earned_end   = _earned_month_end(receipt_date)
    period       = earned_end.strftime("%B %Y")            # e.g. "June 2026"
    amount       = abs(txn.amount or 0)
    bank         = getattr(txn, "mercury_account_name", None) or DEFAULT_BANK_ACCOUNT

    note = (
        "Split into two entries for accrual basis — income recognized "
        f"{earned_end.strftime('%B')} {earned_end.day} (earned), cash recorded "
        f"{receipt_date.strftime('%B')} {receipt_date.day} (received)."
    )

    return [
        {   # JE 1 — income earned in the prior month
            "debit_account":  INTEREST_RECEIVABLE,
            "credit_account": INTEREST_EARNED,
            "amount":         amount,
            "je_date":        earned_end,
            "memo":           f"Interest earned - {period}",
            "description":    f"Interest earned - {period}",
            "customer_name":  INTEREST_CUSTOMER,
            "ai_confidence":  1.0,
            "ai_reasoning":   note,
        },
        {   # JE 2 — cash received on the receipt date, clearing the receivable
            "debit_account":  bank,
            "credit_account": INTEREST_RECEIVABLE,
            "amount":         amount,
            "je_date":        receipt_date,
            "memo":           f"Interest received - {period}",
            "description":    f"Interest received - {period}",
            "customer_name":  INTEREST_CUSTOMER,
            "ai_confidence":  1.0,
            "ai_reasoning":   note,
        },
    ]
