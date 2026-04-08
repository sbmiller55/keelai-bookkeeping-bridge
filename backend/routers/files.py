"""File upload endpoint — stores uploads via storage abstraction (local or S3)."""
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from auth import get_current_user
import models
import storage

# 20 MB limit
MAX_BYTES = 20 * 1024 * 1024

router = APIRouter(prefix="/files", tags=["files"])


class UploadResponse(BaseModel):
    path: str
    filename: str


@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_current_user),
):
    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File too large (max 20 MB).",
        )

    original = Path(file.filename or "upload").name
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in original)
    unique_name = f"{uuid.uuid4().hex}_{safe_name}"

    ref = storage.upload(unique_name, contents)

    return UploadResponse(path=ref, filename=original)
