"""Shared rules matching and application logic."""
import json
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

import models
import ai_coder

# Mercury internal account name fragments — both sides of a transfer have these as counterparties
_MERCURY_INTERNAL = ("mercury checking", "mercury credit", "mercury treasury", "mercury savings")
# Mercury transaction kinds that always produce two-sided duplicates
_TRANSFER_KINDS = {"treasurytransfer", "creditcardpayment", "intraaccounttransfer", "externaltransfer"}


def match_rule(txn: models.Transaction, rules: list[models.Rule]) -> Optional[models.Rule]:
    """Return first active rule that matches this transaction, or None."""
    desc = (txn.description or "").lower()
    counterparty = (txn.counterparty_name or "").lower()
    category = (txn.mercury_category or "").lower()

    for rule in rules:
        if not rule.active:
            continue
        v = rule.match_value
        mt = rule.match_type
        if mt == "description_contains" and v.lower() in desc:
            return rule
        if mt == "description_exact" and v.lower() == desc:
            return rule
        if mt == "counterparty_contains" and v.lower() in counterparty:
            return rule
        if mt == "counterparty_exact" and v.lower() == counterparty:
            return rule
        if mt == "category_equals" and v.lower() == category:
            return rule
        if mt == "has_category" and category:
            return rule
        if mt == "kind" and v == (txn.kind or ""):
            return rule
        if mt == "amount_gt":
            try:
                if txn.amount > float(v):
                    return rule
            except ValueError:
                pass
        if mt == "amount_lt":
            try:
                if txn.amount < float(v):
                    return rule
            except ValueError:
                pass
    return None


def apply_rule_jes(rule: models.Rule, txn: models.Transaction) -> list[dict]:
    """
    Build journal entry dicts for a transaction matched by a rule.
    Dispatches to generate_prepaid_jes / generate_asset_jes based on rule_action.
    """
    action = rule.rule_action or "expense"
    amount = abs(txn.amount)
    reasoning = f"Matched rule: {rule.match_type}={rule.match_value!r}"
    source_account = txn.mercury_account_name or "Uncoded"

    def _res(val: str) -> str:
        if val == "$category":
            return txn.mercury_category or "Uncoded"
        if val == "$source_account":
            return source_account
        return val

    if action == "prepaid":
        meta = _parse_metadata(rule.rule_metadata)
        service_start = ai_coder._parse_month(meta.get("service_start", "")) or txn.date.replace(day=1)
        service_end = ai_coder._parse_month(meta.get("service_end", "")) or ai_coder._add_months(service_start, 11)
        expense_account = _res(meta.get("expense_account") or rule.debit_account)
        prepaid_account = _res(meta.get("prepaid_account") or rule.credit_account)
        bank_account = _res(meta.get("bank_account", "$source_account"))
        return ai_coder.generate_prepaid_jes(
            total_amount=amount,
            payment_date=txn.date,
            bank_account=bank_account,
            expense_account=expense_account,
            prepaid_account=prepaid_account,
            service_start=service_start,
            service_end=service_end,
            vendor=txn.counterparty_name or txn.description,
            confidence=1.0,
            reasoning=reasoning,
        )

    if action == "fixed_asset":
        meta = _parse_metadata(rule.rule_metadata)
        asset_account = _res(meta.get("asset_account") or rule.debit_account)
        bank_account = _res(meta.get("bank_account", "$source_account"))
        accumulated_account = meta.get("accumulated_account", "Accumulated Depreciation")
        depreciation_account = meta.get("depreciation_account", "Depreciation Expense")
        useful_life_months = int(meta.get("useful_life_months") or 60)
        gaap_basis = meta.get("gaap_basis", "Straight-line per GAAP")
        return ai_coder.generate_asset_jes(
            total_amount=amount,
            purchase_date=txn.date,
            bank_account=bank_account,
            asset_account=asset_account,
            accumulated_account=accumulated_account,
            depreciation_account=depreciation_account,
            useful_life_months=useful_life_months,
            vendor=txn.counterparty_name or txn.description,
            gaap_basis=gaap_basis,
            confidence=1.0,
            reasoning=reasoning,
        )

    # Resolve placeholders:
    #   $category     → txn.mercury_category
    #   $source_account → txn.mercury_account_name (the Mercury account the txn came from)
    #                     = credit card liability for CC charges, checking for ACH
    def _resolve(val: str) -> str:
        if val == "$category":
            return txn.mercury_category or "Uncoded"
        if val == "$source_account":
            return txn.mercury_account_name or "Uncoded"
        return val

    debit = _resolve(rule.debit_account)
    credit = _resolve(rule.credit_account)

    # If either account couldn't be resolved, skip the rule and let AI handle it
    if debit == "Uncoded" or credit == "Uncoded":
        return []

    # Default: simple expense JE
    return [{
        "debit_account": debit,
        "credit_account": credit,
        "amount": amount,
        "je_date": txn.date,
        "memo": (txn.description or "")[:80],
        "ai_confidence": 1.0,
        "ai_reasoning": reasoning,
        "is_recurring": False,
    }]


def detect_and_merge_transfers(db, client_id: int) -> int:
    """
    Find pairs of transactions Mercury creates for the same internal transfer
    (CC payments, treasury sweeps, inter-account moves) and mark the receiving/
    positive side as status='transfer' so it never appears in the review queue
    or export.  The outflow (negative) side keeps its journal entry.

    Returns the number of transactions marked as transfer.
    """
    # Load all non-exported, non-rejected transactions for this client
    txns = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status.notin_([
                models.TransactionStatus.exported,
                models.TransactionStatus.rejected,
            ]),
        )
        .all()
    )

    # Group by (description, rounded abs amount) — Mercury uses the same description for both sides
    groups: dict = defaultdict(list)
    for txn in txns:
        key = (
            (txn.description or "").strip().lower(),
            round(abs(txn.amount), 2),
        )
        groups[key].append(txn)

    marked = 0
    for key, group in groups.items():
        if len(group) < 2:
            continue

        positives = [t for t in group if t.amount > 0]
        negatives = [t for t in group if t.amount < 0]
        if not positives or not negatives:
            continue

        for pos in positives:
            for neg in negatives:
                # Must be within 2 days of each other
                pos_date = pos.date if isinstance(pos.date, datetime) else datetime.fromisoformat(str(pos.date))
                neg_date = neg.date if isinstance(neg.date, datetime) else datetime.fromisoformat(str(neg.date))
                if abs((pos_date - neg_date).days) > 2:
                    continue

                # Must be an identifiable internal transfer
                pos_cp = (pos.counterparty_name or "").lower()
                neg_cp = (neg.counterparty_name or "").lower()
                pos_kind = (pos.kind or "").lower()
                neg_kind = (neg.kind or "").lower()

                is_internal = (
                    pos_kind in _TRANSFER_KINDS
                    or neg_kind in _TRANSFER_KINDS
                    or any(m in pos_cp for m in _MERCURY_INTERNAL)
                    or any(m in neg_cp for m in _MERCURY_INTERNAL)
                )
                if not is_internal:
                    continue

                # Mark the positive (receiving) side as transfer if not already
                if pos.status != models.TransactionStatus.transfer:
                    # Remove any JEs on this transaction — the negative side holds the real JE
                    for je in list(pos.journal_entries):
                        db.delete(je)
                    pos.status = models.TransactionStatus.transfer
                    marked += 1

    db.commit()
    return marked


def _parse_metadata(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}
