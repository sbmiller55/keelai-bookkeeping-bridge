import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import get_db
import models

def _load_secret_key() -> str:
    """The JWT signing key, which must never fall back to a published constant.

    This used to default to a literal string committed to the repo — and the
    repo is public. It is set correctly in production, so nothing was
    exploitable, but a missing or mistyped env var would have silently signed
    tokens with a key anyone could read, letting them mint a token for any user.

    Deployed environments now refuse to start without it. Local development
    without one gets a random per-process key: logins don't survive a restart,
    which is mildly annoying and infinitely better than a known secret. Set
    SECRET_KEY in backend/.env for a stable local session.
    """
    key = os.getenv("SECRET_KEY", "").strip()
    if key:
        return key

    deployed = any(
        os.getenv(v) for v in ("RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_PROJECT_ID")
    )
    if deployed:
        raise RuntimeError(
            "SECRET_KEY is not set. Refusing to start: tokens signed with a "
            "default key would be forgeable by anyone."
        )

    import secrets as _secrets
    import sys
    generated = _secrets.token_urlsafe(48)
    sys.stderr.write(
        "[auth] WARNING: SECRET_KEY is not set — using a random key for this "
        "process. Sessions will not survive a restart. Set SECRET_KEY in "
        "backend/.env for stable local development.\n"
    )
    sys.stderr.flush()
    return generated


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"

# Sessions time out after 30 minutes of inactivity, not 30 minutes flat: the
# frontend swaps an expired token for a fresh one whenever a request comes back
# 401, so anyone actively using the app keeps rolling forward and never sees a
# login screen. Go quiet for longer than the window and the token can no longer
# be exchanged, so the next action requires signing in again.
#
# The window is the token lifetime, and the refresh grace in routers/auth.py is
# only the slack needed for a request already in flight when it lapses. Raising
# one without the other silently lengthens the real timeout.
SESSION_IDLE_MINUTES = int(os.getenv("SESSION_IDLE_MINUTES", "30"))
ACCESS_TOKEN_EXPIRE_MINUTES = SESSION_IDLE_MINUTES

# Pin the work factor rather than inheriting passlib's default. The default is
# currently 12, but it is a library default: a dependency bump could silently
# lower the cost of every new hash. Existing hashes carry their own cost in the
# string, so raising this later only affects passwords set from then on.
BCRYPT_ROUNDS = 12
pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=BCRYPT_ROUNDS,
)
bearer_scheme = HTTPBearer()


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta if expires_delta else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


REFRESHED_TOKEN_HEADER = "X-Refreshed-Token"


def get_current_user(
    response: Response,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: Optional[int] = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(models.User).filter(models.User.id == int(user_id)).first()
    if user is None:
        raise credentials_exception

    # Slide the session forward on every authenticated request. Without this the
    # token would simply die 30 minutes after sign-in regardless of what the
    # user was doing, which is a fixed session length, not an idle timeout. The
    # client swaps in this token, so its expiry always sits 30 minutes after the
    # last thing the user actually did.
    try:
        response.headers[REFRESHED_TOKEN_HEADER] = create_access_token({"sub": str(user.id)})
    except Exception:
        pass    # never fail a request because the sliding token couldn't be set

    return user
