import csv
import io
from pathlib import Path
from typing import List


def _extract_text_from_file(path: Path) -> str:
    """Extract plain text from .pdf, .docx, or text files."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".pdf":
            import pdfplumber
            parts = []
            with pdfplumber.open(path) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        parts.append(t)
            return "\n".join(parts)
        elif suffix in (".docx", ".doc"):
            import docx
            doc = docx.Document(path)
            return "\n".join(p.text for p in doc.paragraphs)
        else:
            return path.read_text(errors="replace")
    except Exception:
        return ""


def _extract_accounts_from_pdf(path: Path) -> list[str]:
    """Extract account names from a QBO-style Chart of Accounts PDF table."""
    try:
        import pdfplumber
        accounts: list[str] = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if not row or len(row) < 2:
                            continue
                        name_cell = row[1]  # "Name" is the second column
                        if not name_cell:
                            continue
                        # Join multiline cell text, detecting mid-word splits.
                        # Join without space when the previous fragment looks like an
                        # incomplete word (ends with a consonant cluster unlikely to end
                        # a word) and the next fragment starts with a short lowercase run.
                        _VOWELS = set("aeiou")
                        parts = name_cell.split("\n")
                        joined = parts[0]
                        for part in parts[1:]:
                            stripped = part.strip()
                            if not stripped:
                                continue
                            first_token = stripped.split()[0] if stripped.split() else ""
                            # Heuristic: join without space only when prev fragment ends
                            # with a consonant AND the next fragment's leading token is
                            # all-lowercase and <= 3 chars (suffix fragment like "ed","n","ion")
                            # but exclude common English words ("in","is","of","to","at").
                            _COMMON_WORDS = {"in", "is", "of", "to", "at", "on", "an", "as", "or", "and", "the", "by", "for"}
                            prev_last = joined[-1] if joined else ""
                            is_suffix = (
                                first_token
                                and len(first_token) <= 3
                                and first_token.islower()
                                and first_token not in _COMMON_WORDS
                                and prev_last.islower()
                                and prev_last not in _VOWELS
                            )
                            if is_suffix:
                                joined += stripped
                            else:
                                joined += " " + stripped
                        name = " ".join(joined.split()).strip()
                        # Skip header row
                        if name.lower() in ("name", "account", ""):
                            continue
                        accounts.append(name)
        return sorted(set(accounts))
    except Exception:
        return []

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
import storage

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
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(client, field, value)
    db.commit()
    db.refresh(client)
    return client


@router.get("/{client_id}/accounts", response_model=List[str])
def get_chart_of_accounts(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Parse the client's Chart of Accounts file and return a list of account names."""
    client = _get_client_or_404(client_id, current_user, db)
    if not client.chart_of_accounts_path:
        return []

    with storage.as_local_path(client.chart_of_accounts_path) as path:
        if not path:
            return []

        # PDF: extract table rows
        if path.suffix.lower() == ".pdf":
            result = _extract_accounts_from_pdf(path)
            if result:
                return result

        # Try reading as text
        text = _extract_text_from_file(path)
        if not text:
            return []

        accounts: list[str] = []

        # Try CSV first
        try:
            reader = csv.DictReader(io.StringIO(text))
            name_cols = [c for c in (reader.fieldnames or [])
                         if any(k in c.lower() for k in ("name", "account", "description", "title"))]
            if name_cols:
                col = name_cols[0]
                for row in reader:
                    val = (row.get(col) or "").strip()
                    if val:
                        accounts.append(val)
                if accounts:
                    return sorted(set(accounts))
        except Exception:
            pass

        # Fallback: one account per line
        for line in text.splitlines():
            line = line.strip().strip(",").strip('"').strip()
            if line and not line.startswith("#"):
                accounts.append(line)

        return sorted(set(accounts)) if accounts else []


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_client(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client = _get_client_or_404(client_id, current_user, db)
    db.delete(client)
    db.commit()
