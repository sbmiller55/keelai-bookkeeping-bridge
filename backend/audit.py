"""
Audit trail for actions that touch financial data.

Records who did what, when, and to which client record. The table existed
before this module but only one place ever wrote to it (a journal-entry edit),
so approvals, deletions, exports to QuickBooks and credential changes left no
trace at all.

Two rules worth keeping in mind when adding new call sites:

  - Never let an audit failure break the action being audited. A missing log
    line is bad; a failed approval because logging broke is worse.
  - Never write a credential into before/after state. `_redact` drops the
    fields that hold keys and tokens — auditing a client update would
    otherwise copy the Mercury API key back into the database in plaintext,
    undoing the encryption applied everywhere else.
"""
import json
import sys
from typing import Any, Optional

import models

# Field names whose values must never reach the audit table.
_SECRET_FIELDS = {
    "mercury_api_key_encrypted", "qbo_oauth_token", "qbo_access_token",
    "qbo_refresh_token", "stripe_api_key", "billcom_password", "api_key",
    "password", "password_hash", "current_password", "new_password",
    "secret", "token",
}

_REDACTED = "<redacted>"


def _redact(state: Optional[dict]) -> Optional[dict]:
    if not state:
        return state
    out = {}
    for k, v in state.items():
        out[k] = _REDACTED if k.lower() in _SECRET_FIELDS else v
    return out


def record(
    db,
    actor_id: int,
    action: str,
    *,
    transaction_id: Optional[int] = None,
    client_id: Optional[int] = None,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
) -> None:
    """Append one audit entry. Never raises.

    The caller is responsible for committing; the row joins whatever
    transaction the caller is already in, so an action that rolls back takes
    its audit entry with it rather than claiming something that didn't happen.
    """
    try:
        db.add(models.AuditLog(
            transaction_id=transaction_id,
            client_id=client_id,
            action=action,
            before_state=json.dumps(_redact(before), default=str) if before is not None else None,
            after_state=json.dumps(_redact(after), default=str) if after is not None else None,
            actor=actor_id,
        ))
    except Exception as exc:                      # pragma: no cover - defensive
        sys.stderr.write(f"[audit] failed to record {action!r}: {exc}\n")
        sys.stderr.flush()


def snapshot(obj: Any, fields: tuple[str, ...]) -> dict:
    """Grab a few fields off a model instance for before/after comparison."""
    out = {}
    for f in fields:
        try:
            value = getattr(obj, f, None)
            out[f] = value.value if hasattr(value, "value") else value
        except Exception:
            out[f] = None
    return out
