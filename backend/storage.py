"""
File storage abstraction — local disk or S3.

Set AWS_S3_BUCKET to enable S3. Without it, falls back to local ./uploads/ directory.
All public functions accept either a full local path (legacy DB values) or an S3 key.
"""
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

LOCAL_UPLOADS_DIR = Path(__file__).parent / "uploads"
LOCAL_UPLOADS_DIR.mkdir(exist_ok=True)

S3_BUCKET = os.getenv("AWS_S3_BUCKET")
S3_PREFIX = os.getenv("AWS_S3_PREFIX", "uploads/")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")


def _s3_client():
    import boto3
    return boto3.client(
        "s3",
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        region_name=AWS_REGION,
    )


def _s3_key(filename: str) -> str:
    return f"{S3_PREFIX}{Path(filename).name}"


def upload(filename: str, contents: bytes) -> str:
    """
    Store file contents and return a storage reference to save in the DB.
    Returns an S3 key if S3 is configured, otherwise a local path string.
    """
    if S3_BUCKET:
        key = _s3_key(filename)
        _s3_client().put_object(Bucket=S3_BUCKET, Key=key, Body=contents)
        return key
    else:
        dest = LOCAL_UPLOADS_DIR / filename
        dest.write_bytes(contents)
        return str(dest)


def read_bytes(path_or_key: Optional[str]) -> Optional[bytes]:
    """Read file contents given a DB storage reference. Returns None if not found."""
    if not path_or_key:
        return None
    if S3_BUCKET:
        try:
            # Try as-is first (already an S3 key), then with prefix applied to just the filename
            for key in [path_or_key, _s3_key(path_or_key)]:
                try:
                    resp = _s3_client().get_object(Bucket=S3_BUCKET, Key=key)
                    return resp["Body"].read()
                except Exception:
                    continue
        except Exception:
            pass
        return None
    else:
        # Local path — try as-is, then look in uploads dir by filename
        for candidate in [Path(path_or_key), LOCAL_UPLOADS_DIR / Path(path_or_key).name]:
            if candidate.exists():
                return candidate.read_bytes()
        return None


def read_text(path_or_key: Optional[str]) -> Optional[str]:
    """Read file as text. Returns None if not found."""
    data = read_bytes(path_or_key)
    return data.decode(errors="replace") if data is not None else None


@contextmanager
def as_local_path(path_or_key: Optional[str]):
    """
    Context manager that yields a Path object on the local filesystem.
    If using S3, downloads to a temp file first and cleans up after.
    Yields None if the file cannot be found.
    """
    if not path_or_key:
        yield None
        return

    if S3_BUCKET:
        contents = read_bytes(path_or_key)
        if contents is None:
            yield None
            return
        suffix = Path(path_or_key).suffix
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(contents)
            tmp_path = Path(tmp.name)
        try:
            yield tmp_path
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        for candidate in [Path(path_or_key), LOCAL_UPLOADS_DIR / Path(path_or_key).name]:
            if candidate.exists():
                yield candidate
                return
        yield None
