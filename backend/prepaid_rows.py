"""
Give a prepaid coded straight to journal entries the rows the rest of the app
looks for.

"Code as Prepaid" writes a year of amortization as journal entries against the
original transaction. It never created AccruedExpense rows, and the Payments
tab lists exactly those rows — so a schedule coded this way was correct in
QuickBooks and completely invisible in the app. Vanta sat like that from August
2026 until someone went looking for it: twelve real entries, nothing on screen.

The rows are a view onto entries that already exist, not new accounting. Each
one points at its journal entry through `accrual_je_id`, and that link is also
what makes this safe: `_auto_release_for_client` releases only rows whose
`accrual_je_id` is NULL, so a linked row can never generate a second entry for
a month that already has one.

Re-coding the same transaction replaces its rows, because the endpoint deletes
and regenerates the entries — rows left pointing at deleted entries would show
a schedule that no longer exists.
"""
from typing import Optional

import models


def _is_monthly_amortization(je, prepaid_account: str) -> bool:
    """The monthly charges credit the prepaid account; the opening entry debits it.

    Both carry a service period, so the period cannot tell them apart — the
    direction can. Crediting the prepaid account is what releasing a month of
    it looks like.
    """
    credit = (getattr(je, "credit_account", "") or "").strip().lower()
    return bool(prepaid_account) and credit == (prepaid_account or "").strip().lower()


def sync_for_transaction(
    db,
    client_id: int,
    transaction_id: int,
    journal_entries: list,
    prepaid_account: str,
    vendor_name: str,
    description: Optional[str] = None,
) -> int:
    """Replace this transaction's prepaid rows to match its journal entries.

    Returns how many rows now exist. Creates no journal entries and changes
    none; call it after the entries are flushed so each has an id.
    """
    db.query(models.AccruedExpense).filter(
        models.AccruedExpense.client_id == client_id,
        models.AccruedExpense.source_transaction_id == transaction_id,
    ).delete(synchronize_session=False)

    created = 0
    for je in journal_entries:
        if not _is_monthly_amortization(je, prepaid_account):
            continue
        period_dt = getattr(je, "service_period_start", None) or getattr(je, "je_date", None)
        if period_dt is None:
            continue
        db.add(models.AccruedExpense(
            client_id=client_id,
            vendor_name=vendor_name,
            description=description or f"{vendor_name} prepaid, amortized monthly",
            service_period=period_dt.strftime("%Y-%m"),
            amount=float(getattr(je, "amount", 0) or 0),
            source_transaction_id=transaction_id,
            # The gate that stops auto-release ever re-posting this month.
            accrual_je_id=je.id,
            status=models.AccruedExpenseStatus.accrued,
            debit_account=getattr(je, "debit_account", None),
            credit_account=getattr(je, "credit_account", None),
            ai_confidence=getattr(je, "ai_confidence", None) or 1.0,
            ai_reasoning="Prepaid amortization schedule — row tracks the journal "
                         "entry created when this transaction was coded as prepaid.",
        ))
        created += 1
    return created
