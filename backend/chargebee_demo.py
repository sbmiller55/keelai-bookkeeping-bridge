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
# would bury the review queue, which is the thing being demonstrated. These keep
# an import to a batch a human can actually read down.
# Volume is set so the refund count below reconciles with the reserve rate used
# in chargebee_revenue_je: one refund a day against ~30 billings is ~3.3%, just
# under the 4% reserved, which keeps the refund liability slightly positive
# rather than overdrawn. Changing one without the other breaks that.
SUBS_PER_DAY        = 30
IMPORT_WINDOW_DAYS  = 1
HISTORY_DAYS        = 21     # posted backfill, so schedules open mid-flight

GUARANTEE_DAYS      = 7      # SuperSummary's published money-back window

# Chargebee's processing cut, applied to gross billings to produce the fee entry.
PROCESSOR_RATE      = 0.029
PROCESSOR_FIXED     = 0.30

_FIRST_NAMES = [
    "Ava", "Noah", "Maya", "Elijah", "Sofia", "Liam", "Isabel", "Mateo", "Chloe",
    "Owen", "Priya", "Jonah", "Leila", "Caleb", "Nora", "Idris", "Hana", "Felix",
    "Rosa", "Theo", "Amara", "Dmitri", "Keiko", "Omar", "Sadie", "Emeka",
]
_LAST_NAMES = [
    "Whitfield", "Okafor", "Lindqvist", "Marchetti", "Delgado", "Novak", "Abiodun",
    "Castellanos", "Thornbury", "Varga", "Nakamura", "Oyelaran", "Fairbanks",
    "Petrosyan", "Kowalski", "Mbeki", "Sandoval", "Ellsworth", "Haddad", "Quintero",
]


def _rng(day: datetime, salt: str = "") -> random.Random:
    """A generator seeded from the calendar day, so a day's data never changes."""
    seed = hashlib.sha256(f"{day:%Y-%m-%d}|{salt}".encode()).hexdigest()
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


def _subscriber(rng: random.Random, day: datetime, index: int) -> dict:
    first = rng.choice(_FIRST_NAMES)
    last = rng.choice(_LAST_NAMES)
    digest = hashlib.sha256(f"{day:%Y-%m-%d}|{index}".encode()).hexdigest()[:10]
    return {
        "name": f"{first} {last}",
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


def subscriptions_for_day(day: datetime) -> list[dict]:
    """Every new or renewed subscription billed on `day`.

    Each subscription carries its own refund fate (`will_be_refunded` and
    `_refund_after_days`). That matters beyond tidiness: the accounting has to
    know, at the moment it books a billing, whether that subscription will be
    refunded — otherwise it releases the refund reserve at day 7 *and* refunds
    it later, draining the liability twice for one subscriber.
    """
    rng = _rng(day, "subs")
    out = []
    for i in range(SUBS_PER_DAY):
        plan_code = _pick_plan(rng)
        plan = PLANS[plan_code]
        who = _subscriber(rng, day, i)
        period_start = day
        period_end = _add_months(day, plan["months"]) - timedelta(days=1)
        # A renewal is not a first-time purchase, so it carries no money-back
        # right — which changes the accounting, not just the label.
        is_renewal = rng.random() < 0.22
        own = _rng(day, f"refund|{who['subscription_id']}")
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

    # Mark the day's refunds by rank rather than by an independent coin flip per
    # subscription: a flip at REFUND_RATE leaves a single-day import showing no
    # refund roughly a third of the time, and the guarantee handling is one of
    # the things being demonstrated. Ranking keeps the rate at REFUND_RATE while
    # guaranteeing the path is exercised.
    eligible = [x for x in out if x["guarantee_eligible"]]
    n_refund = max(1, round(len(eligible) * REFUND_RATE)) if eligible else 0
    for sub in sorted(eligible, key=lambda x: x["_refund_score"])[:n_refund]:
        sub["will_be_refunded"] = True
    return out


def refunds_for_day(day: datetime) -> list[dict]:
    """Money-back-guarantee refunds processed on `day`.

    Reads the fate already recorded on each subscription, so a subscription is
    refunded on exactly one day and the accounting can see it coming.
    """
    out: list[dict] = []
    for back in range(2, GUARANTEE_DAYS):
        for sub in subscriptions_for_day(day - timedelta(days=back)):
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


def fetch_window(cursor: Optional[str], today: Optional[datetime] = None) -> dict:
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
        subs.extend(subscriptions_for_day(day))
        refunds.extend(refunds_for_day(day))
        day += timedelta(days=1)

    return {
        "subscriptions": subs,
        "refunds": refunds,
        "cursor": end.strftime("%Y-%m-%d"),
        "window_start": start,
        "window_end": end,
        "exhausted": False,
    }


def processor_fee(gross: float, txn_count: int) -> float:
    """Chargebee/processor cut on a batch of billings."""
    return round(gross * PROCESSOR_RATE + txn_count * PROCESSOR_FIXED, 2)
