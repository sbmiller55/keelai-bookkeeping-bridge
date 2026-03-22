from collections import defaultdict
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
import rules_engine

router = APIRouter(prefix="/rules", tags=["rules"])


def _assert_client_owned(client_id: int, user: models.User, db: Session) -> models.Client:
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client not found or access denied")
    return client


def _get_rule_or_404(rule_id: int, user: models.User, db: Session) -> models.Rule:
    rule = (
        db.query(models.Rule)
        .join(models.Client, models.Rule.client_id == models.Client.id)
        .filter(models.Rule.id == rule_id, models.Client.user_id == user.id)
        .first()
    )
    if not rule:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")
    return rule


@router.get("/", response_model=List[schemas.RuleRead])
def list_rules(
    client_id: Optional[int] = Query(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(models.Rule)
        .join(models.Client, models.Rule.client_id == models.Client.id)
        .filter(models.Client.user_id == current_user.id)
    )
    if client_id is not None:
        query = query.filter(models.Rule.client_id == client_id)
    return query.order_by(models.Rule.id.desc()).all()


@router.post("/", response_model=schemas.RuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: schemas.RuleCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_client_owned(payload.client_id, current_user, db)
    rule = models.Rule(**payload.model_dump())
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


# POST /generate must come before GET /{rule_id} to avoid path conflict
@router.post("/generate")
def generate_rules(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Scan reviewed/approved transactions for consistent coding patterns
    (same counterparty → same debit/credit accounts, 3+ occurrences)
    and auto-create rules for any that don't already have one.
    """
    _assert_client_owned(client_id, current_user, db)

    # Find reviewed/approved transactions with JEs
    txns = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == client_id,
            models.Transaction.status.in_([
                models.TransactionStatus.reviewed,
                models.TransactionStatus.approved,
                models.TransactionStatus.exported,
            ]),
        )
        .all()
    )

    # Group by counterparty → (debit, credit) → count
    pattern: dict[str, dict[tuple[str, str], int]] = defaultdict(lambda: defaultdict(int))
    for txn in txns:
        cp = (txn.counterparty_name or "").strip()
        if not cp:
            continue
        for je in txn.journal_entries:
            pattern[cp][(je.debit_account, je.credit_account)] += 1

    # Existing rules to avoid duplicates
    existing = db.query(models.Rule).filter(models.Rule.client_id == client_id).all()
    existing_keys = {(r.match_type, r.match_value.lower()) for r in existing}

    created = 0
    for cp, account_counts in pattern.items():
        best_pair, count = max(account_counts.items(), key=lambda x: x[1])
        if count < 3:
            continue
        key = ("counterparty_contains", cp.lower())
        if key in existing_keys:
            continue
        debit, credit = best_pair
        db.add(models.Rule(
            client_id=client_id,
            match_type="counterparty_contains",
            match_value=cp,
            debit_account=debit,
            credit_account=credit,
            rule_action="expense",
            active=True,
        ))
        existing_keys.add(key)
        created += 1

    db.commit()
    return {"created": created, "message": f"Generated {created} new rules from transaction patterns."}


@router.get("/{rule_id}", response_model=schemas.RuleRead)
def get_rule(
    rule_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_rule_or_404(rule_id, current_user, db)


@router.put("/{rule_id}", response_model=schemas.RuleRead)
def update_rule(
    rule_id: int,
    payload: schemas.RuleUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rule = _get_rule_or_404(rule_id, current_user, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(rule, field, value)
    db.commit()
    db.refresh(rule)
    return rule


@router.post("/{rule_id}/apply")
def apply_rule(
    rule_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply this rule to all matching pending transactions that have no JEs yet."""
    rule = _get_rule_or_404(rule_id, current_user, db)

    already_coded_ids = {
        row[0]
        for row in db.query(models.JournalEntry.transaction_id)
        .join(models.Transaction)
        .filter(models.Transaction.client_id == rule.client_id)
        .all()
    }

    pending = (
        db.query(models.Transaction)
        .filter(
            models.Transaction.client_id == rule.client_id,
            models.Transaction.status == models.TransactionStatus.pending,
        )
        .all()
    )

    applied = 0
    for txn in pending:
        if txn.id in already_coded_ids:
            continue
        if rules_engine.match_rule(txn, [rule]):
            for jd in rules_engine.apply_rule_jes(rule, txn):
                db.add(models.JournalEntry(
                    je_number=models.next_je_number(db),
                    transaction_id=txn.id,
                    debit_account=jd["debit_account"],
                    credit_account=jd["credit_account"],
                    amount=abs(jd.get("amount", txn.amount)),
                    je_date=jd.get("je_date"),
                    memo=jd.get("memo"),
                    rule_applied=rule.id,
                    ai_confidence=jd.get("ai_confidence", 1.0),
                    ai_reasoning=jd.get("ai_reasoning"),
                    is_recurring=jd.get("is_recurring", False),
                    recur_frequency=jd.get("recur_frequency"),
                    recur_end_date=jd.get("recur_end_date"),
                ))
            applied += 1

    db.commit()
    return {"applied": applied, "message": f"Rule applied to {applied} pending transactions."}


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(
    rule_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rule = _get_rule_or_404(rule_id, current_user, db)
    db.delete(rule)
    db.commit()
