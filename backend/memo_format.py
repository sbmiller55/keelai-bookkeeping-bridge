"""
One place that names a recurring entry.

Three code paths used to write a monthly prepaid amortization, and each built
its own memo string:

    routers/accruals.py  single month   "<vendor> amortization (2026-04)"
    routers/accruals.py  auto-release   "<vendor> accrual (2026-06)"
    ai_coder.py          code-as-prepaid "<vendor> Apr 2026 amortization"

Same schedule, same account, same monthly charge — three wordings, decided by
which button happened to produce that month. Hanover's April and May came out
of the first and June onward out of the second, so one twelve-month schedule
carried two different memos.

That is not cosmetic. The close tie-out matches a QuickBooks entry back to its
schedule by reading the memo, and a schedule whose months are worded two ways
reads as a schedule with a hole in it — it reported a confident $279.66 gap
against Hanover that did not exist. Anything that reconciles on text needs the
text to be written once.

So the word follows what the entry IS, not how it was made:

    crediting Prepaid expenses  -> "amortization"   releasing something paid
    crediting Accrued Expenses  -> "accrual"        releasing something owed

Entries already in QuickBooks keep the wording they were written with; this
only governs new ones. schedule_tieout still accepts every historical shape.
"""
from typing import Optional

PREPAID = "prepaid"
ACCRUAL = "accrual"


def kind_for_credit_account(credit_account: Optional[str]) -> str:
    """Which kind of entry credits this account.

    Defaults to an accrual when the account is unknown: the accrual wording is
    the safer thing to say about an entry we cannot classify, since calling a
    plain accrual "amortization" asserts a prepaid asset that may not exist.
    """
    return PREPAID if "prepaid" in (credit_account or "").lower() else ACCRUAL


def monthly_memo(vendor_name: str, service_period: str, kind: str = ACCRUAL) -> str:
    """The memo for one month of a schedule. `service_period` is "YYYY-MM"."""
    term = "amortization" if kind == PREPAID else "accrual"
    return f"{vendor_name} {term} ({service_period})"[:80]


def monthly_description(vendor_name: str, service_period: str, kind: str = ACCRUAL) -> str:
    """The transaction description that sits alongside monthly_memo."""
    term = "prepaid amortization" if kind == PREPAID else "accrual release"
    return f"{vendor_name} {term} ({service_period})"
