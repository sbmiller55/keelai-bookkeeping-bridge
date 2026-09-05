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

# What this endpoint is actually for: accounting policy documents and charts of
# accounts. The file picker in the UI sets accept=".pdf,.docx,.doc,.txt,.md",
# but that attribute is a convenience for the person choosing a file — it is not
# a control. Anyone can post whatever they like straight to this endpoint, so
# the same restriction has to exist here to mean anything.
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md", ".csv"}

router = APIRouter(prefix="/files", tags=["files"])


class UploadResponse(BaseModel):
    path: str
    filename: str


@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_current_user),
):
    # Check the type before reading a single byte, so a rejected file costs
    # nothing to refuse.
    original = Path(file.filename or "upload").name
    extension = Path(original).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type '{extension or original}'. Allowed: {allowed}.",
        )

    # Read in chunks and stop at the limit. `await file.read()` pulled the whole
    # body into memory *before* checking the size, so a multi-gigabyte upload
    # could exhaust the container's memory to get a 413 back.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="File too large (max 20 MB).",
            )
        chunks.append(chunk)
    contents = b"".join(chunks)

    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in original)
    unique_name = f"{uuid.uuid4().hex}_{safe_name}"

    ref = storage.upload(unique_name, contents)

    return UploadResponse(path=ref, filename=original)
