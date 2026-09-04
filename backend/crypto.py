"""
Encryption at rest for stored third-party credentials.

The credentials this app holds — a Mercury API key, QBO OAuth tokens, Stripe
and Bill.com keys — are live access to a client's bank and books. They used to
sit in the database as plaintext (the column named `mercury_api_key_encrypted`
was never actually encrypted), which made a database dump or a single nightly
S3 backup file equivalent to handing over the bank connection.

`EncryptedText` is a drop-in column type that fixes that without touching a
single call site: values are Fernet-encrypted on the way in and decrypted on
the way out, so application code keeps reading and writing plain strings.

Two deliberate compatibility choices:

  - Rows written before this existed are plaintext. Decryption therefore only
    applies to values carrying the ENC_PREFIX; anything else is passed through
    untouched and gets encrypted the next time it's written. `encrypt_existing_rows`
    does that rewrite in bulk at startup.
  - If ENCRYPTION_KEY is unset the type degrades to plaintext pass-through
    rather than refusing to start. Bricking a running production app is the
    worse failure; the missing key is reported loudly at startup instead.
"""
import os
import sys
from typing import Optional

from sqlalchemy import Text, TypeDecorator

ENC_PREFIX = "enc:v1:"

_ENV_VAR = "ENCRYPTION_KEY"


def _fernet():
    """Return a Fernet built from ENCRYPTION_KEY, or None when unconfigured."""
    key = os.getenv(_ENV_VAR, "").strip()
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception as exc:            # malformed key — treat as unconfigured
        sys.stderr.write(f"[crypto] {_ENV_VAR} is set but unusable: {exc}\n")
        sys.stderr.flush()
        return None


def is_configured() -> bool:
    return _fernet() is not None


def encrypt(value: Optional[str]) -> Optional[str]:
    """Encrypt a plain string. Returns it unchanged if already encrypted or
    if no key is configured."""
    if value is None or value == "":
        return value
    if value.startswith(ENC_PREFIX):
        return value                    # already encrypted
    f = _fernet()
    if f is None:
        return value
    return ENC_PREFIX + f.encrypt(value.encode()).decode()


def decrypt(value: Optional[str]) -> Optional[str]:
    """Decrypt a stored value. Legacy plaintext is returned as-is."""
    if value is None or value == "":
        return value
    if not value.startswith(ENC_PREFIX):
        return value                    # legacy plaintext row
    f = _fernet()
    if f is None:
        # Encrypted data but no key: don't hand back ciphertext that would be
        # used as a credential and silently fail against the vendor API.
        raise RuntimeError(
            f"{_ENV_VAR} is not set but encrypted credentials exist. "
            "Restore the key to read them."
        )
    token = value[len(ENC_PREFIX):]
    return f.decrypt(token.encode()).decode()


class EncryptedText(TypeDecorator):
    """Text column that is Fernet-encrypted at rest and plain in Python."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return encrypt(value)

    def process_result_value(self, value, dialect):
        return decrypt(value)


def encrypt_existing_rows(db) -> int:
    """Rewrite any legacy plaintext credential so it lands encrypted.

    Idempotent: rows already carrying ENC_PREFIX decrypt to themselves and are
    re-encrypted to the same plaintext, so re-running changes nothing. Returns
    the number of column values converted.
    """
    if not is_configured():
        return 0

    import models
    from sqlalchemy import text as _text

    # Work at the raw-SQL level: going through the ORM would decrypt on read and
    # re-encrypt on write, making "is this already encrypted?" invisible.
    targets = [
        ("clients", "mercury_api_key_encrypted"),
        ("clients", "qbo_oauth_token"),
        ("clients", "qbo_access_token"),
        ("clients", "qbo_refresh_token"),
        ("revenue_integration_settings", "stripe_api_key"),
        ("revenue_integration_settings", "billcom_password"),
        ("stripe_config", "api_key"),
    ]

    converted = 0
    insp = None
    try:
        from sqlalchemy import inspect as _inspect
        insp = _inspect(db.get_bind())
        existing_tables = set(insp.get_table_names())
    except Exception:
        existing_tables = None

    for table, column in targets:
        if existing_tables is not None and table not in existing_tables:
            continue
        try:
            rows = db.execute(
                _text(f"SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''")
            ).all()
        except Exception:
            continue                     # table/column not present in this DB
        for row_id, value in rows:
            if value is None or str(value).startswith(ENC_PREFIX):
                continue
            db.execute(
                _text(f"UPDATE {table} SET {column} = :v WHERE id = :i"),
                {"v": encrypt(str(value)), "i": row_id},
            )
            converted += 1

    if converted:
        db.commit()
    return converted
