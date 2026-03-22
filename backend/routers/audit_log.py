from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas

router = APIRouter(prefix="/audit", tags=["audit_log"])


def _assert_transaction_owned(tx_id: int, user: models.User, db: Session) -> models.Transaction:
    tx = (
        db.query(models.Transaction)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Transaction.id == tx_id, models.Client.user_id == user.id)
        .first()
    )
    if not tx:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Transaction not found or access denied",
        )
    return tx


@router.get("/", response_model=List[schemas.AuditLogRead])
def list_audit_entries(
    transaction_id: Optional[int] = Query(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(models.AuditLog)
        .join(models.Transaction, models.AuditLog.transaction_id == models.Transaction.id)
        .join(models.Client, models.Transaction.client_id == models.Client.id)
        .filter(models.Client.user_id == current_user.id)
    )
    if transaction_id is not None:
        query = query.filter(models.AuditLog.transaction_id == transaction_id)
    return query.order_by(models.AuditLog.timestamp.desc()).all()


@router.post("/", response_model=schemas.AuditLogRead, status_code=status.HTTP_201_CREATED)
def create_audit_entry(
    payload: schemas.AuditLogCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_transaction_owned(payload.transaction_id, current_user, db)
    entry = models.AuditLog(**payload.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry
