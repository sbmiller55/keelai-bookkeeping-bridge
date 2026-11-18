"""
Stop an entry reaching QuickBooks twice, even when the app cannot tell that it
already did.

September 2026 was posted twice. A push of ContextBridge's September batch died
partway on 2026-10-20 after creating QBO ids 1045-1070; the ids were written to
a session that only committed at the end of the batch, so the rollback left
nothing here pointing at them. The obvious next move — run the export again —
re-sent the whole batch, and the Carta amortization pair landed a second time
as 1072/1073. September expense was overstated by $273.34.

`exported_to_qbo` (2026-10-21) closed the crash case: the flag is committed the
instant Intuit accepts a push, so a later interruption cannot un-know it. One
hole is left open by construction, and it is the one this module closes. The
flag is written *after* the POST returns. If QuickBooks accepts the entry but
the response never arrives — a timeout, a reset connection, a 502 from the
edge — the push raises, the flag stays false, and the entry is pushed again on
the next run. No amount of local bookkeeping can see that entry; the only place
it exists is QuickBooks.

So ask QuickBooks. Before a batch is pushed, every entry QuickBooks already
holds over the batch's date range is read back and indexed two ways:

  key        a hash of the entry's own meaning — client, memo, date, amount,
             both accounts — stamped into the PrivateNote as "[KEEL:xxxxxxxx]"
             when we post it. Survives the entry being deleted and regenerated
             locally, which an `id` would not: the recode pipeline drops and
             rebuilds journal entries routinely, and a key tied to a row id
             would change under it and duplicate anyway.

  signature  (DocNumber, TxnDate, amount), for everything posted before the key
             existed. This is what would have caught Carta: doc 10825, dated
             2026-09-30, $106.67, already sitting in QuickBooks.

An entry matching either is not posted. Both are needed: the key is exact but
only present going forward, the signature covers the back catalogue but is
weaker — two genuinely distinct entries can share a document number, date and
amount, and the caller is expected to surface a signature skip rather than
swallow it.

This is a guard, not a transaction. QuickBooks has no idempotency key of its
own on these endpoints, so a push that is accepted while the connection drops
is still invisible until the next read. The window shrinks from "forever" to
"between this read and this push".
"""
import hashlib
import re
from typing import Iterable, Optional

# Stamped into the QBO PrivateNote. Deliberately bracketed and prefixed so it
# is greppable in QuickBooks and obviously machine-written to a human reading
# the register.
KEY_PREFIX = "KEEL:"
_KEY_RE = re.compile(r"\[" + KEY_PREFIX + r"([0-9a-f]{12})\]")

# QBO truncates PrivateNote around 4000 chars; the stamp must always survive, so
# the memo is trimmed rather than the key.
_MAX_NOTE = 3900


def _norm(value) -> str:
    """Normalize a field so cosmetic differences don't change the key."""
    return " ".join(str(value or "").split()).lower()


def entry_key(client_id: int, memo: str, je_date, amount, debit: str, credit: str) -> str:
    """A stable 12-hex-char identity for one logical journal entry.

    Derived from what the entry *means*, never from a row id: the coding
    pipeline deletes and recreates journal entries for any transaction it
    re-codes, so a row id changes while the entry it represents does not.
    Memo, date, amount and both accounts together are what a human would use to
    say "that is the same entry", and they are what QuickBooks shows.
    """
    date_part = ""
    if je_date is not None:
        date_part = je_date.strftime("%Y-%m-%d") if hasattr(je_date, "strftime") else str(je_date)
    raw = "|".join((
        str(client_id),
        _norm(memo),
        date_part,
        "%.2f" % abs(float(amount or 0)),
        _norm(debit),
        _norm(credit),
    ))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def stamp(memo: Optional[str], key: str) -> str:
    """Append the key to a memo, trimming the memo instead of the key."""
    tag = "[%s%s]" % (KEY_PREFIX, key)
    base = (memo or "").strip()
    if extract_key(base) == key:
        return base                       # already stamped (a forced re-push)
    room = _MAX_NOTE - len(tag) - 1
    if len(base) > room:
        base = base[:room].rstrip()
    return (base + " " + tag).strip()


def extract_key(private_note: Optional[str]) -> Optional[str]:
    m = _KEY_RE.search(private_note or "")
    return m.group(1) if m else None


def signature(doc_number, txn_date, amount) -> tuple:
    """The weaker identity used for entries posted before keys existed."""
    return (
        _norm(doc_number),
        str(txn_date or "")[:10],
        "%.2f" % abs(float(amount or 0)),
    )


def debit_total(qbo_entry: dict) -> float:
    """Total debits on a QBO JournalEntry. QBO reports TotalAmt as 0 for these."""
    total = 0.0
    for line in qbo_entry.get("Line") or []:
        detail = line.get("JournalEntryLineDetail") or {}
        if detail.get("PostingType") == "Debit":
            total += float(line.get("Amount") or 0)
    return round(total, 2)


def purchase_total(qbo_entry: dict) -> float:
    return round(float(qbo_entry.get("TotalAmt") or 0), 2)


class ExistingIndex:
    """What QuickBooks already holds, indexed for a pre-push check.

    Built once per export run from one read per object type, not one read per
    entry — a month-end batch is a few hundred entries and QuickBooks' query
    API is the slow part of any sync.
    """

    def __init__(self):
        self.keys: dict[str, str] = {}        # key -> qbo id
        self.signatures: dict[tuple, str] = {}  # signature -> qbo id

    @classmethod
    def build(cls, journal_entries: Iterable[dict], purchases: Iterable[dict] = ()):
        idx = cls()
        for e in journal_entries or ():
            idx._add(e, debit_total(e))
        for e in purchases or ():
            idx._add(e, purchase_total(e))
        return idx

    def _add(self, entry: dict, amount: float):
        qbo_id = str(entry.get("Id") or "")
        note = entry.get("PrivateNote") or ""
        key = extract_key(note)
        if key:
            self.keys.setdefault(key, qbo_id)
        sig = signature(entry.get("DocNumber"), entry.get("TxnDate"), amount)
        # Only index a signature that can actually identify something. A blank
        # document number would collide across every entry sharing a date and
        # amount — Rippling's own entries carry none.
        if sig[0]:
            self.signatures.setdefault(sig, qbo_id)

    def find(self, key: str, doc_number, txn_date, amount) -> tuple[Optional[str], Optional[str]]:
        """Return (qbo_id, how) if QuickBooks already holds this entry.

        `how` is "key" for an exact match and "signature" for the weaker one, so
        the caller can report a signature skip rather than silently trusting it.
        """
        hit = self.keys.get(key)
        if hit:
            return hit, "key"
        hit = self.signatures.get(signature(doc_number, txn_date, amount))
        if hit:
            return hit, "signature"
        return None, None

    def __len__(self):
        return len(self.signatures) + len(self.keys)
