"""
Deterministic accrual-basis handling for Mercury interest income.

Mercury pays the interest *earned* in month N in the first days of month N+1.
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

# The accrual split applies to deposits landing on or after this date only.
# Earlier months are closed and already exported to QBO the old way (a single
# entry in the receipt month); re-coding one of them — a stale-COA sweep, a
# re-sync, a manual re-run — must not silently restate a closed period.
EFFECTIVE_FROM = datetime(2026, 8, 1)

# Phrases that identify an interest-income deposit. Mercury describes the same
# economic event three different ways depending on the product:
#   - savings/checking:  "July interest payment", counterparty "Savings Interest"
#   - treasury sweep:    "Dividend posted: cusip:… (JPMorgan U.S. Treasury Plus
#                         Money Market Fund - Capital Class)"
#   - treasury cash:     "Interest posted"
# The money-market "dividend" is interest on cash, not an equity distribution,
# and the chart books it to Interest Earned — so it takes the same accrual
# split. Payments *out* can never match: only positive amounts get here.
_INTEREST_PHRASES = (
    "interest",
    "dividend posted",
    "money market",
)


def is_mercury_interest(txn) -> bool:
    """
    True for an incoming Mercury interest-income deposit.

    Matches when the transaction is a Mercury deposit (source is Mercury and
    amount is positive) dated on or after EFFECTIVE_FROM, whose description /
    counterparty / category / kind contains one of _INTEREST_PHRASES.
    """
    if (getattr(txn, "source", None) or "mercury") != "mercury":
        return False
    if (txn.amount or 0) <= 0:            # income only, not an interest expense
        return False
    if (txn.date or datetime.utcnow()) < EFFECTIVE_FROM:
        return False                      # closed period — leave it alone
    haystacks = (
        txn.description or "",
        getattr(txn, "counterparty_name", "") or "",
        getattr(txn, "mercury_category", "") or "",
        getattr(txn, "kind", "") or "",
    )
    return any(p in h.lower() for h in haystacks for p in _INTEREST_PHRASES)


def _earned_month_end(receipt_date: datetime) -> datetime:
    """Last calendar day of the month *before* the receipt date."""
    first_of_receipt_month = receipt_date.replace(day=1)
    return first_of_receipt_month - timedelta(days=1)


def resolve_bank_account(txn, coa_names=None) -> str:
    """
    The chart-of-accounts name for the Mercury account the deposit landed in.

    Mercury's own label ("Mercury Treasury") rarely matches the QBO account
    ("Mercury Treasury - 1"), and the QBO sync rejects a JE whose account name
    isn't in the chart. Run the label through the same tolerant matcher the AI
    coder uses so the split posts to the real account.
    """
    raw = getattr(txn, "mercury_account_name", None) or DEFAULT_BANK_ACCOUNT
    if not coa_names:
        return raw
    try:
        from ai_coder import _validate_account
    except Exception:
        return raw
    resolved = _validate_account(raw, coa_names)
    # _validate_account brackets unmatched names as "Uncoded [x]" for a human to
    # fix; for a bank account that's worse than Mercury's own label, so keep the
    # label and let the export surface the mismatch.
    return raw if resolved.startswith("Uncoded [") else resolved


def build_interest_jes(txn, coa_names=None) -> list[dict]:
    """
    Return the two accrual journal-entry dicts for a Mercury interest deposit:
    accrue the income to the month earned, then clear the receivable when the
    cash lands. Both share the transaction, so the Review Queue renders them as
    two linked rows.

    Interest is always paid in arrears, so the earned period is the month before
    the receipt date no matter what day of the month the deposit posts.

    Keys map directly onto models.JournalEntry columns.
    """
    receipt_date = txn.date or datetime.utcnow()
    amount       = abs(txn.amount or 0)
    bank         = resolve_bank_account(txn, coa_names)

    earned_end   = _earned_month_end(receipt_date)
    period       = earned_end.strftime("%B %Y")            # e.g. "July 2026"

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
