import os
from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database import get_db
import ratelimit
import models
import schemas
from auth import (
    ALGORITHM,
    SECRET_KEY,
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Login throttling ─────────────────────────────────────────────────────────
# Without this, /login accepts unlimited password guesses against a known email
# address, which is the cheapest way into the app. Counters are per (IP, email)
# and in-process: they reset on redeploy and aren't shared across replicas, so
# this slows credential stuffing rather than defeating a determined attacker.
# It costs nothing and needs no extra infrastructure; move to Redis if the
# service is ever scaled horizontally.
_MAX_ATTEMPTS   = 8           # failures allowed inside the window
_WINDOW_SECONDS = 15 * 60     # rolling window and lockout length
_login_failures: dict[tuple[str, str], list[float]] = {}

# A real bcrypt hash of a value nobody knows, used only to burn the same CPU
# time as a genuine check when the email doesn't exist.
_DUMMY_HASH = hash_password(os.urandom(16).hex())

# How long after a token expires it may still be exchanged for a fresh one.
_REFRESH_GRACE_SECONDS = 7 * 24 * 60 * 60


def _throttle_key(request: Request, email: str) -> tuple[str, str]:
    client = request.client.host if request.client else "unknown"
    # Trust the proxy's client IP when present — Railway terminates TLS upstream.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        client = forwarded.split(",")[0].strip()
    return (client, (email or "").lower())


def _check_login_allowed(request: Request, email: str) -> None:
    import time
    now = time.time()
    key = _throttle_key(request, email)
    recent = [t for t in _login_failures.get(key, []) if now - t < _WINDOW_SECONDS]
    _login_failures[key] = recent
    if len(recent) >= _MAX_ATTEMPTS:
        retry_in = int(_WINDOW_SECONDS - (now - recent[0]))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed sign-in attempts. Try again in {max(retry_in // 60, 1)} minute(s).",
            headers={"Retry-After": str(max(retry_in, 1))},
        )


def _record_login_failure(request: Request, email: str) -> None:
    import time
    key = _throttle_key(request, email)
    _login_failures.setdefault(key, []).append(time.time())
    # Keep the dict from growing without bound on a long-running process.
    if len(_login_failures) > 5000:
        now = time.time()
        for k in [k for k, v in _login_failures.items()
                  if not any(now - t < _WINDOW_SECONDS for t in v)]:
            _login_failures.pop(k, None)


@router.post("/register", response_model=schemas.Token, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.UserCreate, request: Request, db: Session = Depends(get_db)):
    # Registration was open to the entire internet. Every account created can
    # spend real money (each AI coding call bills Anthropic), so it is closed
    # unless deliberately opened. The admin account is seeded at startup and
    # does not need this endpoint. Set ALLOW_REGISTRATION=true to reopen.
    if os.getenv("ALLOW_REGISTRATION", "").strip().lower() not in ("1", "true", "yes"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Registration is closed. Contact the account owner for access.",
        )
    _check_login_allowed(request, payload.email)
    existing = db.query(models.User).filter(models.User.email == payload.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    user = models.User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        name=payload.name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token({"sub": str(user.id)})
    return schemas.Token(
        access_token=token,
        token_type="bearer",
        user=schemas.UserRead.model_validate(user),
    )


@router.post("/login", response_model=schemas.Token)
def login(payload: schemas.LoginRequest, request: Request, db: Session = Depends(get_db)):
    _check_login_allowed(request, payload.email)
    user = db.query(models.User).filter(models.User.email == payload.email).first()
    if user is None:
        # Spend the same time as a real verify would, so response timing can't
        # be used to work out which email addresses have accounts.
        verify_password(payload.password, _DUMMY_HASH)
    if not user or not verify_password(payload.password, user.password_hash):
        _record_login_failure(request, payload.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    _login_failures.pop(_throttle_key(request, payload.email), None)
    token = create_access_token({"sub": str(user.id)})
    return schemas.Token(
        access_token=token,
        token_type="bearer",
        user=schemas.UserRead.model_validate(user),
    )


@router.post("/refresh", response_model=schemas.Token)
def refresh_token(request: Request, db: Session = Depends(get_db)):
    """Issue a fresh token. Accepts expired tokens so users are never stuck at login."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    token = auth_header[7:]
    try:
        # Verify signature but ignore expiration — this is what makes refresh work
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], options={"verify_exp": False})
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Refresh used to accept a token of any age, so the 30-day expiry was really
    # no expiry at all: anything ever leaked could be renewed indefinitely.
    # Expired tokens are still accepted — that's the point, users shouldn't be
    # bounced to the login screen — but only for a grace period after expiry.
    exp = payload.get("exp")
    if exp is not None:
        import time
        expired_for = time.time() - float(exp)
        if expired_for > _REFRESH_GRACE_SECONDS:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session expired. Please sign in again.",
            )

    user = db.query(models.User).filter(models.User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    new_token = create_access_token({"sub": str(user.id)})
    return schemas.Token(
        access_token=new_token,
        token_type="bearer",
        user=schemas.UserRead.model_validate(user),
    )


@router.get("/me", response_model=schemas.UserRead)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.post("/change-password")
def change_password(
    payload: schemas.PasswordChangeRequest,
    request: Request,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change your own password. There was previously no way to do this at all,
    so a password believed to be compromised could not be replaced in-app."""
    # Throttled as well as authenticated: a stolen token shouldn't let someone
    # guess the current password at speed to lock the real owner out.
    ratelimit.guard(
        request, "change_password", max_hits=10, window=900,
        message="Too many attempts. Try again later.",
    )
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect.",
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from the current one.",
        )
    current_user.password_hash = hash_password(payload.new_password)
    db.commit()
    # Tokens carry no password state, so previously issued ones stay valid.
    return {"ok": True, "note": "Password updated. Existing sessions remain signed in."}
