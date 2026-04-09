from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import Base, engine
from routers import auth, clients, transactions, journal_entries, rules, audit_log, mercury, files, chat, email_inbound, invoices, close_checklist, qbo


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


@app.on_event("startup")
def on_startup():
    create_tables()
    _migrate_db()


@app.get("/")
def root():
    return {"status": "ok", "app": "Bookkeeping Bridge"}
