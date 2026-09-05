"""
Small in-process rate limiter.

Counters live in memory: they reset on redeploy and are not shared between
replicas, so this slows automated abuse rather than defeating a determined
attacker with a botnet. That is the right trade here — it needs no extra
infrastructure, and the endpoints it guards (credential guessing, a webhook
token, AI calls that cost money per request) are all ones where the attacker's
cheapest path is a tight loop from one place.

Move to Redis if the service is ever scaled beyond a single instance.
"""
import time
from typing import Optional

from fastapi import HTTPException, Request, status

# bucket name -> {key -> [timestamps]}
_hits: dict[str, dict[str, list[float]]] = {}

_MAX_KEYS_PER_BUCKET = 5000


def client_ip(request: Optional[Request]) -> str:
    """Caller's IP, preferring the proxy's header — Railway terminates TLS."""
    if request is None:
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _prune(bucket: dict[str, list[float]], window: int, now: float) -> None:
    if len(bucket) <= _MAX_KEYS_PER_BUCKET:
        return
    for k in [k for k, v in bucket.items() if not any(now - t < window for t in v)]:
        bucket.pop(k, None)


def check(name: str, key: str, max_hits: int, window: int, message: str) -> None:
    """Raise 429 if `key` has already used up its allowance in this window."""
    now = time.time()
    bucket = _hits.setdefault(name, {})
    recent = [t for t in bucket.get(key, []) if now - t < window]
    bucket[key] = recent
    if len(recent) >= max_hits:
        retry_in = max(int(window - (now - recent[0])), 1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=message,
            headers={"Retry-After": str(retry_in)},
        )


def record(name: str, key: str, window: int = 900) -> None:
    """Count one attempt against `key`."""
    now = time.time()
    bucket = _hits.setdefault(name, {})
    bucket.setdefault(key, []).append(now)
    _prune(bucket, window, now)


def reset(name: str, key: str) -> None:
    """Clear a key's history, e.g. after a successful sign-in."""
    _hits.get(name, {}).pop(key, None)


def guard(request: Optional[Request], name: str, max_hits: int, window: int, message: str) -> None:
    """check + record in one call, keyed on the caller's IP.

    Use for endpoints where every request counts (a webhook), as opposed to
    sign-in, where only *failures* should count against the caller.
    """
    key = client_ip(request)
    check(name, key, max_hits, window, message)
    record(name, key, window)
