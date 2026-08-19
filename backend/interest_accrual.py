"""
Deterministic accrual-basis handling for Mercury interest income and the
Treasury fees charged against it.

Mercury pays the interest *earned* in month N in the first days of month N+1.
On an accrual basis the income belongs to month N (the period earned), while
the cash only lands in month N+1 (received). So an incoming Mercury interest
deposit is split into two linked journal entries:

  JE 1 (last day of the earned month):  DR Interest Receivable / CR Interest Earned
  JE 2 (actual receipt date):           DR <bank account>      / CR Interest Receivable

Both entries tag the QBO customer "Mercury Interest": every line that posts to
Accounts Receivable (Interest Receivable) requires a customer Name on export,
or QBO rejects the journal entry (business validation error 6000).

The Treasury fee Mercury charges for running that account is the mirror image:
it is a cost of earning the interest, so the chart books it as a *reduction of
Interest Earned* (not Banking Fees), and it accrues to the month the interest
was earned rather than the month the cash moves:

  JE 1 (last day of the earned month):  DR Interest Earned  / CR Accrued Expenses
  JE 2 (actual charge date):            DR Accrued Expenses / CR <treasury account>

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


def canonical_account(name: str, coa_names=None) -> str:
    """
    The live chart's own spelling of an account name.

    Everything written into a JE goes through here, because the QBO export
    resolves account names literally. Two ways a hardcoded name goes wrong:

      - casing. The chart holds "Interest earned"; writing "Interest Earned"
        made the export build the FQN "Other Income:Interest Earned" from a
        stale parent map and reject the entry.
      - Mercury's own labels. "Mercury Treasury" is not "Mercury Treasury - 1".

    Prefer an exact (case-insensitive) chart hit, then fall back to the tolerant
    matcher the AI coder uses. Returns `name` unchanged when there's no chart or
    no plausible match, so the export surfaces the mismatch rather than us
    silently posting to the wrong account.
    """
    if not name or not coa_names:
        return name
    for candidate in coa_names:
        if candidate.lower() == name.lower():
            return candidate
    try:
        from ai_coder import _validate_account
    except Exception:
        return name
    resolved = _validate_account(name, coa_names)
    # _validate_account brackets unmatched names as "Uncoded [x]" for a human to
    # fix; that's worse than the original name here, so keep the original.
    return name if resolved.startswith("Uncoded [") else resolved


def resolve_bank_account(txn, coa_names=None) -> str:
    """The chart's name for the Mercury account the deposit landed in."""
    raw = getattr(txn, "mercury_account_name", None) or DEFAULT_BANK_ACCOUNT
    return canonical_account(raw, coa_names)


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
    receivable   = canonical_account(INTEREST_RECEIVABLE, coa_names)
    earned       = canonical_account(INTEREST_EARNED, coa_names)

    earned_end   = _earned_month_end(receipt_date)
    period       = earned_end.strftime("%B %Y")            # e.g. "July 2026"

    note = (
        "Split into two entries for accrual basis — income recognized "
        f"{earned_end.strftime('%B')} {earned_end.day} (earned), cash recorded "
        f"{receipt_date.strftime('%B')} {receipt_date.day} (received)."
    )

    return [
        {   # JE 1 — income earned in the prior month
            "debit_account":  receivable,
            "credit_account": earned,
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
            "credit_account": receivable,
            "amount":         amount,
            "je_date":        receipt_date,
            "memo":           f"Interest received - {period}",
            "description":    f"Interest received - {period}",
            "customer_name":  INTEREST_CUSTOMER,
            "ai_confidence":  1.0,
            "ai_reasoning":   note,
        },
    ]


ACCRUED_EXPENSES = "Accrued Expenses"
# Fallback only — normally we credit the transaction's own Mercury account.
DEFAULT_TREASURY_ACCOUNT = "Mercury Treasury"

# Kinds that move cash between the client's own Mercury accounts. A sweep into
# or out of Treasury is negative on the outgoing side and Mercury describes it
# as "Treasury Transfer", so it clears the treasury+negative test below — but it
# is principal, not a fee. Booking one as a fee would credit the same cash it
# already moved and understate interest income by the full sweep.
_FEE_EXCLUDED_KINDS = {
    "treasurytransfer",
    "internaltransfer",
    "intraaccounttransfer",
    "externaltransfer",
    "creditcardpayment",
}

# What a charge (rather than a transfer or a securities purchase) looks like.
# Mercury labels the kind "fee" and/or says so in the description; "expense
# ratio" is how the money-market side of Treasury words its management charge.
_FEE_PHRASES = ("fee", "charge", "expense ratio")

TREASURY_FEE_NOTE = (
    "Treasury fee split for accrual basis — expense recognized in month earned, "
    "cash recorded on transaction date. Coded as reduction to Interest Earned "
    "per company accounting policy, not Banking Fees."
)


def is_treasury_fee(txn) -> bool:
    """
    True for a Mercury Treasury account fee — a charge that reduces the interest
    the Treasury account earned.

    Matches a Mercury *outflow* (source is Mercury, negative amount) dated on or
    after EFFECTIVE_FROM whose description mentions "treasury", provided it also
    reads as a fee and is not an internal cash sweep (see _FEE_EXCLUDED_KINDS).
    """
    if (getattr(txn, "source", None) or "mercury") != "mercury":
        return False
    if (txn.amount or 0) >= 0:            # fees only, never a deposit
        return False
    if (txn.date or datetime.utcnow()) < EFFECTIVE_FROM:
        return False                      # closed period — leave it alone
    if (getattr(txn, "kind", "") or "").lower() in _FEE_EXCLUDED_KINDS:
        return False                      # cash sweep, not a fee
    if "treasury" not in (txn.description or "").lower():
        return False
    haystacks = (
        txn.description or "",
        getattr(txn, "mercury_category", "") or "",
        getattr(txn, "kind", "") or "",
    )
    return any(p in h.lower() for h in haystacks for p in _FEE_PHRASES)


def resolve_treasury_account(txn, coa_names=None) -> str:
    """The chart's name for the Mercury account the fee was charged against."""
    raw = getattr(txn, "mercury_account_name", None) or DEFAULT_TREASURY_ACCOUNT
    return canonical_account(raw, coa_names)


def build_treasury_fee_jes(txn, coa_names=None) -> list[dict]:
    """
    Return the two accrual journal-entry dicts for a Mercury Treasury fee:
    recognize the cost against Interest Earned in the month that interest was
    earned, then clear the accrual when the cash leaves on the charge date.
    Both share the transaction, so the Review Queue renders them as two linked
    rows carrying TREASURY_FEE_NOTE.

    Mercury charges the fee in arrears, so the earned period is the month before
    the charge date — the same period the interest it offsets belongs to.

    Keys map directly onto models.JournalEntry columns.
    """
    charge_date = txn.date or datetime.utcnow()
    amount      = abs(txn.amount or 0)
    treasury    = resolve_treasury_account(txn, coa_names)
    accrued     = canonical_account(ACCRUED_EXPENSES, coa_names)
    earned      = canonical_account(INTEREST_EARNED, coa_names)

    earned_end  = _earned_month_end(charge_date)
    period      = earned_end.strftime("%B %Y")             # e.g. "July 2026"

    return [
        {   # JE 1 — the fee reduces the interest earned in the prior month
            "debit_account":  earned,
            "credit_account": accrued,
            "amount":         amount,
            "je_date":        earned_end,
            "memo":           f"Treasury account fee - {period}",
            "description":    f"Treasury account fee - {period}",
            "customer_name":  None,
            "ai_confidence":  1.0,
            "ai_reasoning":   TREASURY_FEE_NOTE,
        },
        {   # JE 2 — cash leaves on the charge date, clearing the accrual
            "debit_account":  accrued,
            "credit_account": treasury,
            "amount":         amount,
            "je_date":        charge_date,
            "memo":           f"Treasury fee payment - {period}",
            "description":    f"Treasury fee payment - {period}",
            "customer_name":  None,
            "ai_confidence":  1.0,
            "ai_reasoning":   TREASURY_FEE_NOTE,
        },
    ]
