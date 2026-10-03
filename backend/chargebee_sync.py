"""
Import orchestration for the Chargebee subscription demo.

Two entry points:

  setup_demo()  — one-off. Creates the four revenue streams and backfills a
                  stretch of *already posted* history, so the client opens with
                  real deferred-revenue balances and a part-recognized schedule
                  instead of a blank page. History lands as `exported`, which
                  keeps it out of the review queue — the queue is the thing being
                  demonstrated and it should start empty.

  run_import()  — the demo action. Advances the cursor, pulls the next slice of
                  subscriptions and refunds, and leaves everything `pending` for
                  human review. Each press brings new subscribers.

The cursor leaves a deliberate runway: history stops well short of today, so
there are always unimported days ahead. When it runs out, rewind_cursor() gives
another run of demos.

Entries are coded deterministically from the plan code, which fixes the service
period and therefore the whole schedule. No AI call is made — the revenue
router's generic importer asks the model to infer the stream and service period,
which for a known plan is both slower and less accurate, and would bill an API
call per subscriber on every demo.
"""
import json
from calendar import monthrange
from datetime import datetime, timedelta
from typing import Optional

import chargebee_demo as feed
import chargebee_revenue_je as cbje
from models import (
    JournalEntry,
    RevenueContract,
    RevenueContractStatus,
    RevenueScheduleEntry,
    RevenueStream,
    Transaction,
    TransactionStatus,
    BillingType,
    next_je_number,
)

# Streams are matched to plans by name, so these must equal the plan labels in
# chargebee_demo.PLANS.
STREAM_SPECS = [
    ("Plus Annual",        BillingType.annual_upfront,  "Plus"),
    ("Essentials Annual",  BillingType.annual_upfront,  "Essentials"),
    ("Plus Monthly",       BillingType.monthly_advance, "Plus"),
    ("Essentials Monthly", BillingType.monthly_advance, "Essentials"),
]

# How far back the posted history runs, and where it stops relative to today.
HISTORY_DAYS = 21
RUNWAY_DAYS  = 30     # unimported days left for demos


def _last_day(year: int, month: int) -> datetime:
    return datetime(year, month, monthrange(year, month)[1])


def _month_elapsed(period: str, as_of: datetime) -> bool:
    """Whether a "YYYY-MM" service month has fully finished."""
    try:
        y, m = (int(x) for x in period.split("-"))
    except ValueError:
        return False
    return _last_day(y, m) < as_of


def ensure_streams(client_id: int, db) -> dict[str, RevenueStream]:
    """Create the four plan streams if absent; return them keyed by name."""
    existing = {
        s.name: s
        for s in db.query(RevenueStream).filter(RevenueStream.client_id == client_id).all()
    }
    for name, billing_type, tier in STREAM_SPECS:
        if name in existing:
            continue
        stream = RevenueStream(
            client_id=client_id,
            name=name,
            billing_type=billing_type,
            revenue_account=cbje.REVENUE_ACCOUNTS[tier],
            deferred_revenue_account=cbje.DEFERRED_ACCOUNT,
            ar_account="Accounts Receivable",
            # Deliberately left unset. A bank account here makes the revenue
            # router book an AR cash receipt (DR bank / CR AR), which is the
            # wrong model for this client: subscription cash arrives up front
            # into the Chargebee clearing account and never sits in AR. The
            # clearing and payout entries are handled by chargebee_revenue_je.
            bank_account=None,
            active=True,
        )
        db.add(stream)
        existing[name] = stream
    db.flush()
    return existing


def _add_jes(
    db,
    client_id: int,
    jes: list[dict],
    *,
    description: str,
    amount: float,
    when: datetime,
    posted: bool,
    source: str = "chargebee",
    counterparty: Optional[str] = None,
) -> Optional[Transaction]:
    """Attach a group of JE lines to one reviewable transaction.

    Each line gets its own je_number — the column is uniquely constrained, and
    the rest of the app (interest accrual, treasury fees, prepaid schedules)
    numbers every DR/CR pair separately too. What groups the lines of one
    accounting entry is the shared transaction, which is also how the review
    queue and the export present them.
    """
    if not jes:
        return None
    tx = Transaction(
        client_id=client_id,
        date=when,
        description=description[:255],
        amount=amount,
        counterparty_name=counterparty,
        status=TransactionStatus.exported if posted else TransactionStatus.pending,
        source=source,
        imported_at=datetime.utcnow(),
    )
    db.add(tx)
    db.flush()

    je_number = next_je_number(db)
    for offset, line in enumerate(jes):
        db.add(JournalEntry(
            je_number=je_number + offset,
            transaction_id=tx.id,
            debit_account=line["debit_account"],
            credit_account=line["credit_account"],
            amount=line["amount"],
            je_date=line.get("je_date") or when,
            memo=(line.get("memo") or "")[:80],
            description=line.get("description"),
            customer_name=line.get("customer_name"),
            ai_confidence=line.get("ai_confidence"),
            ai_reasoning=line.get("ai_reasoning"),
            exported_at=datetime.utcnow() if posted else None,
        ))
    db.flush()
    return tx


def _upsert_subscription(
    client_id: int, sub: dict, streams: dict[str, RevenueStream], db
) -> Optional[RevenueContract]:
    """Create the contract and its recognition schedule. None if already imported."""
    existing = db.query(RevenueContract).filter(
        RevenueContract.client_id == client_id,
        RevenueContract.external_id == sub["invoice_id"],
    ).first()
    if existing:
        return None

    stream = streams.get(sub["plan_label"])
    if stream is None:
        return None

    contract = RevenueContract(
        client_id=client_id,
        revenue_stream_id=stream.id,
        customer_name=sub["customer_name"],
        external_id=sub["invoice_id"],
        source="chargebee",
        invoice_number=sub["invoice_id"],
        total_contract_value=round(float(sub["amount"]), 2),
        billing_date=sub["billing_date"],
        due_date=sub["billing_date"],          # collected at point of sale
        service_period_start=sub["period_start"],
        service_period_end=sub["period_end"],
        payment_received=True,
        payment_date=sub["billing_date"],
        ai_confidence=1.0,
        ai_reasoning=(
            f"{sub['plan_label']} ({sub['plan_code']}): service period and recognition "
            f"schedule derived from the plan term, so no estimation was needed."
        ),
        raw_data=json.dumps(sub, default=str)[:4000],
        status=RevenueContractStatus.active,
    )
    db.add(contract)
    db.flush()

    # Reuse the router's schedule builder rather than reimplementing the monthly
    # split, so the two can never drift. Imported late to avoid a circular
    # import at module load (the router imports this module).
    from routers.revenue import _create_schedule_entries
    _create_schedule_entries(contract, stream, db)
    db.flush()
    return contract


def _elapsed_entries(contract: RevenueContract, db, *, as_of: datetime) -> list:
    """Unbooked schedule entries whose service month has fully finished."""
    entries = db.query(RevenueScheduleEntry).filter(
        RevenueScheduleEntry.contract_id == contract.id,
        RevenueScheduleEntry.je_id.is_(None),
    ).order_by(RevenueScheduleEntry.period).all()
    return [e for e in entries if _month_elapsed(e.period, as_of)]


def _post_recognition(
    client_id: int, stream: RevenueStream, period: str, items: list, db, *, posted: bool
) -> int:
    """Book one month's recognition for a stream as a single journal entry.

    Also maintains the two fields the revenue summary reads — `recognized` on
    each schedule entry and `amount_recognized` on each contract — which the
    app's other recognition paths left inconsistent, so "Recognized this month"
    always displayed zero.
    """
    if not items:
        return 0
    from routers.revenue import POLICY_NOTE, POLICY_FULL_MONTH, _recognition_policy
    policy_note = POLICY_NOTE.get(
        _recognition_policy(client_id, db), POLICY_NOTE[POLICY_FULL_MONTH]
    )
    y, m = (int(x) for x in period.split("-"))
    je_date = _last_day(y, m)
    total = round(sum(e.amount for _, e in items), 2)
    if total <= 0:
        return 0

    memo = f"Revenue recognition - {stream.name} - {je_date:%b %Y}"
    tx = _add_jes(
        db, client_id,
        [{
            "debit_account": stream.deferred_revenue_account,
            "credit_account": stream.revenue_account,
            "amount": total,
            "je_date": je_date,
            "memo": memo,
            "description": f"{memo} ({len(items)} subscriptions)",
            "customer_name": None,
            "ai_confidence": 1.0,
            "ai_reasoning": (
                f"{policy_note} {stream.name}, {period}: {len(items)} subscriptions "
                f"earned a month of access against cash collected up front. "
                f"Posted as one entry for the period."
            ),
        }],
        description=memo,
        amount=total,
        when=je_date,
        posted=posted,
        source="revenue",
    )
    if tx is None:
        return 0
    je = db.query(JournalEntry).filter(JournalEntry.transaction_id == tx.id).first()
    for contract, entry in items:
        entry.je_id = je.id if je else None
        entry.recognized = True
        contract.amount_recognized = round((contract.amount_recognized or 0.0) + entry.amount, 2)
        if contract.amount_recognized >= round(contract.total_contract_value, 2) - 0.01:
            contract.status = RevenueContractStatus.fully_recognized
    return 1


def _process_window(
    client_id: int, window: dict, streams: dict[str, RevenueStream], db,
    *, posted: bool, as_of: datetime,
) -> dict:
    """Turn one slice of Chargebee activity into contracts, schedules and JEs."""
    subs = window["subscriptions"]
    refunds = window["refunds"]

    new_contracts = 0
    billing_jes = 0
    gross = 0.0
    billed_count = 0
    release_lines: list[dict] = []
    recognition_buckets: dict[tuple[int, str], list] = {}

    for sub in subs:
        contract = _upsert_subscription(client_id, sub, streams, db)
        if contract is None:
            continue                       # already imported — never double-book
        new_contracts += 1
        billed_count += 1
        gross += round(float(sub["amount"]), 2)

        lines = cbje.billing_jes(sub)
        _add_jes(
            db, client_id, lines,
            description=f"Chargebee billing - {sub['plan_label']} - {sub['customer_name']}",
            amount=round(float(sub["amount"]), 2),
            when=sub["billing_date"],
            posted=posted,
            counterparty=sub["customer_name"],
        )
        billing_jes += len(lines)

        # A subscription that will be refunded never has its reserve released:
        # releasing at day 7 and refunding later would relieve the liability
        # twice for one subscriber and leave it overdrawn.
        if not sub.get("will_be_refunded"):
            release_lines.extend(cbje.reserve_release_jes(sub, as_of=as_of))

        stream = streams.get(sub["plan_label"])
        if stream is not None:
            for entry in _elapsed_entries(contract, db, as_of=as_of):
                recognition_buckets.setdefault((stream.id, entry.period), []).append((contract, entry))

    # ── Reserve releases, as one entry for the period ────────────────────────
    # Individually these are dozens of identical DR/CR lines; a close posts them
    # as a single journal entry, and the review queue stays readable.
    if release_lines:
        total = round(sum(l["amount"] for l in release_lines), 2)
        when = max(l["je_date"] for l in release_lines)
        _add_jes(
            db, client_id,
            [{
                "debit_account": cbje.REFUND_LIABILITY,
                "credit_account": cbje.DEFERRED_ACCOUNT,
                "amount": total,
                "je_date": when,
                "memo": f"Guarantee lapsed - {len(release_lines)} subscriptions",
                "description": (
                    f"Refund reserve released on {len(release_lines)} subscriptions whose "
                    f"7-day money-back window closed unclaimed"
                ),
                "customer_name": None,
                "ai_confidence": 1.0,
                "ai_reasoning": (
                    f"The right of return lapsed on {len(release_lines)} subscriptions, so the "
                    f"reserved consideration becomes deferred revenue and is recognized over "
                    f"each remaining service period. ASC 606 variable consideration."
                ),
            }],
            description=f"Refund reserve released - {len(release_lines)} subscriptions",
            amount=total,
            when=when,
            posted=posted,
        )
        billing_jes += 1

    # ── Recognition, one entry per stream per month ──────────────────────────
    recognition_jes = 0
    for (stream_id, period), items in sorted(recognition_buckets.items(), key=lambda kv: kv[0][1]):
        stream = next((s for s in streams.values() if s.id == stream_id), None)
        if stream is None:
            continue
        recognition_jes += _post_recognition(
            client_id, stream, period, items, db, posted=posted
        )

    # ── Refunds ──────────────────────────────────────────────────────────────
    refund_total = 0.0
    refund_count = 0
    for refund in refunds:
        contract = db.query(RevenueContract).filter(
            RevenueContract.client_id == client_id,
            RevenueContract.external_id == refund["invoice_id"],
        ).first()
        # Idempotency: a cancelled contract has already been refunded, so a
        # replayed window must not book the credit note a second time.
        if contract is not None and contract.status == RevenueContractStatus.cancelled:
            continue
        # No contract means the original billing was never imported — it predates
        # the backfill. Refunding an invoice that was never recorded would debit
        # a refund reserve that was never credited, leaving the liability
        # overdrawn by the difference.
        if contract is None:
            continue

        lines = cbje.refund_jes(refund)
        _add_jes(
            db, client_id, lines,
            description=f"Chargebee refund - {refund['plan_label']} - {refund['customer_name']}",
            amount=-round(float(refund["amount"]), 2),
            when=refund["refund_date"],
            posted=posted,
            counterparty=refund["customer_name"],
        )
        refund_total += round(float(refund["amount"]), 2)
        refund_count += 1

        if contract is not None:
            contract.status = RevenueContractStatus.cancelled
            db.query(RevenueScheduleEntry).filter(
                RevenueScheduleEntry.contract_id == contract.id,
                RevenueScheduleEntry.je_id.is_(None),
            ).delete(synchronize_session=False)

    # ── Processor fees and the payout that clears the holding account ────────
    # Only when this window actually brought something in. A replayed window
    # imports no billings, and charging a fee or paying out against nothing
    # would leave the clearing account with a balance that never closes.
    fee = feed.processor_fee(gross, billed_count) if billed_count else 0.0
    settle_date = window["window_end"] or as_of
    if fee:
        _add_jes(
            db, client_id,
            cbje.processor_fee_je(gross, fee, settle_date, billed_count),
            description=f"Chargebee processing fees - {billed_count} transactions",
            amount=-fee,
            when=settle_date,
            posted=posted,
        )
    net = round(gross - fee - refund_total, 2)
    if (billed_count or refund_count) and abs(net) >= 0.01:
        _add_jes(
            db, client_id,
            cbje.payout_je(net, settle_date),
            description=f"Chargebee payout - ${net:,.2f}",
            amount=net,
            when=settle_date,
            posted=posted,
        )

    return {
        "subscriptions": new_contracts,
        "refunds": refund_count,
        "gross_billings": round(gross, 2),
        "processor_fees": fee,
        "refund_total": round(refund_total, 2),
        "net_payout": net,
        "reserve_releases": len(release_lines),
        "billing_jes": billing_jes,
        "recognition_jes": recognition_jes,
        "window_start": window["window_start"].strftime("%Y-%m-%d") if window["window_start"] else None,
        "window_end": window["window_end"].strftime("%Y-%m-%d") if window["window_end"] else None,
    }


def setup_demo(client_id: int, db, today: Optional[datetime] = None) -> dict:
    """Create streams and backfill posted history. Safe to re-run."""
    now = (today or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    streams = ensure_streams(client_id, db)

    history_start = now - timedelta(days=HISTORY_DAYS + RUNWAY_DAYS)
    history_end = now - timedelta(days=RUNWAY_DAYS)

    subs: list[dict] = []
    refunds: list[dict] = []
    day = history_start
    while day <= history_end:
        subs.extend(feed.subscriptions_for_day(day))
        refunds.extend(feed.refunds_for_day(day))
        day += timedelta(days=1)

    window = {
        "subscriptions": subs,
        "refunds": refunds,
        "window_start": history_start,
        "window_end": history_end,
    }
    result = _process_window(client_id, window, streams, db, posted=True, as_of=now)
    db.commit()
    result["cursor"] = history_end.strftime("%Y-%m-%d")
    result["posted_as"] = "exported (history — not in the review queue)"
    return result


def run_import(client_id: int, db, cursor: Optional[str], today: Optional[datetime] = None) -> dict:
    """Pull the next slice and leave it pending for review."""
    now = (today or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    window = feed.fetch_window(cursor, today=now)
    if window.get("exhausted"):
        return {
            "subscriptions": 0, "refunds": 0, "exhausted": True, "cursor": cursor,
            "message": (
                "No unimported Chargebee activity left. Rewind the demo cursor to "
                "run through it again."
            ),
        }
    streams = ensure_streams(client_id, db)
    result = _process_window(client_id, window, streams, db, posted=False, as_of=now)
    db.commit()
    result["cursor"] = window["cursor"]
    result["exhausted"] = False
    return result


def rewind_cursor(days: int, cursor: Optional[str], today: Optional[datetime] = None) -> str:
    """Move the cursor back so the same days can be demoed again.

    Re-importing a rewound day is harmless: the generator is deterministic, so
    the subscription ids repeat and the contract dedup drops them. What it gives
    back is the *window* — useful when a demo needs a fresh batch and the runway
    has been used up.
    """
    now = (today or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    base = now
    if cursor:
        try:
            base = datetime.strptime(cursor[:10], "%Y-%m-%d")
        except ValueError:
            base = now
    return (base - timedelta(days=max(1, days))).strftime("%Y-%m-%d")
