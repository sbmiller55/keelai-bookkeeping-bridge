"""AI-powered journal entry coding engine using Claude Sonnet."""
import calendar
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Optional

import storage

MODEL = "claude-sonnet-4-6"

_VOWELS = set("aeiou")
_COMMON_WORDS = {"in", "is", "of", "to", "at", "on", "an", "as", "or", "and", "the", "by", "for"}


def _extract_coa_from_pdf(p: Path) -> Optional[str]:
    """Extract a clean list of account names from a QBO-style Chart of Accounts PDF."""
    try:
        import pdfplumber
        accounts: list[str] = []
        with pdfplumber.open(p) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables():
                    for row in table:
                        if not row or len(row) < 2:
                            continue
                        name_cell = row[1]
                        if not name_cell:
                            continue
                        parts = name_cell.split("\n")
                        joined = parts[0]
                        for part in parts[1:]:
                            stripped = part.strip()
                            if not stripped:
                                continue
                            first_token = stripped.split()[0] if stripped.split() else ""
                            prev_last = joined[-1] if joined else ""
                            is_suffix = (
                                first_token and len(first_token) <= 3
                                and first_token.islower()
                                and first_token not in _COMMON_WORDS
                                and prev_last.islower()
                                and prev_last not in _VOWELS
                            )
                            joined += stripped if is_suffix else " " + stripped
                        name = " ".join(joined.split()).strip()
                        if name.lower() not in ("name", "account", ""):
                            accounts.append(name)
        unique = sorted(set(accounts))
        return "\n".join(unique) if unique else None
    except Exception:
        return None


def _read_file_safe(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        with storage.as_local_path(path) as p:
            if p is None:
                return None
            suffix = p.suffix.lower()
            if suffix == ".pdf":
                return _extract_coa_from_pdf(p)
            elif suffix in (".docx", ".doc"):
                import docx
                doc = docx.Document(p)
                return "\n".join(para.text for para in doc.paragraphs)[:8000]
            else:
                return p.read_text(errors="replace")[:8000]
    except Exception:
        return None


def _get_qbo_coa(client_obj) -> Optional[str]:
    """Fetch live COA from QBO when no file is uploaded. Returns newline-joined account names or None."""
    try:
        from qbo_client import QBOClient
        from datetime import datetime as _dt
        if not getattr(client_obj, "qbo_access_token", None) or not getattr(client_obj, "qbo_realm_id", None):
            return None
        qbo = QBOClient(
            access_token=client_obj.qbo_access_token,
            refresh_token=client_obj.qbo_refresh_token or "",
            realm_id=client_obj.qbo_realm_id,
            token_expires_at=client_obj.qbo_token_expires_at or _dt.utcnow(),
        )
        names = qbo.get_coa_names()
        return "\n".join(names) if names else None
    except Exception:
        return None


def _resolve_chart(client_obj) -> Optional[str]:
    """Return COA text: uploaded file first, fall back to live QBO accounts."""
    chart = _resolve_chart(client_obj)
    if not chart:
        chart = _get_qbo_coa(client_obj)
    return chart


# Parent/header accounts that must never appear in journal entries
_PARENT_ACCOUNTS = {
    "Cash",
    "Accumulated amortization",
    "Fixed Assets",
    "Intangible Asset",
    "Payroll wages and tax to pay",
    "Short-term business loans",
    "Preferred stock",
    "Insurance",
    "Legal, Finance & Accounting services",
    "Meals",
    "Travel",
}

# ── Prepaid / amortization helpers ────────────────────────────────────────────

def _last_day(year: int, month: int) -> datetime:
    return datetime(year, month, calendar.monthrange(year, month)[1])


def _add_months(dt: datetime, n: int) -> datetime:
    month = dt.month + n
    year = dt.year + (month - 1) // 12
    month = (month - 1) % 12 + 1
    return dt.replace(year=year, month=month, day=1)


def _parse_month(s: str) -> Optional[datetime]:
    """Parse 'January 2025', 'Jan 2025', or '2025-01' into a datetime at day=1."""
    if not s:
        return None
    for fmt in ("%B %Y", "%b %Y", "%Y-%m"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(day=1)
        except ValueError:
            continue
    return None


def generate_prepaid_jes(
    total_amount: float,
    payment_date: datetime,
    bank_account: str,
    expense_account: str,
    prepaid_account: str,
    service_start: datetime,
    service_end: datetime,
    vendor: str,
    confidence: float,
    reasoning: str,
) -> list[dict]:
    """
    Build the 2-JE list for a prepaid expense:
      JE 1 — payment date: DR prepaid_account / CR bank_account (full amount)
      JE 2 — recurring template: DR expense_account / CR prepaid_account (monthly amount)
              is_recurring=True, recur_frequency="MONTHLY", recur_end_date=last day of service_end
    """
    start = service_start.replace(day=1)
    end = service_end.replace(day=1)
    n_months = (end.year - start.year) * 12 + (end.month - start.month) + 1
    if n_months < 1:
        n_months = 1

    monthly = round(total_amount / n_months, 2)
    period_label = f"{start.strftime('%b %Y')}–{end.strftime('%b %Y')}"
    recur_end = _last_day(end.year, end.month)

    return [
        # JE 1: cash payment → prepaid asset
        {
            "debit_account": prepaid_account,
            "credit_account": bank_account,
            "amount": total_amount,
            "je_date": payment_date,
            "memo": f"Prepaid: {vendor} {period_label}"[:80],
            "ai_confidence": confidence,
            "ai_reasoning": f"Upfront payment recorded to {prepaid_account}. {reasoning}",
            "service_period_start": start,
            "service_period_end": recur_end,
            "is_recurring": False,
        },
        # JE 2: recurring monthly amortization template
        {
            "debit_account": expense_account,
            "credit_account": prepaid_account,
            "amount": monthly,
            "je_date": _last_day(start.year, start.month),  # first recurrence date
            "memo": f"{vendor} monthly amortization"[:80],
            "ai_confidence": confidence,
            "ai_reasoning": f"Recurring monthly amortization of prepaid {vendor} over {n_months} months. {reasoning}",
            "service_period_start": start,
            "service_period_end": recur_end,
            "is_recurring": True,
            "recur_frequency": "MONTHLY",
            "recur_end_date": recur_end,
        },
    ]


def generate_asset_jes(
    total_amount: float,
    purchase_date: datetime,
    bank_account: str,
    asset_account: str,
    accumulated_account: str,
    depreciation_account: str,
    useful_life_months: int,
    vendor: str,
    gaap_basis: str,
    confidence: float,
    reasoning: str,
) -> list[dict]:
    """
    Build the 2-JE list for a capitalized fixed/intangible asset:
      JE 1 — purchase date: DR asset_account / CR bank_account (full cost)
      JE 2 — recurring template: DR depreciation_account / CR accumulated_account (monthly straight-line)
              is_recurring=True, recur_frequency="MONTHLY", recur_end_date=end of useful life
    """
    if useful_life_months < 1:
        useful_life_months = 1
    monthly = round(total_amount / useful_life_months, 2)
    end_month = _add_months(purchase_date.replace(day=1), useful_life_months - 1)
    recur_end = _last_day(end_month.year, end_month.month)
    first_dep = _last_day(purchase_date.year, purchase_date.month)

    return [
        # JE 1: capitalize the asset
        {
            "debit_account": asset_account,
            "credit_account": bank_account,
            "amount": total_amount,
            "je_date": purchase_date,
            "memo": f"Purchase: {vendor}"[:80],
            "ai_confidence": confidence,
            "ai_reasoning": f"Asset capitalized to {asset_account}. {gaap_basis}. {reasoning}",
            "is_recurring": False,
        },
        # JE 2: recurring monthly depreciation/amortization template
        {
            "debit_account": depreciation_account,
            "credit_account": accumulated_account,
            "amount": monthly,
            "je_date": first_dep,
            "memo": f"{vendor} depreciation"[:80],
            "ai_confidence": confidence,
            "ai_reasoning": f"Monthly straight-line depreciation of {vendor} over {useful_life_months} months ({useful_life_months // 12} yrs). {gaap_basis}. {reasoning}",
            "is_recurring": True,
            "recur_frequency": "MONTHLY",
            "recur_end_date": recur_end,
        },
    ]


# ── Standard transaction coding ───────────────────────────────────────────────

def _build_system(chart_of_accounts: Optional[str], policy: Optional[str]) -> str:
    parts = [
        "You are an expert bookkeeper. Your job is to create accurate journal entries for bank transactions.",
        "Respond with ONLY valid JSON — no markdown fences, no explanation, nothing else.",
        "",
        "## CRITICAL: Credit Card vs. Cash Transaction Rules",
        "",
        "The 'account' field tells you WHICH Mercury account the transaction came from.",
        "The 'is_credit_card' field is true when the transaction is a credit card charge.",
        "",
        "CREDIT CARD CHARGES (is_credit_card=true OR kind='creditCardTransaction' OR kind='cardTransaction'):",
        "  - DR: the appropriate expense account",
        "  - CR: the credit card LIABILITY account that matches the 'account' field",
        "  - The credit card liability account name IS the account name from the 'account' field",
        "    (e.g., if account='Mercury Credit - 1', then CR 'Mercury Credit - 1')",
        "  - NEVER credit a checking or savings account for a credit card charge",
        "",
        "CREDIT CARD PAYMENTS (transaction that pays off a credit card balance):",
        "  - Identified by: counterparty or description contains the credit card account name,",
        "    OR kind is 'externalTransfer'/'ach' AND the credit card name is in the description",
        "  - DR: the credit card liability account being paid off",
        "  - CR: the checking/cash account the payment came from ('account' field)",
        "  - Use type=cc_payment for this case",
        "",
        "CHECKING/ACH TRANSACTIONS (is_credit_card=false, kind NOT creditCardTransaction):",
        "  - DR: the appropriate expense/asset account",
        "  - CR: the checking account from the 'account' field",
        "",
        "## Transaction Types",
        "",
        "For MOST transactions, return:",
        '{"type": "expense", "debit_account": "Account Name", "credit_account": "Account Name", "memo": "Brief memo", "confidence": 0.95, "reasoning": "explanation"}',
        "",
        "For CREDIT CARD PAYMENTS, return:",
        '{"type": "cc_payment", "debit_account": "Credit Card Liability Account", "credit_account": "Mercury Checking Account", "memo": "CC payment memo", "confidence": 0.95, "reasoning": "explanation"}',
        "",
        "For PREPAID expenses (amount > $1000 paid upfront for multi-month service), return:",
        '{"type": "prepaid", "vendor": "Vendor Name", "expense_account": "Specific Expense Account", "prepaid_account": "Prepaid Expenses", "bank_account": "The account field value", "service_start": "January 2025", "service_end": "March 2025", "confidence": 0.9, "reasoning": "explanation"}',
        "  bank_account must be the credit card liability account if is_credit_card=true, or the checking account if false.",
        "",
        "Use type=prepaid ONLY when ALL of these are true:",
        "  1. Amount > $1,000",
        "  2. Description clearly indicates upfront multi-month payment (Annual, Yearly, Quarterly, 3-month, 6-month, etc.)",
        "  3. The service period spans 2 or more months",
        "",
        "For FIXED/INTANGIBLE ASSET purchases (amount > $2,500, long-lived asset > 1 year useful life), return:",
        '{"type": "fixed_asset", "vendor": "Vendor Name", "asset_account": "<exact COA asset account>", "accumulated_account": "<exact COA accumulated account>", "depreciation_account": "<exact COA expense account>", "bank_account": "The account field value", "useful_life_months": 60, "gaap_basis": "5-year straight-line per ASC 360", "confidence": 0.9, "reasoning": "explanation"}',
        "  bank_account must be the credit card liability account if is_credit_card=true, or the checking account if false.",
        "  ALL account names must come from the Chart of Accounts. Do NOT invent names like 'Computer Equipment' or 'Depreciation Expense'.",
        "  Choose the specific asset account from the COA (e.g. 'Long-term office equipment', 'Domain Name', 'Intangible Asset').",
        "  Choose the accumulated account from the COA (e.g. 'Accumulated depreciation', 'Accumulated amortization').",
        "  Choose the depreciation/amortization expense account from the COA — if none exists, use 'General business expenses'.",
        "",
        "Use type=fixed_asset ONLY when ALL of these are true:",
        "  1. Amount > $2,500",
        "  2. Long-lived tangible or intangible asset (computers, equipment, vehicles, furniture, perpetual software, patents, trademarks)",
        "  3. NOT a subscription or recurring service",
        "  GAAP useful lives: Computer hardware=60mo | Perpetual software=36mo | Furniture/Equipment=84mo | Vehicles=60mo | Leasehold improvements=120mo | Patents=180mo | Trademarks=120mo",
        "",
        "## General Rules",
        "- Income (positive amount): DR the bank/cash account, CR the revenue account",
        "- Internal transfers between Mercury accounts: DR receiving account, CR sending account",
        "- Payroll (kind=outgoingPayment to payroll processor): DR Payroll Liability or Salaries, CR Checking",
        "- Loan repayments: split into principal (DR the loan liability account) + interest (DR 'Interest Expense'), CR checking",
        "- confidence: 0.0=total guess, 1.0=certain. Be honest.",
        "- memo: under 80 characters",
        "- CRITICAL: Use EXACT account names from the Chart of Accounts. Never invent names like",
        "  'Computer Equipment', 'Depreciation Expense', 'Software and Technology', etc. — use what is in the COA.",
        "- Exception: 'Interest Expense' is a valid account for loan interest charges.",
        "- NEVER use parent/header accounts. Use the most specific child account.",
        "- Use the specific bank account name (e.g. 'Mercury Checking (9882) - 1'), never a parent like 'Cash'.",
    ]
    if chart_of_accounts:
        parent_note = "\n\n## Parent Accounts — DO NOT USE\n" + "\n".join(f"- {a}" for a in sorted(_PARENT_ACCOUNTS))
        parts.append(f"\n## Chart of Accounts (use EXACT names)\n{chart_of_accounts}{parent_note}")
    if policy:
        parts.append(f"\n## Accounting Policy\n{policy}")
    return "\n".join(parts)


def _code_one(txn_dict: dict, system: str, api_key: str) -> list[dict]:
    """Call Claude Sonnet to code a single transaction. Returns list of JE dicts (1 for standard, N for prepaid)."""
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    user_msg = (
        f"Create a journal entry for this bank transaction:\n"
        f"{json.dumps(txn_dict, indent=2)}"
    )
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=600,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        data = json.loads(raw)

        confidence = min(1.0, max(0.0, float(data.get("confidence", 0.5))))
        reasoning = str(data.get("reasoning", ""))[:1000]

        payment_date_str = txn_dict.get("date", "")
        try:
            payment_date = datetime.strptime(payment_date_str, "%Y-%m-%d")
        except (ValueError, TypeError):
            payment_date = datetime.utcnow()

        vendor = str(data.get("vendor", txn_dict.get("counterparty", txn_dict.get("description", ""))))[:80]
        bank_account = str(data.get("bank_account", txn_dict.get("account", "Mercury Checking")))[:255]
        total_amount = abs(float(txn_dict.get("amount", 0)))

        if data.get("type") == "prepaid":
            service_start = _parse_month(str(data.get("service_start", ""))) or payment_date.replace(day=1)
            service_end_raw = _parse_month(str(data.get("service_end", "")))
            if not service_end_raw:
                service_end_raw = _add_months(service_start, 11)

            return generate_prepaid_jes(
                total_amount=total_amount,
                payment_date=payment_date,
                bank_account=bank_account,
                expense_account=str(data.get("expense_account", "Professional Services"))[:255],
                prepaid_account=str(data.get("prepaid_account", "Prepaid Expenses"))[:255],
                service_start=service_start,
                service_end=service_end_raw,
                vendor=vendor,
                confidence=confidence,
                reasoning=reasoning,
            )

        if data.get("type") == "fixed_asset":
            return generate_asset_jes(
                total_amount=total_amount,
                purchase_date=payment_date,
                bank_account=bank_account,
                asset_account=str(data.get("asset_account", "Fixed Assets"))[:255],
                accumulated_account=str(data.get("accumulated_account", "Accumulated Depreciation"))[:255],
                depreciation_account=str(data.get("depreciation_account", "Depreciation Expense"))[:255],
                useful_life_months=int(data.get("useful_life_months", 60)),
                vendor=vendor,
                gaap_basis=str(data.get("gaap_basis", ""))[:200],
                confidence=confidence,
                reasoning=reasoning,
            )

        # cc_payment and standard expense both produce a single JE
        return [{
            "debit_account": str(data.get("debit_account", "Uncoded"))[:255],
            "credit_account": str(data.get("credit_account", "Uncoded"))[:255],
            "amount": abs(float(txn_dict.get("amount", 0))),
            "je_date": None,
            "memo": str(data.get("memo", ""))[:500],
            "ai_confidence": confidence,
            "ai_reasoning": reasoning,
        }]

    except Exception as exc:
        return [{
            "debit_account": "Uncoded",
            "credit_account": "Uncoded",
            "amount": abs(float(txn_dict.get("amount", 0))),
            "je_date": None,
            "memo": txn_dict.get("description", "")[:80],
            "ai_confidence": 0.0,
            "ai_reasoning": f"AI coding failed: {exc}",
        }]


def _last_day_of_month(year: int, month: int) -> datetime:
    last = calendar.monthrange(year, month)[1]
    return datetime(year, month, last)


def code_outgoing_payment_with_invoice(transaction, invoice_text: str, client_obj) -> list[dict]:
    """
    Use Claude to create accrual journal entries for an outgoing payment with an invoice.
    For SENT payments: 2 JEs (accrual + payment clearing).
    For PENDING payments: 1 JE (accrual only).
    Returns list of je_data dicts.
    """
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    chart = _resolve_chart(client_obj)
    policy = _read_file_safe(client_obj.policy_path)

    is_pending = getattr(transaction, "mercury_status", None) == "pending"
    payment_date = transaction.date.strftime("%Y-%m-%d") if transaction.date else "unknown"
    amount = abs(transaction.amount)
    counterparty = transaction.counterparty_name or transaction.description or ""
    bank_account = transaction.mercury_account_name or "Mercury Checking"

    system_parts = [
        "You are an expert bookkeeper specializing in accrual accounting.",
        "Read the invoice and determine the correct journal entry pattern.",
        "Respond with ONLY valid JSON — no markdown fences, no explanation, nothing else.",
        "",
        "IMPORTANT: Evaluate in this order — fixed_asset first, then prepaid, then regular accrual.",
        "",
        "For FIXED/INTANGIBLE ASSET purchases (amount > $2,500, long-lived asset with useful life > 1 year) — return:",
        '{"type": "fixed_asset", "vendor": "Vendor Name", "asset_account": "Computer Equipment", "accumulated_account": "Accumulated Depreciation", "depreciation_account": "Depreciation Expense", "bank_account": "Mercury Checking", "useful_life_months": 60, "gaap_basis": "5-year straight-line per ASC 360", "confidence": 0.9, "reasoning": "explanation"}',
        "  GAAP useful lives: Computer hardware=60mo, Perpetual software=36mo, Furniture=84mo, Equipment/machinery=84mo, Vehicles=60mo, Leasehold improvements=120mo, Patents=180mo, Trademarks=120mo",
        "  Tangible assets: use 'Depreciation Expense' / 'Accumulated Depreciation'. Intangibles: use 'Amortization Expense' / 'Accumulated Amortization'.",
        "",
        "For PREPAID invoices covering 2+ months — return:",
        '{"type": "prepaid", "vendor": "Vendor Name", "expense_account": "Specific Expense Account", "prepaid_account": "Prepaid Expenses", "bank_account": "Mercury Checking Account", "service_start": "January 2025", "service_end": "March 2025", "confidence": 0.9, "reasoning": "explanation"}',
        "(service_start and service_end are the first and last month of coverage — e.g. quarterly = Jan 2025 to Mar 2025)",
        "",
        "For regular single-period invoices — return:",
    ]

    if is_pending:
        system_parts += [
            '{"type": "accrual_pending", "vendor": "Vendor Name", "service_period": "Month YYYY", "expense_account": "Account Name", "accrued_account": "Accrued Expenses", "confidence": 0.9, "reasoning": "explanation"}',
        ]
    else:
        system_parts += [
            '{"type": "accrual_sent", "vendor": "Vendor Name", "service_period": "Month YYYY", "expense_account": "Account Name", "accrued_account": "Accrued Expenses", "bank_account": "Mercury Checking", "confidence": 0.9, "reasoning": "explanation"}',
        ]

    system_parts += ["", "Rules:", "- Use type=fixed_asset when invoice is for a capital asset (hardware, equipment, perpetual software license, vehicles, furniture, intangibles) over $2,500", "- Use type=prepaid when invoice covers 2+ months: annual (12mo), semi-annual (6mo), quarterly (3mo), or any multi-month period", "- service_start/service_end: first and last month of coverage (e.g. 'January 2025', 'March 2025' for Q1)", "- Use EXACT account names from the Chart of Accounts if provided.", "- confidence: 0.0=total guess, 1.0=certain"]

    if chart:
        parent_note = "\n\n## Parent Accounts — DO NOT USE\n" + "\n".join(f"- {a}" for a in sorted(_PARENT_ACCOUNTS))
        system_parts.append(f"\n## Chart of Accounts\n{chart[:4000]}{parent_note}")
    if policy:
        system_parts.append(f"\n## Accounting Policy\n{policy[:2000]}")

    system = "\n".join(system_parts)

    user_msg = (
        f"Vendor/Counterparty: {counterparty}\n"
        f"Payment Amount: ${amount:.2f}\n"
        f"Payment Date: {payment_date}\n"
        f"Payment Status: {'pending' if is_pending else 'sent'}\n"
        f"Mercury Bank Account: {bank_account}\n"
        f"\n--- INVOICE TEXT ---\n{invoice_text[:6000]}\n--- END INVOICE ---\n"
        f"\nAnalyze the invoice and return the JSON for accrual journal entries."
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1500,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        data = json.loads(raw)

        confidence = min(1.0, max(0.0, float(data.get("confidence", 0.7))))
        reasoning = str(data.get("reasoning", ""))[:1000]
        vendor = str(data.get("vendor", counterparty))
        invoice_type = data.get("type", "accrual_sent")

        # ── Fixed/intangible asset: capitalize + recurring depreciation ──
        if invoice_type == "fixed_asset":
            return generate_asset_jes(
                total_amount=amount,
                purchase_date=transaction.date,
                bank_account=str(data.get("bank_account", bank_account))[:255],
                asset_account=str(data.get("asset_account", "Fixed Assets"))[:255],
                accumulated_account=str(data.get("accumulated_account", "Accumulated Depreciation"))[:255],
                depreciation_account=str(data.get("depreciation_account", "Depreciation Expense"))[:255],
                useful_life_months=int(data.get("useful_life_months", 60)),
                vendor=vendor,
                gaap_basis=str(data.get("gaap_basis", ""))[:200],
                confidence=confidence,
                reasoning=reasoning,
            )

        # ── Prepaid: payment JE + monthly amortization JEs ──
        if invoice_type == "prepaid":
            service_start = _parse_month(str(data.get("service_start", ""))) or transaction.date.replace(day=1)
            service_end = _parse_month(str(data.get("service_end", ""))) or _add_months(service_start, 11)
            return generate_prepaid_jes(
                total_amount=amount,
                payment_date=transaction.date,
                bank_account=str(data.get("bank_account", bank_account))[:255],
                expense_account=str(data.get("expense_account", "Professional Services"))[:255],
                prepaid_account=str(data.get("prepaid_account", "Prepaid Expenses"))[:255],
                service_start=service_start,
                service_end=service_end,
                vendor=vendor,
                confidence=confidence,
                reasoning=reasoning,
            )

        # ── Standard accrual ──
        expense_account = str(data.get("expense_account", "Professional Services"))[:255]
        accrued_account = str(data.get("accrued_account", "Accrued Expenses"))[:255]
        final_bank_account = str(data.get("bank_account", bank_account))[:255]
        service_period = data.get("service_period", "")

        accrual_date = None
        if service_period:
            accrual_date = _parse_month(str(service_period))
            if accrual_date:
                accrual_date = _last_day_of_month(accrual_date.year, accrual_date.month)
        if not accrual_date:
            accrual_date = transaction.date

        je_list = [{
            "debit_account": expense_account,
            "credit_account": accrued_account,
            "amount": amount,
            "je_date": accrual_date,
            "memo": f"Accrual: {vendor} services {service_period}"[:80],
            "ai_confidence": confidence,
            "ai_reasoning": f"Accrual JE for {vendor} ({service_period}). {reasoning}",
        }]

        if invoice_type != "accrual_pending":
            je_list.append({
                "debit_account": accrued_account,
                "credit_account": final_bank_account,
                "amount": amount,
                "je_date": transaction.date,
                "memo": f"Payment: {vendor} {payment_date}"[:80],
                "ai_confidence": confidence,
                "ai_reasoning": f"Payment JE clearing accrued liability for {vendor}. {reasoning}",
            })

        return je_list

    except Exception as exc:
        return [{
            "debit_account": "Professional Services",
            "credit_account": "Accrued Expenses",
            "amount": amount,
            "je_date": transaction.date,
            "memo": (transaction.description or "")[:80],
            "ai_confidence": 0.0,
            "ai_reasoning": f"Invoice accrual coding failed: {exc}",
        }]


def code_transactions(transactions: list, client_obj) -> list[tuple[int, list[dict]]]:
    """
    Code a batch of transaction model objects in parallel using Sonnet.
    Returns list of (transaction_id, [je_data, ...]) tuples.
    Each transaction may produce 1 JE (standard) or N JEs (prepaid annual).
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    if not transactions:
        return []

    chart = _resolve_chart(client_obj)
    policy = _read_file_safe(client_obj.policy_path)
    system = _build_system(chart, policy)

    _CC_KINDS = {"creditCardTransaction", "cardTransaction"}

    txn_dicts = [
        {
            "id": t.id,
            "date": t.date.strftime("%Y-%m-%d") if t.date else "",
            "description": t.description,
            "amount": t.amount,
            "kind": t.kind or "",
            "counterparty": t.counterparty_name or "",
            "payment_method": t.payment_method or "",
            "mercury_category": t.mercury_category or "",
            "account": t.mercury_account_name or "",
            "is_credit_card": (t.kind or "") in _CC_KINDS,
        }
        for t in transactions
    ]

    results: list[tuple[int, list[dict]]] = []
    max_workers = min(8, len(txn_dicts))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_id = {
            pool.submit(_code_one, td, system, api_key): td["id"]
            for td in txn_dicts
        }
        for future in as_completed(future_to_id):
            txn_id = future_to_id[future]
            try:
                results.append((txn_id, future.result()))
            except Exception as exc:
                results.append((txn_id, [{
                    "debit_account": "Uncoded",
                    "credit_account": "Uncoded",
                    "amount": 0,
                    "je_date": None,
                    "memo": "",
                    "ai_confidence": 0.0,
                    "ai_reasoning": f"Error: {exc}",
                }]))

    return results
