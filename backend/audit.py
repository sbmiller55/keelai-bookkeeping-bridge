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


# ── Automatic trail ──────────────────────────────────────────────────────────
#
# Everything above is a call site someone has to remember to add. Four routers
# had them and nine did not, so creating a fixed asset, releasing an accrual or
# editing a rule left no trace — the fixed-asset table had zero audit rows for
# its entire history, which is how a $7,213.19 asset could be created with no
# journal entry and nothing to show what happened.
#
# This records every insert, update and delete on the financial tables straight
# from the session flush, so a new endpoint is covered the day it is written
# rather than the day someone remembers to instrument it. Hand-written
# `record()` calls still stand where a row change does not describe the action
# well ("exported to QuickBooks" is more useful than "journal_entries.id 5231
# changed").

import contextvars
from typing import Iterable

# Set per request by the middleware in main.py. A background job or a script
# has no actor, and None is recorded honestly rather than blamed on someone.
_actor: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar("audit_actor", default=None)
_source: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("audit_source", default=None)


def set_actor(actor_id: Optional[int], source: Optional[str] = None) -> None:
    _actor.set(actor_id)
    _source.set(source)


def current_actor() -> Optional[int]:
    return _actor.get()


# Tables worth a trail: anything that is money, a rule that decides money, or a
# credential. Deliberately excluded are the high-volume importer tables — a
# Mercury sync writes hundreds of transactions at once and logging each one
# would bury the edits a person actually made. Transactions are still audited
# on UPDATE (a status change, a recode), just not on bulk INSERT.
_AUDITED = {
    "fixed_assets", "accrued_expenses", "standing_accrual_rules",
    "journal_entries", "rules", "clients", "revenue_contracts",
    "revenue_schedule_entries", "revenue_streams", "stripe_config",
    "revenue_integration_settings", "close_checklist_items", "invoices",
    "users", "transactions",
}
_INSERT_EXEMPT = {"transactions", "journal_entries"}

_MAX_FIELD = 300


def _row_state(obj) -> dict:
    """Column values for one row, secrets redacted and long text trimmed."""
    out = {}
    try:
        for col in obj.__table__.columns:
            value = getattr(obj, col.name, None)
            if hasattr(value, "value"):
                value = value.value
            if isinstance(value, str) and len(value) > _MAX_FIELD:
                value = value[:_MAX_FIELD] + "…"
            out[col.name] = value
    except Exception:
        pass
    return _redact(out)


def _stored_row(session, obj) -> dict:
    """The row as the database currently holds it, read inside this flush.

    Needed because a committed object is expired, and assigning to an expired
    attribute overwrites it without ever loading what was there — so the
    session genuinely does not know the old value. before_flush runs before the
    UPDATE is emitted, so a plain SELECT here still sees the previous state.
    One extra read per edited row, on edits only; the bulk importer paths are
    excluded from auditing entirely.
    """
    try:
        from sqlalchemy import select
        table = obj.__table__
        pk = getattr(obj, "id", None)
        if pk is None:
            return {}
        row = session.connection().execute(
            select(table).where(table.c.id == pk)
        ).mappings().first()
        return dict(row) if row else {}
    except Exception:
        return {}


def _changed_fields(obj, session=None) -> Optional[dict]:
    """{field: (before, after)} for an update, or None when nothing really changed.

    PASSIVE_OFF matters: after a commit SQLAlchemy expires the object, so the
    first assignment that follows has no loaded old value and the history comes
    back with an empty `deleted`. That recorded every edit as "before: nothing",
    and — worse — made a no-op assignment look like a change, filling the trail
    with rows saying nothing happened. PASSIVE_OFF loads the old value first.

    Returns raw values. Redaction happens after the pairs are split apart, not
    here: redacting a {field: (before, after)} map replaces the pair itself with
    a string, and the caller then indexes into that string and stores "<".
    """
    try:
        from sqlalchemy import inspect as _inspect
        from sqlalchemy.orm.attributes import get_history
        from sqlalchemy.orm.base import PASSIVE_OFF

        insp = _inspect(obj)
        changes = {}
        stored = None                     # read lazily, only if something needs it
        for attr in insp.mapper.column_attrs:
            hist = get_history(obj, attr.key, PASSIVE_OFF)
            if not hist.has_changes():
                continue
            before = hist.deleted[0] if hist.deleted else None
            after = hist.added[0] if hist.added else None
            if before is None and session is not None:
                if stored is None:
                    stored = _stored_row(session, obj)
                before = stored.get(attr.key)
            if hasattr(before, "value"):
                before = before.value
            if hasattr(after, "value"):
                after = after.value
            if before == after:
                continue                  # assigned, but to the same value
            changes[attr.key] = (before, after)
        return changes or None
    except Exception:
        return None


def _trim(state: Optional[dict]) -> Optional[dict]:
    if not state:
        return state
    return {
        k: (v[:_MAX_FIELD] + "\u2026" if isinstance(v, str) and len(v) > _MAX_FIELD else v)
        for k, v in state.items()
    }


def _client_of(obj) -> Optional[int]:
    for field in ("client_id",):
        value = getattr(obj, field, None)
        if isinstance(value, int):
            return value
    return None


def _entries_for(session, objects: Iterable, verb: str) -> list:
    rows = []
    for obj in objects:
        table = getattr(getattr(obj, "__table__", None), "name", None)
        if table is None or table not in _AUDITED:
            continue
        if verb == "insert" and table in _INSERT_EXEMPT:
            continue
        before = after = None
        if verb == "insert":
            after = _row_state(obj)
        elif verb == "delete":
            before = _row_state(obj)
        else:
            changed = _changed_fields(obj, session)
            if not changed:
                continue
            # Split first, redact second — see _changed_fields.
            before = _trim(_redact({k: v[0] for k, v in changed.items()}))
            after = _trim(_redact({k: v[1] for k, v in changed.items()}))
        rows.append(models.AuditLog(
            transaction_id=getattr(obj, "id", None) if table == "transactions" else getattr(obj, "transaction_id", None),
            client_id=_client_of(obj),
            action=f"{table}.{verb}",
            before_state=json.dumps(before, default=str) if before is not None else None,
            after_state=json.dumps(after, default=str) if after is not None else None,
            actor=_actor.get(),
        ))
    return rows


def install(session_factory=None) -> None:
    """Start recording. Safe to call more than once.

    Listens on SQLAlchemy's Session class rather than one sessionmaker, so
    every session in the process is covered — the web app, the scheduler, and
    a maintenance script run by hand. That last one is not a detail: the
    listener used to be installed only by main.py, so a change made from a
    script left no trace at all, which is precisely what made one asset's
    history unexplainable after the fact. A trail with a hole where the
    privileged writes go is not a trail.
    """
    from sqlalchemy import event
    from sqlalchemy.orm import Session as _Session

    if getattr(install, "_installed", False):
        return
    install._installed = True

    target = session_factory if session_factory is not None else _Session

    @event.listens_for(target, "before_flush")
    def _before_flush(session, flush_context, instances):  # noqa: ANN001
        try:
            rows = (
                _entries_for(session, session.new, "insert")
                + _entries_for(session, session.dirty, "update")
                + _entries_for(session, session.deleted, "delete")
            )
            for row in rows:
                session.add(row)
        except Exception as exc:                  # never break the write
            sys.stderr.write(f"[audit] automatic trail failed: {exc}\n")
            sys.stderr.flush()
