"""
Tie every amortization and depreciation schedule back to the general ledger.

A schedule is a promise: $106.67 of Carta, every month, from August 2026 to
June 2027. Three things have to agree for that promise to be kept, and each can
fail on its own:

    expected   what the schedule says should have posted by now — months
               elapsed x the monthly amount
    keel       what this app actually generated
    qbo        what QuickBooks actually holds

September 2026 failed on the third: QuickBooks held two copies of a Carta
entry, expense overstated $273.34, and nothing in the app could see it because
the app's record of what it pushed was itself the thing that was wrong. October
failed on the second, in the other direction: the Rippling clearing entries were
generated here and never exported, leaving the liability $6,621.79 overstated
in QuickBooks. Both are invisible to a check that reads only one of the three.

So this compares all three, and names which way a schedule is out:

    not_generated      keel < expected   the monthly entry was never created
    not_exported       qbo  < keel       created here, never reached QuickBooks
    duplicated_in_qbo  qbo  > keel       posted more than once
    over_generated     keel > expected   more entries here than the schedule allows

Matching is on the memo, parsed rather than substring-matched. "Carta" and
"Carta (equity management)" are two different schedules whose memos share a
prefix, and a substring match silently merges them — which is how a check ends
up reporting a $273.34 variance against the wrong schedule.
"""
import calendar
import re
from datetime import date, datetime
from typing import Optional

# Several memo shapes are in live use for the same thing, and all of them are
# ours — this app wrote every one of them:
#   "Accrual: Carta (2026-09)"                            routers/accruals.py
#   "The Hanover Insurance Group accrual (2026-06)"       auto-release path
#   "The Hanover Insurance Group amortization (2026-04)"  single-month path
#   "Vanta Sep 2026 amortization"                         ai_coder.py
#
# The middle two were the same Hanover schedule worded two ways because two
# code paths each built their own memo string. That is fixed at the source —
# routers.accruals.monthly_memo is now the only place a monthly memo is
# worded, and the word follows what the entry is rather than which button made
# it. The patterns below still accept every shape, because the rows already in
# QuickBooks keep the wording they were written with and a tie-out that only
# understood the new one would report a phantom gap across all of history.
_ACCRUAL_RES = (

    re.compile(r"^accrual:\s*(?P<vendor>.+?)\s*\((?P<period>\d{4}-\d{2})\)\s*(?:\[keel:[0-9a-f]+\])?$"),
    # Accepts both words: historical rows carry whichever one the code path
    # that created them happened to use.
    re.compile(r"^(?P<vendor>.+?)\s+(?:accrual|amorti[sz]ation)\s*\((?P<period>\d{4}-\d{2})\)\s*(?:\[keel:[0-9a-f]+\])?$"),
    re.compile(r"^(?P<vendor>.+?)\s+(?P<month>[a-z]{3,9} \d{4})\s+amortization\s*(?:\[keel:[0-9a-f]+\])?$"),
)
# "Depreciation - Domain Name - September 2026", optionally key-stamped.
_ASSET_RE = re.compile(
    r"^(?P<term>depreciation|amortization)\s*-\s*(?P<name>.+?)\s*-\s*"
    r"(?P<month>[a-z]+ \d{4})\s*(?:\[keel:[0-9a-f]+\])?$"
)


def _norm(s) -> str:
    return " ".join(str(s or "").split()).lower()


def parse_accrual_memo(memo) -> Optional[tuple]:
    """-> (vendor, 'YYYY-MM') for an accrual/amortization entry, else None."""
    text = _norm(memo)
    for rx in _ACCRUAL_RES:
        m = rx.match(text)
        if not m:
            continue
        if "period" in m.groupdict() and m.groupdict().get("period"):
            return (m.group("vendor"), m.group("period"))
        raw = m.group("month")
        for fmt in ("%b %Y", "%B %Y"):
            try:
                return (m.group("vendor"), datetime.strptime(raw, fmt).strftime("%Y-%m"))
            except ValueError:
                continue
    return None


def parse_asset_memo(memo) -> Optional[tuple]:
    """-> (asset_name, 'YYYY-MM') for a depreciation entry, else None."""
    m = _ASSET_RE.match(_norm(memo))
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group("month"), "%B %Y")
    except ValueError:
        return None
    return (m.group("name"), dt.strftime("%Y-%m"))


def months_between(start: str, end: str) -> list[str]:
    """Inclusive list of 'YYYY-MM' from start to end. Empty if end < start."""
    sy, sm = (int(x) for x in start.split("-"))
    ey, em = (int(x) for x in end.split("-"))
    out = []
    y, m = sy, sm
    while (y, m) <= (ey, em):
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def month_end(period: str) -> date:
    y, m = (int(x) for x in period.split("-"))
    return date(y, m, calendar.monthrange(y, m)[1])


def asset_monthly(asset) -> float:
    """Straight-line monthly charge. Returns 0 for an indefinite-life asset."""
    if getattr(asset, "is_indefinite_life", False):
        return 0.0
    life = int(getattr(asset, "useful_life_months", 0) or 0)
    if life <= 0:
        return 0.0
    base = float(asset.purchase_price or 0) - float(asset.salvage_value or 0)
    return round(base / life, 2)


def asset_first_period(asset) -> Optional[str]:
    """The month depreciation starts: the month AFTER purchase.

    This mirrors routers.fixed_assets._compute_schedule, which is the thing
    that actually generates the entries — the Domain Name was bought
    2026-01-04 and first amortized in February, the MacBooks were bought
    2026-07-09/10 and first depreciated in August. Assuming the purchase month
    instead made the tie-out report a missing first month for every asset the
    client owns, which is the kind of false positive that gets a close check
    ignored by the second month.
    """
    raw = str(getattr(asset, "purchase_date", "") or "")[:7]
    if not re.match(r"^\d{4}-\d{2}$", raw):
        return None
    y, m = (int(x) for x in raw.split("-"))
    return "%04d-%02d" % (y + 1, 1) if m == 12 else "%04d-%02d" % (y, m + 1)


def asset_expected_periods(asset, through: str) -> list[str]:
    """Every period this asset should have been charged for, up to `through`.

    Capped at the useful life, so a fully depreciated asset stops accruing
    expectation instead of reporting a growing variance for ever.
    """
    start = asset_first_period(asset)
    if not start or asset_monthly(asset) <= 0:
        return []
    periods = months_between(start, through)
    life = int(getattr(asset, "useful_life_months", 0) or 0)
    return periods[:life] if life else periods


def derive_schedule(rows) -> Optional[dict]:
    """Infer a fixed amortization schedule from its own AccruedExpense rows.

    A prepaid does not need a StandingAccrualRule to be a real schedule. The
    Payments tab creates prepaids directly as accrued-expense rows with no
    standing rule attached, which is how Hanover is set up — twelve rows,
    April 2026 to March 2027, $139.83 a month, every one of them real. Reading
    only standing rules made the tie-out call that "unscheduled" and skip it,
    which is precisely backwards: it is scheduled, this app simply held the
    schedule somewhere else.

    Returns None for a vendor whose rows are variable accruals rather than an
    amortization schedule. The discriminator is the thing that makes a schedule
    a schedule: several periods, all for materially the same amount. Relentful
    and Morrison & Foerster bill a different amount every month and have no
    promise to test; Hanover, Buckner and Carta repeat to the cent.
    """
    periods = sorted({r.service_period for r in rows if r.service_period})
    if len(periods) < 3:
        return None
    amounts = [round(float(r.amount or 0), 2) for r in rows if r.amount]
    if not amounts:
        return None
    # The modal amount is the schedule's monthly charge; a final stub month
    # that differs by a few cents of rounding is normal and must not disqualify.
    modal = max(set(amounts), key=amounts.count)
    if modal <= 0:
        return None
    consistent = sum(1 for a in amounts if abs(a - modal) <= max(0.05, modal * 0.01))
    if consistent < len(amounts) * 0.8:
        return None                     # variable accrual, not an amortization
    return {"monthly": modal, "start": periods[0], "end": periods[-1],
            "periods": periods}


def flags(expected_total: float, keel_total: float, qbo_total: float,
          tolerance: float = 0.01) -> list[str]:
    """Every way this schedule is out, not just the first one found.

    A schedule can fail two ways at once and both need fixing: the Domain Name
    was short one generated month AND had three months generated that never
    reached QuickBooks. Reporting only the first would have hidden $102.87 of
    amortization missing from the ledger behind a one-month generation gap.
    """
    out = []
    if qbo_total - keel_total > tolerance:
        out.append("duplicated_in_qbo")
    if keel_total - qbo_total > tolerance:
        out.append("not_exported")
    if expected_total - keel_total > tolerance:
        out.append("not_generated")
    if keel_total - expected_total > tolerance:
        out.append("over_generated")
    return out


def classify(expected_total: float, keel_total: float, qbo_total: float,
             tolerance: float = 0.01) -> str:
    """The single worst thing wrong with this schedule, for a one-line summary.

    A duplicate in QuickBooks ranks first: it overstates the books and needs a
    human to delete something. Then entries that never reached QuickBooks, which
    understate it. Generation gaps rank last — nothing is wrong in the ledger
    yet, a button needs pressing.
    """
    found = flags(expected_total, keel_total, qbo_total, tolerance)
    for rank in ("duplicated_in_qbo", "not_exported", "over_generated", "not_generated"):
        if rank in found:
            return rank
    return "ok"
