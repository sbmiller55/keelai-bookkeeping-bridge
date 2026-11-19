from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas

router = APIRouter(prefix="/clients", tags=["close_checklist"])


def _get_client_or_403(client_id: int, user: models.User, db: Session) -> models.Client:
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client not found")
    return client


def _get_item_or_404(item_id: int, client_id: int, db: Session) -> models.CloseChecklistItem:
    item = (
        db.query(models.CloseChecklistItem)
        .filter(
            models.CloseChecklistItem.id == item_id,
            models.CloseChecklistItem.client_id == client_id,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return item


@router.get("/{client_id}/close-checklist", response_model=List[schemas.CloseChecklistItemRead])
def get_checklist(
    client_id: int,
    close_month: Optional[str] = Query(None),  # "2026-02"
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    items = (
        db.query(models.CloseChecklistItem)
        .filter(models.CloseChecklistItem.client_id == client_id)
        .order_by(models.CloseChecklistItem.order_index)
        .all()
    )

    if close_month:
        # Filter quarter_end items to only appear in Q-end months (Mar/Jun/Sep/Dec)
        close_month_num = int(close_month.split("-")[1]) if "-" in close_month else 0
        quarter_end_months = {3, 6, 9, 12}

        # Get completions for this month
        completions = {
            c.item_id: c.completed_at
            for c in db.query(models.CloseChecklistCompletion).filter(
                models.CloseChecklistCompletion.item_id.in_([i.id for i in items]),
                models.CloseChecklistCompletion.close_month == close_month,
            ).all()
        }

        # Get all-time completions for "once" items
        ever_completed_ids = {
            c.item_id
            for c in db.query(models.CloseChecklistCompletion).filter(
                models.CloseChecklistCompletion.item_id.in_([
                    i.id for i in items if (i.recurrence or "monthly") == "once"
                ])
            ).all()
        }

        result = []
        for item in items:
            recurrence = item.recurrence or "monthly"
            # Filter quarter_end to Q-end months only
            if recurrence == "quarter_end" and close_month_num not in quarter_end_months:
                continue
            # Filter once items that have ever been completed
            if recurrence == "once" and item.id in ever_completed_ids:
                continue
            d = schemas.CloseChecklistItemRead.model_validate(item)
            d.completed_at = completions.get(item.id)
            d.for_month = close_month
            result.append(d)

        result.extend(_outstanding_from_earlier(client_id, close_month, items, db))
        return result

    return items


# How far back to look for unfinished months. A checklist that has never been
# finished should not produce an unbounded wall of history; six months is long
# enough to cover a quarter-end that slipped and short enough to stay readable.
_CARRY_BACK_MONTHS = 6


def _month_before(month: str) -> str:
    y, m = (int(x) for x in month.split("-"))
    return "%04d-12" % (y - 1) if m == 1 else "%04d-%02d" % (y, m - 1)


def _outstanding_from_earlier(client_id: int, close_month: str, items, db) -> list:
    """Recurring tasks from earlier months that were never ticked.

    A monthly task used to roll silently onto the next month the moment that
    month began: the final payments check for October, due 30 November, became
    a December task on 1 December with nothing saying October had been left
    unfinished. A close checklist exists to catch exactly that, so an
    unfinished task stays attached to the month it was for until it is done.

    Only months the checklist was actually being used in are considered — a
    month with no completions at all was a month nobody worked, and listing
    every task from it as outstanding would bury the one task that matters.
    """
    if not close_month:
        return []
    monthly = [i for i in items if (i.recurrence or "monthly") == "monthly"]
    if not monthly:
        return []

    months = []
    cursor = _month_before(close_month)
    for _ in range(_CARRY_BACK_MONTHS):
        months.append(cursor)
        cursor = _month_before(cursor)

    rows = (
        db.query(models.CloseChecklistCompletion)
        .filter(
            models.CloseChecklistCompletion.item_id.in_([i.id for i in monthly]),
            models.CloseChecklistCompletion.close_month.in_(months),
        )
        .all()
    )
    done_by_month: dict[str, set] = {}
    for r in rows:
        done_by_month.setdefault(r.close_month, set()).add(r.item_id)

    out = []
    for month in sorted(done_by_month):          # only months with activity
        done = done_by_month[month]
        for item in monthly:
            if item.id in done:
                continue
            d = schemas.CloseChecklistItemRead.model_validate(item)
            d.completed_at = None
            d.for_month = month
            d.carried_over = True
            out.append(d)
    return out


@router.post("/{client_id}/close-checklist", response_model=schemas.CloseChecklistItemRead, status_code=status.HTTP_201_CREATED)
def create_item(
    client_id: int,
    payload: schemas.CloseChecklistItemCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    item = models.CloseChecklistItem(client_id=client_id, **payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/{client_id}/close-checklist/{item_id}", response_model=schemas.CloseChecklistItemRead)
def update_item(
    client_id: int,
    item_id: int,
    payload: schemas.CloseChecklistItemUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    item = _get_item_or_404(item_id, client_id, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{client_id}/close-checklist/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    client_id: int,
    item_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    item = _get_item_or_404(item_id, client_id, db)
    db.delete(item)
    db.commit()


@router.post("/{client_id}/close-checklist/{item_id}/complete", response_model=schemas.CloseChecklistItemRead)
def complete_item(
    client_id: int,
    item_id: int,
    payload: schemas.CompleteItemRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    item = _get_item_or_404(item_id, client_id, db)
    existing = (
        db.query(models.CloseChecklistCompletion)
        .filter(
            models.CloseChecklistCompletion.item_id == item_id,
            models.CloseChecklistCompletion.close_month == payload.close_month,
        )
        .first()
    )
    if not existing:
        completion = models.CloseChecklistCompletion(
            item_id=item_id,
            close_month=payload.close_month,
        )
        db.add(completion)
        db.commit()
        db.refresh(completion)
    d = schemas.CloseChecklistItemRead.model_validate(item)
    d.completed_at = existing.completed_at if existing else completion.completed_at
    return d


@router.delete("/{client_id}/close-checklist/{item_id}/complete/{close_month}", status_code=status.HTTP_204_NO_CONTENT)
def uncomplete_item(
    client_id: int,
    item_id: int,
    close_month: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    _get_item_or_404(item_id, client_id, db)
    db.query(models.CloseChecklistCompletion).filter(
        models.CloseChecklistCompletion.item_id == item_id,
        models.CloseChecklistCompletion.close_month == close_month,
    ).delete()
    db.commit()
