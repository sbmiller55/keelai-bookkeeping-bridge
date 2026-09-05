from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
import storage
import audit

router = APIRouter(prefix="/clients", tags=["clients"])


def _get_client_or_404(client_id: int, user: models.User, db: Session) -> models.Client:
    client = (
        db.query(models.Client)
        .filter(models.Client.id == client_id, models.Client.user_id == user.id)
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    return client


@router.get("/", response_model=List[schemas.ClientRead])
def list_clients(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return (
        db.query(models.Client)
        .filter(models.Client.user_id == current_user.id)
        .all()
    )


@router.post("/", response_model=schemas.ClientRead, status_code=status.HTTP_201_CREATED)
def create_client(
    payload: schemas.ClientCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client = models.Client(user_id=current_user.id, **payload.model_dump())
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


@router.get("/{client_id}", response_model=schemas.ClientRead)
def get_client(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_client_or_404(client_id, current_user, db)


@router.put("/{client_id}", response_model=schemas.ClientRead)
def update_client(
    client_id: int,
    payload: schemas.ClientUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client = _get_client_or_404(client_id, current_user, db)
    incoming = payload.model_dump(exclude_unset=True)
    before_state = audit.snapshot(client, tuple(incoming.keys()))
    changed_fields: dict[str, bool] = {}
    for field, value in incoming.items():
        # Reads return SECRET_MASK in place of stored credentials; a form that
        # round-trips an untouched field would otherwise overwrite the real key
        # with the mask and silently break the integration.
        if value == schemas.SECRET_MASK:
            continue
        # File references are read back into AI prompts, so they must stay
        # inside the uploads area. Rejected here as well as at read time, so a
        # bad value can't sit in the database looking legitimate.
        if field in ("policy_path", "chart_of_accounts_path") and value:
            if not storage.is_allowed_ref(value):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{field} must reference a file uploaded through this app.",
                )
        changed_fields[field] = True
        setattr(client, field, value)

    if changed_fields:
        # Field names only for credentials — audit.record redacts the values,
        # so the trail shows that a key was replaced without storing it.
        audit.record(
            db, current_user.id, "client_updated",
            client_id=client.id,
            before=before_state,
            after=audit.snapshot(client, tuple(changed_fields)),
        )
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_client(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client = _get_client_or_404(client_id, current_user, db)
    db.delete(client)
    db.commit()
