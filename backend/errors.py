"""
Turning exceptions into messages that are safe to show a client.

Application-level failures carry text written for the user — "your QuickBooks
connection has expired" — and hiding those makes the app impossible to debug
from the browser. Infrastructure failures do not: SQLAlchemy embeds the failing
SQL, boto3 embeds bucket names and signed URLs, HTTP clients embed request URLs
that can carry credentials in the query string. Those get a generic line and the
real detail goes to the log.
"""

# Exception modules whose messages routinely embed internals.
_OPAQUE_MODULES = (
    "sqlalchemy", "psycopg2", "asyncpg", "botocore", "boto3",
    "urllib3", "httpx", "requests", "http.client", "ssl", "socket",
    "anthropic", "openai",
)


def is_opaque(exc: BaseException) -> bool:
    module = type(exc).__module__ or ""
    return any(module.startswith(p) for p in _OPAQUE_MODULES)


def safe_detail(exc: BaseException, action: str | None = None) -> str:
    """A client-facing message for an exception.

    `action` describes what was being attempted, e.g. "code transactions with
    AI", and is used to make the generic case still useful to the reader.
    """
    if is_opaque(exc):
        what = f" while trying to {action}" if action else ""
        return (
            f"Internal error{what} ({type(exc).__name__}). "
            "The details were written to the server log."
        )
    return f"{type(exc).__name__}: {exc}"
