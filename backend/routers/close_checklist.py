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
            result.append(d)
        return result

    return items


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
