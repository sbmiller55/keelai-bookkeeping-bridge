"""Invoice upload → AI journal entry creation."""
import base64
import json
import os
from datetime import datetime
from typing import Optional

import anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

import ai_coder
from ai_coder import generate_prepaid_jes, generate_asset_jes, _parse_month, _add_months
import models
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/invoices", tags=["invoices"])

MODEL = "claude-sonnet-4-6"

_MEDIA_TYPES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_CONTENT_TYPES: dict[str, str] = {
    "application/pdf": "document",
    "image/jpeg": "image",
    "image/png": "image",
    "image/webp": "image",
    "image/gif": "image",
}


def _resolve_media_type(filename: str, content_type: Optional[str]) -> Optional[str]:
    if content_type and content_type.split(";")[0].strip() in _CONTENT_TYPES:
        return content_type.split(";")[0].strip()
    ext = os.path.splitext(filename)[1].lower()
    return _MEDIA_TYPES.get(ext)


def _extract_invoice(file_bytes: bytes, media_type: str, chart: Optional[str], policy: Optional[str]) -> dict:
    """Send invoice to Claude and return extracted data + suggested JEs."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    b64 = base64.standard_b64encode(file_bytes).decode("utf-8")
    file_kind = _CONTENT_TYPES[media_type]  # "document" or "image"

    if file_kind == "document":
        file_block: dict = {"type": "document", "source": {"type": "base64", "media_type": media_type, "data": b64}}
    else:
        file_block = {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}}

    system_parts = [
        "You are an expert bookkeeper. Read the attached invoice and create the appropriate journal entries.",
        "Respond with ONLY valid JSON — no markdown fences, no explanation.",
        "",
        "IMPORTANT: Evaluate in this order — fixed_asset first, then prepaid, then regular expense.",
        "",
        "For FIXED/INTANGIBLE ASSET purchases (amount > $2,500, long-lived asset with useful life > 1 year), return:",
        '{"type": "fixed_asset", "vendor": "Vendor Name", "invoice_date": "YYYY-MM-DD", "total_amount": 1234.56, "description": "description", "asset_account": "Computer Equipment", "accumulated_account": "Accumulated Depreciation", "depreciation_account": "Depreciation Expense", "bank_account": "Accrued Expenses", "useful_life_months": 60, "gaap_basis": "5-year straight-line per ASC 360", "confidence": 0.9, "reasoning": "explanation"}',
        "  GAAP useful lives: Computer hardware=60mo, Perpetual software=36mo, Furniture=84mo, Equipment=84mo, Vehicles=60mo, Leasehold improvements=120mo, Patents=180mo, Trademarks=120mo",
        "  Tangible assets: 'Depreciation Expense' / 'Accumulated Depreciation'. Intangibles: 'Amortization Expense' / 'Accumulated Amortization'.",
        "",
        "For MULTI-MONTH PREPAID invoices (annual/quarterly/multi-month subscription or service), return:",
        '{"type": "prepaid", "vendor": "Vendor Name", "invoice_date": "YYYY-MM-DD", "total_amount": 1234.56, "description": "description", "expense_account": "Specific Expense Account", "prepaid_account": "Prepaid Expenses", "service_start": "January 2025", "service_end": "December 2025", "confidence": 0.9, "reasoning": "explanation"}',
        "",
        "For regular single-period invoices (one month of service, one-time expense), return:",
        '{"type": "expense", "vendor": "Vendor Name", "invoice_date": "YYYY-MM-DD", "total_amount": 1234.56, "description": "description", "service_period": "March 2025", "journal_entries": [{"debit_account": "Account", "credit_account": "Account", "amount": 1234.56, "je_date": "YYYY-MM-DD", "memo": "short memo", "confidence": 0.9, "reasoning": "explanation"}]}',
        "",
        "Rules:",
        "- Use type=fixed_asset when the invoice is for a capital asset (computer hardware, equipment, perpetual software license, vehicles, furniture, intangibles) over $2,500",
        "- Use type=prepaid when the invoice covers multiple months of service (annual plans, multi-month subscriptions, etc.)",
        "- invoice_date: invoice issue date in YYYY-MM-DD format",
        "- service_start/service_end: first and last month of service coverage (e.g. 'January 2025', 'December 2025')",
        "- For regular invoices: DR Expense Account, CR Accrued Expenses",
        "- confidence: 0.0=total guess, 1.0=certain",
        "- Use EXACT account names from the Chart of Accounts if provided",
    ]
    if chart:
        system_parts.append(f"\n## Chart of Accounts\n{chart[:4000]}")
    if policy:
        system_parts.append(f"\n## Accounting Policy\n{policy[:2000]}")

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system="\n".join(system_parts),
        messages=[{
            "role": "user",
            "content": [
                file_block,
                {"type": "text", "text": "Extract the invoice data and create accrual journal entries. Return ONLY the JSON."},
            ],
        }],
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(raw)


@router.post("/upload")
async def upload_invoice(
    client_id: int = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    # Verify client belongs to user
    client_obj = db.query(models.Client).filter(
        models.Client.id == client_id,
        models.Client.user_id == current_user.id,
    ).first()
    if not client_obj:
        raise HTTPException(status_code=404, detail="Client not found")

    # Validate file type
    media_type = _resolve_media_type(file.filename or "", file.content_type)
    if not media_type:
        raise HTTPException(status_code=400, detail="Unsupported file type. Upload a PDF or image (JPG, PNG, WEBP).")

    file_bytes = await file.read()
    if len(file_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 20 MB)")

    chart = ai_coder._resolve_chart(client_obj)
    policy = ai_coder._read_file_safe(client_obj.policy_path)

    try:
        data = _extract_invoice(file_bytes, media_type, chart, policy)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read invoice: {exc}")

    vendor = str(data.get("vendor") or file.filename or "Unknown vendor")
    description = str(data.get("description") or f"Invoice from {vendor}")
    total_amount = float(data.get("total_amount") or 0)
    if total_amount == 0:
        raise HTTPException(status_code=422, detail="Could not extract invoice total amount")

    invoice_date_str = data.get("invoice_date")
    try:
        invoice_date = datetime.strptime(invoice_date_str, "%Y-%m-%d") if invoice_date_str else datetime.utcnow()
    except (ValueError, TypeError):
        invoice_date = datetime.utcnow()

    txn = models.Transaction(
        client_id=client_id,
        date=invoice_date,
        description=description,
        counterparty_name=vendor,
        amount=-abs(total_amount),
        mercury_status="invoice",
        status="pending",
        imported_at=datetime.utcnow(),
    )
    db.add(txn)
    db.flush()

    # Build JE list
    invoice_type = data.get("type", "expense")
    je_data_list: list[dict] = []
    conf = min(1.0, max(0.0, float(data.get("confidence") or 0.7)))
    reasoning_str = str(data.get("reasoning", ""))[:1000]

    if invoice_type == "fixed_asset":
        je_data_list = generate_asset_jes(
            total_amount=total_amount,
            purchase_date=invoice_date,
            bank_account=str(data.get("bank_account", "Accrued Expenses"))[:255],
            asset_account=str(data.get("asset_account", "Fixed Assets"))[:255],
            accumulated_account=str(data.get("accumulated_account", "Accumulated Depreciation"))[:255],
            depreciation_account=str(data.get("depreciation_account", "Depreciation Expense"))[:255],
            useful_life_months=int(data.get("useful_life_months") or 60),
            vendor=vendor,
            gaap_basis=str(data.get("gaap_basis", ""))[:200],
            confidence=conf,
            reasoning=reasoning_str,
        )
    elif invoice_type == "prepaid":
        service_start = _parse_month(str(data.get("service_start", ""))) or invoice_date.replace(day=1)
        service_end = _parse_month(str(data.get("service_end", ""))) or _add_months(service_start, 11)
        bank_account = client_obj.mercury_account_name if hasattr(client_obj, "mercury_account_name") else "Mercury Checking"
        je_data_list = generate_prepaid_jes(
            total_amount=total_amount,
            payment_date=invoice_date,
            bank_account=bank_account,
            expense_account=str(data.get("expense_account", "Professional Services"))[:255],
            prepaid_account=str(data.get("prepaid_account", "Prepaid Expenses"))[:255],
            service_start=service_start,
            service_end=service_end,
            vendor=vendor,
            confidence=conf,
            reasoning=reasoning_str,
        )
    else:
        je_data_list = data.get("journal_entries") or [{
            "debit_account": "Professional Services",
            "credit_account": "Accrued Expenses",
            "amount": total_amount,
            "je_date": invoice_date_str,
            "memo": description[:80],
            "confidence": 0.5,
            "reasoning": "Fallback accrual entry",
        }]

    created_jes = []
    for jd in je_data_list:
        jd_date = jd.get("je_date")
        if isinstance(jd_date, datetime):
            je_date = jd_date
        elif jd_date:
            try:
                je_date = datetime.strptime(jd_date, "%Y-%m-%d")
            except (ValueError, TypeError):
                je_date = invoice_date
        else:
            je_date = invoice_date

        je = models.JournalEntry(
            transaction_id=txn.id,
            debit_account=str(jd.get("debit_account", "Uncoded"))[:255],
            credit_account=str(jd.get("credit_account", "Uncoded"))[:255],
            amount=abs(float(jd.get("amount") or total_amount)),
            je_date=je_date,
            memo=str(jd.get("memo", ""))[:500],
            ai_confidence=min(1.0, max(0.0, float(jd.get("confidence") or jd.get("ai_confidence") or 0.5))),
            ai_reasoning=str(jd.get("reasoning") or jd.get("ai_reasoning") or "")[:1000],
            service_period_start=jd.get("service_period_start"),
            service_period_end=jd.get("service_period_end"),
            is_recurring=jd.get("is_recurring", False),
            recur_frequency=jd.get("recur_frequency"),
            recur_end_date=jd.get("recur_end_date"),
        )
        db.add(je)
        created_jes.append(je)

    db.commit()
    db.refresh(txn)
    for je in created_jes:
        db.refresh(je)

    return {
        "transaction": {
            "id": txn.id,
            "date": txn.date.strftime("%Y-%m-%d"),
            "description": txn.description,
            "vendor": vendor,
            "amount": txn.amount,
            "status": txn.status,
        },
        "journal_entries": [
            {
                "id": je.id,
                "debit_account": je.debit_account,
                "credit_account": je.credit_account,
                "amount": je.amount,
                "je_date": je.je_date.strftime("%Y-%m-%d") if je.je_date else None,
                "memo": je.memo,
                "ai_confidence": je.ai_confidence,
                "ai_reasoning": je.ai_reasoning,
            }
            for je in created_jes
        ],
    }
