"""Automated database backup to S3."""
import gzip
import json
import os
import sys
from datetime import datetime, timedelta

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import text

from database import engine


def _log(msg: str):
    sys.stderr.write(f"[backup] {msg}\n")
    sys.stderr.flush()


def _s3_client():
    return boto3.client(
        "s3",
        region_name=os.getenv("AWS_REGION", "us-east-1"),
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    )


TABLES = [
    "users",
    "clients",
    "transactions",
    "journal_entries",
    "rules",
    "fixed_assets",
    "accrued_expenses",
    "standing_accrual_rules",
    "close_checklist_items",
    "close_checklist_completions",
    "vendor_classifications",
    "dismissed_vendors",
    "revenue_streams",
    "revenue_contracts",
    "revenue_schedule_entries",
    "revenue_integration_settings",
    "audit_log",
    "client_chat_messages",
    "model_updates",
]


def _default(o):
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)


def run_backup(label: str = "scheduled") -> dict:
    """Dump all DB tables to gzipped JSON and upload to S3. Returns metadata."""
    bucket = os.getenv("AWS_S3_BUCKET", "keelai-bookkeeping")
    now = datetime.utcnow()
    date_str = now.strftime("%Y-%m-%d")
    ts_str = now.strftime("%Y-%m-%dT%H-%M-%S")

    dump: dict = {"timestamp": now.isoformat(), "label": label, "tables": {}}
    row_counts: dict[str, int] = {}

    with engine.connect() as conn:
        for table in TABLES:
            try:
                rows = conn.execute(text(f"SELECT * FROM {table}")).mappings().all()
                dump["tables"][table] = [dict(r) for r in rows]
                row_counts[table] = len(dump["tables"][table])
            except Exception as exc:
                _log(f"  table={table} error: {exc}")
                dump["tables"][table] = []
                row_counts[table] = 0

    raw = json.dumps(dump, default=_default).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    size_kb = len(compressed) // 1024

    key = f"backups/db/{date_str}/{ts_str}_{label}.json.gz"

    s3 = _s3_client()
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=compressed,
        ContentType="application/gzip",
        ContentEncoding="gzip",
        Metadata={"label": label, "timestamp": now.isoformat()},
    )

    _log(f"uploaded s3://{bucket}/{key} ({size_kb} KB, {sum(row_counts.values())} rows)")

    _prune_old_backups(s3, bucket, days=30)

    return {
        "key": key,
        "size_kb": size_kb,
        "timestamp": now.isoformat(),
        "label": label,
        "row_counts": row_counts,
    }


def _prune_old_backups(s3, bucket: str, days: int = 30):
    """Delete backup files older than `days` days."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix="backups/db/"):
            for obj in page.get("Contents", []):
                # Key format: backups/db/YYYY-MM-DD/...
                parts = obj["Key"].split("/")
                if len(parts) < 3:
                    continue
                try:
                    folder_date = datetime.strptime(parts[2], "%Y-%m-%d")
                    if folder_date < cutoff:
                        s3.delete_object(Bucket=bucket, Key=obj["Key"])
                        _log(f"pruned old backup: {obj['Key']}")
                except ValueError:
                    pass
    except (BotoCoreError, ClientError) as exc:
        _log(f"prune error: {exc}")


def list_backups() -> list[dict]:
    """List available backups from S3, newest first."""
    bucket = os.getenv("AWS_S3_BUCKET", "keelai-bookkeeping")
    s3 = _s3_client()
    results = []
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix="backups/db/"):
            for obj in page.get("Contents", []):
                results.append({
                    "key": obj["Key"],
                    "size_kb": obj["Size"] // 1024,
                    "last_modified": obj["LastModified"].isoformat(),
                })
    except (BotoCoreError, ClientError) as exc:
        _log(f"list error: {exc}")
    return sorted(results, key=lambda x: x["last_modified"], reverse=True)


# ── Restore ──────────────────────────────────────────────────────────────────
# The production database has now been wiped three times by Railway tearing the
# services down. Recovery used to be "parse the JSON and POST it back through
# the API", which cannot reach tables the API has no endpoints for — revenue
# schedule entries, audit log, checklist completions — and cannot preserve
# primary keys, which every foreign key in the dump depends on. This restores
# the dump as it was taken: same tables, same ids, same values.

# Columns that point at a row in their own table. Their target may not be
# inserted yet, so they go in as NULL and are filled in once every row exists.
_SELF_REFS = {
    "transactions": ["matched_payment_id"],
    "journal_entries": ["parent_je_id"],
}


def fetch_backup(key: str) -> dict:
    """Download and parse one backup from S3."""
    bucket = os.getenv("AWS_S3_BUCKET", "keelai-bookkeeping")
    obj = _s3_client().get_object(Bucket=bucket, Key=key)
    return json.loads(gzip.decompress(obj["Body"].read()).decode("utf-8"))


def run_restore(key: str, truncate: bool = False) -> dict:
    """Restore every table from the backup at `key`.

    Values are written with raw SQL rather than through the ORM so that the
    encrypted credential columns go back exactly as they came out — passing
    ciphertext through the EncryptedText type would encrypt it a second time.
    Reading them afterwards needs the same ENCRYPTION_KEY the dump was taken
    under.
    """
    dump = fetch_backup(key)
    tables = dump.get("tables", {})
    restored: dict[str, int] = {}
    skipped: dict[str, str] = {}
    deferred: list[tuple] = []

    with engine.begin() as conn:
        if truncate:
            # Reverse order: children before parents.
            for table in reversed(TABLES):
                try:
                    conn.execute(text(f"DELETE FROM {table}"))
                except Exception as exc:
                    _log(f"  clear table={table} error: {exc}")

        for table in TABLES:
            rows = tables.get(table) or []
            if not rows:
                restored[table] = 0
                continue

            existing = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0
            if existing and not truncate:
                skipped[table] = f"{existing} rows already present"
                restored[table] = 0
                continue

            self_refs = _SELF_REFS.get(table, [])
            inserted = 0
            for row in rows:
                cols = list(row.keys())
                values = dict(row)
                for col in self_refs:
                    if values.get(col) is not None:
                        deferred.append((table, values["id"], col, values[col]))
                        values[col] = None
                collist = ", ".join(f'"{c}"' for c in cols)
                params = ", ".join(f":{c}" for c in cols)
                try:
                    conn.execute(
                        text(f'INSERT INTO {table} ({collist}) VALUES ({params})'), values
                    )
                    inserted += 1
                except Exception as exc:
                    _log(f"  table={table} id={row.get('id')} error: {exc}")
            restored[table] = inserted
            _log(f"  table={table} restored {inserted}/{len(rows)}")

        # Now that every row exists, point the self-references back.
        for table, row_id, col, target in deferred:
            try:
                conn.execute(
                    text(f'UPDATE {table} SET "{col}" = :target WHERE id = :id'),
                    {"target": target, "id": row_id},
                )
            except Exception as exc:
                _log(f"  self-ref {table}.{col} id={row_id} error: {exc}")

        # Explicit ids were inserted, so the identity sequences still sit at 1
        # and the next insert through the app would collide with restored rows.
        for table in TABLES:
            try:
                conn.execute(
                    text(
                        f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                        f"GREATEST(COALESCE((SELECT MAX(id) FROM {table}), 1), 1))"
                    )
                )
            except Exception as exc:
                _log(f"  sequence table={table} error: {exc}")

    total = sum(restored.values())
    _log(f"restored {total} rows from s3://{os.getenv('AWS_S3_BUCKET', 'keelai-bookkeeping')}/{key}")
    return {
        "key": key,
        "taken_at": dump.get("timestamp"),
        "label": dump.get("label"),
        "restored_rows": total,
        "by_table": restored,
        "skipped": skipped,
        "self_refs_relinked": len(deferred),
    }
