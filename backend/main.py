from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

from database import Base, engine
from auth import get_current_user
from routers import auth, clients, transactions, journal_entries, rules, audit_log, mercury, files, chat, email_inbound, invoices, close_checklist, qbo, fixed_assets, accruals, revenue, billcom


def create_tables():
    Base.metadata.create_all(bind=engine)


app = FastAPI(title="Bookkeeping Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(clients.router)
app.include_router(transactions.router)
app.include_router(journal_entries.router)
app.include_router(rules.router)
app.include_router(audit_log.router)
app.include_router(mercury.router)
app.include_router(files.router)
app.include_router(chat.router)
app.include_router(email_inbound.router)
app.include_router(invoices.router)
app.include_router(close_checklist.router)
app.include_router(qbo.router)
app.include_router(fixed_assets.router)
app.include_router(accruals.router)
app.include_router(revenue.router)
app.include_router(billcom.router)


def _run_daily_backup():
    """Scheduler job: daily DB backup to S3."""
    try:
        from backup import run_backup
        result = run_backup(label="scheduled")
        import sys
        sys.stderr.write(f"[backup] daily backup complete: {result['key']} ({result['size_kb']} KB)\n")
        sys.stderr.flush()
    except Exception as exc:
        import sys, traceback
        sys.stderr.write(f"[backup] daily backup FAILED: {exc}\n")
        traceback.print_exc()


def _migrate_db():
    """Add new columns to existing tables without a full migration framework."""
    import os
    from sqlalchemy import text, inspect
    new_columns = [
        ("clients",        "qbo_access_token",     "TEXT"),
        ("clients",        "qbo_refresh_token",    "TEXT"),
        ("clients",        "qbo_realm_id",         "TEXT"),
        ("clients",        "qbo_token_expires_at", "TIMESTAMP"),
        ("journal_entries","qbo_je_id",             "TEXT"),
        ("journal_entries","qbo_object_type",       "TEXT"),
        ("journal_entries","qbo_export_error",      "TEXT"),
        ("close_checklist_items", "recurrence",     "TEXT DEFAULT 'monthly'"),
        ("transactions",          "source",          "TEXT DEFAULT 'mercury'"),
        ("transactions",          "fixed_asset_id",  "INTEGER"),
        ("fixed_assets",          "asset_type",      "TEXT DEFAULT 'tangible'"),
        ("fixed_assets",          "is_indefinite_life", "BOOLEAN DEFAULT FALSE"),
        ("accrued_expenses",      "debit_account",       "TEXT"),
        ("accrued_expenses",      "credit_account",      "TEXT"),
    ]
    is_sqlite = os.getenv("DATABASE_URL", "sqlite").startswith("sqlite")
    with engine.connect() as conn:
        insp = inspect(engine)
        for table, column, col_type in new_columns:
            try:
                existing_cols = [c["name"] for c in insp.get_columns(table)]
            except Exception:
                continue
            if column not in existing_cols:
                if is_sqlite:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
                else:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}"))
        conn.commit()


def _run_monthly_auto_release():
    """Scheduler job: release all accruals / depreciation / revenue for the current month."""
    from datetime import datetime
    from database import SessionLocal
    from models import Client
    from routers.accruals import _auto_release_for_client

    target_month = datetime.utcnow().strftime("%Y-%m")
    db = SessionLocal()
    try:
        clients = db.query(Client).all()
        for client in clients:
            try:
                result = _auto_release_for_client(client.id, target_month, db)
                print(f"[auto-release] client={client.id} month={target_month} result={result}")
            except Exception as exc:
                print(f"[auto-release] client={client.id} error: {exc}")
    finally:
        db.close()


def _seed_admin():
    """Create the admin user from env vars if they don't exist yet."""
    import os
    from database import SessionLocal
    from models import User
    from auth import hash_password

    email = os.getenv("SEED_ADMIN_EMAIL")
    password = os.getenv("SEED_ADMIN_PASSWORD")
    name = os.getenv("SEED_ADMIN_NAME", "Admin")
    if not email or not password:
        return

    db = SessionLocal()
    try:
        if not db.query(User).filter(User.email == email).first():
            db.add(User(email=email, password_hash=hash_password(password), name=name, subscription_tier="pro"))
            db.commit()
            print(f"[seed] Created admin user: {email}")
    finally:
        db.close()


@app.on_event("startup")
def on_startup():
    """Run DB setup in a background thread so uvicorn is never blocked."""
    import sys
    import threading

    def _log(msg):
        sys.stderr.write(f"{msg}\n")
        sys.stderr.flush()

    def _setup():
        import traceback
        try:
            _log("[startup] creating tables...")
            create_tables()
            _log("[startup] backing up db before migration...")
            try:
                from backup import run_backup
                r = run_backup(label="pre-migration")
                _log(f"[startup] backup complete: {r['key']} ({r['size_kb']} KB)")
            except Exception as exc:
                _log(f"[startup] backup warning (non-fatal): {exc}")
            _log("[startup] migrating db...")
            _migrate_db()
            _log("[startup] seeding admin...")
            _seed_admin()
            _log("[startup] starting scheduler...")

            from apscheduler.schedulers.background import BackgroundScheduler
            from apscheduler.triggers.cron import CronTrigger

            scheduler = BackgroundScheduler()
            scheduler.add_job(
                _run_monthly_auto_release,
                CronTrigger(day=10, hour=6, minute=0),
                id="monthly_auto_release",
                replace_existing=True,
            )
            scheduler.add_job(
                _run_daily_backup,
                CronTrigger(hour=2, minute=0),
                id="daily_backup",
                replace_existing=True,
            )
            scheduler.start()
            _log("[startup] done — server ready")
        except Exception as exc:
            _log(f"[startup] ERROR: {exc}")
            traceback.print_exc()

    threading.Thread(target=_setup, daemon=True, name="db-setup").start()
    _log("[startup] DB setup thread launched — uvicorn now accepting requests")


@app.get("/")
def root():
    return {"status": "ok", "app": "Bookkeeping Bridge"}


@app.post("/admin/backup")
def trigger_backup(current_user=Depends(get_current_user)):
    """Manually trigger a database backup to S3."""
    from backup import run_backup
    return run_backup(label="manual")


@app.get("/admin/backups")
def list_backups_endpoint(current_user=Depends(get_current_user)):
    """List available S3 backups."""
    from backup import list_backups
    return list_backups()


if __name__ == "__main__":
    import uvicorn
    import os
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))












