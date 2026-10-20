"""
Synthetic Chargebee subscription feed for the SuperSummary demo client.

This stands in for the real Chargebee API so the import → auto-code → export
story can be demonstrated end to end before the integration exists. It is the
throwaway half of the pair: when a real Chargebee connection is built, this
module is deleted and `chargebee_revenue_je` (the ASC 606 accounting, which is
not demo-specific) keeps working untouched.

Two properties make it usable for repeat demos:

  - A cursor. Each import advances `chargebee_cursor` by IMPORT_WINDOW_DAYS and
    returns only that slice, so every run brings genuinely new subscribers
    rather than re-showing the same screen.
  - Determinism. A given calendar day always generates the same subscribers,
    because the generator is seeded from the date. Re-importing a day that was
    already pulled is therefore a no-op: the subscription ids match and
    `external_id` dedup drops them. Nothing double-books if a demo is replayed.

Prices and the guarantee term mirror SuperSummary's published plans (Essentials
$9.95/mo or $36/yr, Plus $16.65/mo or $60/yr, refund within 7 days of purchase).
Emails use example.com, which is reserved and cannot route anywhere real.
"""
import hashlib
import math
import random
from datetime import datetime, timedelta
from typing import Optional

# ── Plan catalogue ───────────────────────────────────────────────────────────
# `months` is the service period, which is what drives the ASC 606 deferral:
# an annual plan collects 12 months of cash on day one and earns it over a year.
PLANS: dict[str, dict] = {
    "essentials-monthly": {"label": "Essentials Monthly", "price":  9.95, "months":  1, "tier": "Essentials"},
    "essentials-annual":  {"label": "Essentials Annual",  "price": 36.00, "months": 12, "tier": "Essentials"},
    "plus-monthly":       {"label": "Plus Monthly",       "price": 16.65, "months":  1, "tier": "Plus"},
    "plus-annual":        {"label": "Plus Annual",        "price": 60.00, "months": 12, "tier": "Plus"},
}

# Annual is discounted ~70%, so a real mix skews annual harder than this; the
# weighting keeps a visible number of both in every import so the deferral
# schedule and the straight monthly path are both on screen.
_PLAN_WEIGHTS = [
    ("plus-annual",       28),
    ("essentials-annual", 22),
    ("plus-monthly",      22),
    ("essentials-monthly",28),
]

# Demo sizing. A real day at this price point is hundreds of subscriptions; that
# would bury the review queue, which is the thing being demonstrated, and six
# months of it would be thousands of contracts to render. Volume instead starts
# small and compounds, so a six-month history reads as a business that has been
# growing rather than one that signs the same number of customers every day.
#
# Growth is anchored to a fixed epoch, not to "today": the contract this module
# makes is that a given calendar day always generates the same subscribers, and
# a volume that depended on the current date would quietly break that — the same
# day would grow a longer subscriber list tomorrow, and those extra rows would
# import as brand-new contracts.
SUBS_EPOCH          = datetime(2026, 1, 1)
# Daily *new* signups at the epoch. Deliberately small: once monthly plans
# recur, most of a day's billings are renewals off the retained base, and the
# month totals compound without needing a large signup number. Raising this
# multiplies the whole contract count by roughly the mean subscriber life.
SUBS_PER_DAY_BASE   = 1.5
SUBS_GROWTH_MONTHLY = 0.15       # compounding, so ~2x every five months
SUBS_PER_DAY_CAP    = 40         # keeps a far-future demo readable

IMPORT_WINDOW_DAYS  = 7          # a sync brings a week, not a single day
HISTORY_DAYS        = 182        # six months of posted backfill

GUARANTEE_DAYS      = 7      # SuperSummary's published money-back window

# Monthly plans recur. Each monthly subscriber keeps billing on the same day of
# the month until they churn, which is what makes revenue compound: a month's
# total is last month's retained base plus that month's new signups, not just
# the new signups. Without it every "subscriber" was a different person who
# bought once and vanished, and monthly revenue could only ever track signups.
#
# 0.85 a month is ordinary for a consumer subscription at this price, and gives
# a mean life of roughly seven months.
MONTHLY_RETENTION   = 0.85
MAX_RENEWAL_MONTHS  = 24     # bounds the lookback when a day's renewals are built

# Chargebee's processing cut, applied to gross billings to produce the fee entry.
PROCESSOR_RATE      = 0.029
PROCESSOR_FIXED     = 0.30

# The pools have to be large enough that two subscribers almost never share a
# display name. They used to multiply out to 520 combinations against ~800
# subscribers, so collisions were the norm — and once monthly plans recur, a
# collision reads as one customer being billed four times in a month on
# different days at different prices, which is exactly the thing a prospect
# would query. A middle initial takes the space to ~45,000.
_FIRST_NAMES = [
    "Ava", "Noah", "Maya", "Elijah", "Sofia", "Liam", "Isabel", "Mateo", "Chloe",
    "Owen", "Priya", "Jonah", "Leila", "Caleb", "Nora", "Idris", "Hana", "Felix",
    "Rosa", "Theo", "Amara", "Dmitri", "Keiko", "Omar", "Sadie", "Emeka",
    "Lena", "Arjun", "Mira", "Tobias", "Yuki", "Santiago", "Freya", "Hassan",
    "Iris", "Mateusz", "Zara", "Ezra", "Nadia", "Cormac", "Ingrid", "Rafael",
    "Simone", "Bastien", "Anika", "Lucas", "Greta", "Kofi", "Elena", "Niko",
]
_LAST_NAMES = [
    "Whitfield", "Okafor", "Lindqvist", "Marchetti", "Delgado", "Novak", "Abiodun",
    "Castellanos", "Thornbury", "Varga", "Nakamura", "Oyelaran", "Fairbanks",
    "Petrosyan", "Kowalski", "Mbeki", "Sandoval", "Ellsworth", "Haddad", "Quintero",
    "Brennan", "Sorensen", "Achebe", "Yamamoto", "Moreau", "Bergstrom", "Ferraro",
    "Donnelly", "Vasquez", "Kaminski", "Oduya", "Rinaldi", "Halvorsen", "Boateng",
    "Szabo", "Lindgren", "Cavanagh", "Mahfouz", "Takahashi", "Olsen",
]
_MIDDLE_INITIALS = list("ABCDEFGHJKLMNPRSTVW")


def subs_per_day(day: datetime) -> int:
    """How many subscriptions `day` bills, compounding from the epoch.

    Weekends are thinner, which is what a consumer subscription actually looks
    like and keeps the recognition grid from reading as a synthetic flat line.
    """
    months = (day.year - SUBS_EPOCH.year) * 12 + (day.month - SUBS_EPOCH.month)
    months += (day.day - 1) / 30.0
    count = SUBS_PER_DAY_BASE * ((1.0 + SUBS_GROWTH_MONTHLY) ** max(0.0, months))
    if day.weekday() >= 5:
        count *= 0.65
    return max(1, min(SUBS_PER_DAY_CAP, round(count)))


def _rng(day: datetime, salt: str = "", generation: int = 0) -> random.Random:
    """A generator seeded from the calendar day, so a day's data never changes.

    `generation` is the escape hatch for a demo that has caught up to today:
    bumping it yields a different set of subscribers for the same date, which is
    how a sync keeps bringing new activity once there are no unimported days
    left. Generation 0 is the historical feed and never changes.
    """
    gen = f"|g{generation}" if generation else ""
    seed = hashlib.sha256(f"{day:%Y-%m-%d}|{salt}{gen}".encode()).hexdigest()
    return random.Random(int(seed[:16], 16))


def _pick_plan(rng: random.Random) -> str:
    total = sum(w for _, w in _PLAN_WEIGHTS)
    roll = rng.uniform(0, total)
    upto = 0.0
    for code, weight in _PLAN_WEIGHTS:
        upto += weight
        if roll <= upto:
            return code
    return _PLAN_WEIGHTS[-1][0]


def _subscriber(rng: random.Random, day: datetime, index: int, generation: int = 0) -> dict:
    first = rng.choice(_FIRST_NAMES)
    last = rng.choice(_LAST_NAMES)
    middle = rng.choice(_MIDDLE_INITIALS)
    gen = f"|g{generation}" if generation else ""
    digest = hashlib.sha256(f"{day:%Y-%m-%d}|{index}{gen}".encode()).hexdigest()[:10]
    return {
        "name": f"{first} {middle}. {last}",
        "email": f"{first.lower()}.{last.lower()}{digest[:3]}@example.com",
        "subscription_id": f"cb_sub_{digest}",
        "invoice_id": f"cb_inv_{digest}",
    }


def _add_months(d: datetime, n: int) -> datetime:
    """Shift by whole months, clamping the day so Jan 31 + 1mo lands in February."""
    year = d.year + (d.month - 1 + n) // 12
    month = (d.month - 1 + n) % 12 + 1
    day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return datetime(year, month, day)


# Share of eligible billings refunded under the guarantee. Kept at or just below
# chargebee_revenue_je.REFUND_RESERVE_RATE so the reserve covers actual refunds
# and the liability never goes overdrawn.
REFUND_RATE = 0.04


def _monthly_lifetime(subscription_id: str, generation: int = 0) -> int:
    """How many times a monthly subscriber renews before churning.

    Drawn once per subscriber rather than flipped each month, so a subscriber's
    run of invoices is decided at signup and never changes — the same calendar
    day always produces the same billings however often it is regenerated.
    """
    rng = _rng(SUBS_EPOCH, f"life|{subscription_id}", generation)
    u = max(1e-9, rng.random())
    return min(MAX_RENEWAL_MONTHS, int(math.log(u) / math.log(MONTHLY_RETENTION)))


def _renewals_for_day(day: datetime, generation: int = 0) -> list[dict]:
    """Monthly subscribers from earlier months billing again on `day`.

    Built from *new signups* only, never from renewals, which is what keeps this
    from recursing: a renewal is always derived from the original purchase.
    """
    out: list[dict] = []
    for k in range(1, MAX_RENEWAL_MONTHS + 1):
        origin = _add_months(day, -k)
        # _add_months clamps, so 31 Jan - 1 month is 28 Feb and adding the month
        # back does not return to 31 Jan. Skipping those keeps a subscriber from
        # being billed twice in one month.
        if _add_months(origin, k) != day:
            continue
        for sub in _new_signups_for_day(origin, generation):
            if sub["term_months"] != 1:
                continue          # an annual term renews after a year, not a month
            if k > _monthly_lifetime(sub["subscription_id"], generation):
                continue          # churned before this renewal
            digest = hashlib.sha256(
                f"{sub['subscription_id']}|renew{k}".encode()
            ).hexdigest()[:10]
            out.append({
                **sub,
                "invoice_id": f"cb_inv_{digest}",
                "billing_date": day,
                "period_start": day,
                "period_end": _add_months(day, 1) - timedelta(days=1),
                # A renewal is not a first-time purchase, so it carries no
                # money-back right — which changes the accounting, not just the
                # label: no refund reserve is taken and none is released.
                "is_renewal": True,
                "guarantee_eligible": False,
                "guarantee_expires": None,
                "will_be_refunded": False,
                "renewal_number": k,
            })
    return out


def subscriptions_for_day(day: datetime, generation: int = 0) -> list[dict]:
    """Everything billed on `day`: new signups plus monthly renewals."""
    return _new_signups_for_day(day, generation) + _renewals_for_day(day, generation)


def _new_signups_for_day(day: datetime, generation: int = 0) -> list[dict]:
    """First-time purchases billed on `day`.

    Each subscription carries its own refund fate (`will_be_refunded` and
    `_refund_after_days`). That matters beyond tidiness: the accounting has to
    know, at the moment it books a billing, whether that subscription will be
    refunded — otherwise it releases the refund reserve at day 7 *and* refunds
    it later, draining the liability twice for one subscriber.
    """
    rng = _rng(day, "subs", generation)
    out = []
    for i in range(subs_per_day(day)):
        plan_code = _pick_plan(rng)
        plan = PLANS[plan_code]
        who = _subscriber(rng, day, i, generation)
        period_start = day
        period_end = _add_months(day, plan["months"]) - timedelta(days=1)
        # Always a first-time purchase: recurrence is modelled by
        # _renewals_for_day, not by flagging a share of new rows as renewals.
        is_renewal = False
        own = _rng(day, f"refund|{who['subscription_id']}", generation)
        out.append({
            "subscription_id": who["subscription_id"],
            "invoice_id": who["invoice_id"],
            "customer_name": who["name"],
            "customer_email": who["email"],
            "plan_code": plan_code,
            "plan_label": plan["label"],
            "tier": plan["tier"],
            "amount": plan["price"],
            "billing_date": day,
            "period_start": period_start,
            "period_end": period_end,
            "term_months": plan["months"],
            "is_renewal": is_renewal,
            "guarantee_eligible": not is_renewal,
            "guarantee_expires": day + timedelta(days=GUARANTEE_DAYS) if not is_renewal else None,
            # Filled in by the pass below.
            "will_be_refunded": False,
            "_refund_after_days": own.randint(2, GUARANTEE_DAYS - 1),
            "_refund_score": own.random(),
        })

    # A plain per-subscriber chance at REFUND_RATE. This used to force at least
    # one refund every day so a single-day import always showed the guarantee
    # being exercised — which was safe only while a day billed ~30 times. On a
    # growing feed that starts at a handful of signups a day, a forced refund is
    # ~17% of billings against the 4% reserved, and the refund liability goes
    # overdrawn. A sync now covers a week, so the guarantee path still shows up
    # in every batch without having to be forced into every day.
    for sub in out:
        if sub["guarantee_eligible"] and sub["_refund_score"] < REFUND_RATE:
            sub["will_be_refunded"] = True
    return out


def refunds_for_day(day: datetime, generation: int = 0) -> list[dict]:
    """Money-back-guarantee refunds processed on `day`.

    Reads the fate already recorded on each subscription, so a subscription is
    refunded on exactly one day and the accounting can see it coming.
    """
    out: list[dict] = []
    for back in range(2, GUARANTEE_DAYS):
        for sub in _new_signups_for_day(day - timedelta(days=back), generation):
            if not (sub["will_be_refunded"] and sub["_refund_after_days"] == back):
                continue
            out.append({
                "refund_id": f"cb_cn_{sub['subscription_id'][-10:]}",
                "subscription_id": sub["subscription_id"],
                "invoice_id": sub["invoice_id"],
                "customer_name": sub["customer_name"],
                "plan_code": sub["plan_code"],
                "plan_label": sub["plan_label"],
                "tier": sub["tier"],
                "amount": sub["amount"],
                "original_billing_date": sub["billing_date"],
                "refund_date": day,
                "reason": "Money-back guarantee (within 7 days)",
                "days_after_purchase": back,
            })
    return out


def fetch_window(
    cursor: Optional[str],
    today: Optional[datetime] = None,
    generation: int = 0,
) -> dict:
    """Pull the next slice of Chargebee activity.

    `cursor` is the date already imported through ("YYYY-MM-DD"), or None for a
    first run, which backdates HISTORY_DAYS so the client opens with schedules
    already part-recognized instead of a blank page.

    Returns the events plus the new cursor to persist. Never returns future
    activity: once the cursor reaches today, an import yields nothing rather
    than inventing subscriptions that haven't happened.
    """
    now = (today or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)

    if cursor:
        try:
            start = datetime.strptime(cursor[:10], "%Y-%m-%d") + timedelta(days=1)
        except ValueError:
            start = now - timedelta(days=HISTORY_DAYS)
        end = min(start + timedelta(days=IMPORT_WINDOW_DAYS - 1), now)
    else:
        start = now - timedelta(days=HISTORY_DAYS)
        end = now

    if start > end:
        return {"subscriptions": [], "refunds": [], "cursor": cursor,
                "window_start": None, "window_end": None, "exhausted": True}

    subs: list[dict] = []
    refunds: list[dict] = []
    day = start
    while day <= end:
        subs.extend(subscriptions_for_day(day, generation))
        refunds.extend(refunds_for_day(day, generation))
        day += timedelta(days=1)

    return {
        "subscriptions": subs,
        "refunds": refunds,
        "cursor": end.strftime("%Y-%m-%d"),
        "window_start": start,
        "window_end": end,
        "exhausted": False,
    }


def catch_up_window(today: Optional[datetime] = None, generation: int = 1) -> dict:
    """A fresh batch dated today, for a demo that has imported every past day.

    A sales demo cannot be allowed to answer "nothing new" — that is the one
    screen the story does not survive. Once the cursor reaches today there are
    no unimported dates left, so a new `generation` of subscribers is minted for
    today instead: different ids, so nothing dedups against what is already
    imported, and dated today, so the activity reads as current.

    Refunds here are same-day rather than drawn from the previous week: those
    earlier days belong to generation 0 and were already imported, so refunding
    them would credit a contract that this batch never billed. Same-day
    buyer's remorse is both real and self-contained — the billing and the refund
    land in one window, and the reserve is never released for a subscription
    that is about to be refunded.
    """
    now = (today or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    subs = subscriptions_for_day(now, generation)

    # Guarantee at least one refund in a live batch. A batch is one day's
    # signups — a dozen or so — and at a true 4% most of them would contain no
    # refund at all, which hides the money-back handling that half this
    # client's accounting exists to show.
    #
    # Safe to force, because a refund only ever reverses its own subscription's
    # reserve: refund_jes debits that subscription's reserved slice and the rest
    # against its own deferred balance. Nothing else is drawn, so a higher
    # refund rate here cannot overdraw the liability. It is only unsafe when a
    # reserve is released *and* refunded, and the release is skipped for any
    # subscription already marked for refund.
    eligible = [s for s in subs if s["guarantee_eligible"]]
    if eligible and not any(s["will_be_refunded"] for s in eligible):
        min(eligible, key=lambda s: s["_refund_score"])["will_be_refunded"] = True

    refunds = [
        {
            "refund_id": f"cb_cn_{sub['subscription_id'][-10:]}",
            "subscription_id": sub["subscription_id"],
            "invoice_id": sub["invoice_id"],
            "customer_name": sub["customer_name"],
            "plan_code": sub["plan_code"],
            "plan_label": sub["plan_label"],
            "tier": sub["tier"],
            "amount": sub["amount"],
            "original_billing_date": sub["billing_date"],
            "refund_date": now,
            "reason": "Money-back guarantee (same day)",
            "days_after_purchase": 0,
        }
        for sub in subs
        if sub["will_be_refunded"]
    ]
    return {
        "subscriptions": subs,
        "refunds": refunds,
        "cursor": now.strftime("%Y-%m-%d"),
        "window_start": now,
        "window_end": now,
        "exhausted": False,
        "generation": generation,
    }


def processor_fee(gross: float, txn_count: int) -> float:
    """Chargebee/processor cut on a batch of billings."""
    return round(gross * PROCESSOR_RATE + txn_count * PROCESSOR_FIXED, 2)
