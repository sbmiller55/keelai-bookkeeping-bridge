import calendar
import io
from datetime import datetime, date
from typing import List, Optional

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
from models import next_je_number
import ai_coder
# The invoice upload path already solved reading a document with Claude —
# media-type resolution, magic-byte checking, and resolving account names
# against the live chart instead of trusting them. Reuse it rather than grow a
# second copy that drifts.
from routers.invoices import (
    _CONTENT_TYPES,
    _coa_index,
    _content_matches,
    _resolve_account,
    _resolve_media_type,
)

router = APIRouter(prefix="/clients", tags=["fixed_assets"])

# ── Category keyword → (category, useful_life_months, method) ─────────────────

_TANGIBLE_RULES = [
    (["laptop", "macbook", "macmini", "imac", "computer", "server", "workstation",
      "monitor", "display", "printer", "scanner", "projector", "hardware", "ipad",
      "tablet", "camera"], "Equipment", 60, "straight_line"),
    (["iphone", "android", "phone"], "Equipment", 36, "straight_line"),
    (["furniture", "chair", "desk", "table", "shelving", "cabinet", "sofa", "couch"], "Furniture", 84, "straight_line"),
    (["vehicle", "car", "truck", "van", "automobile"], "Vehicles", 60, "straight_line"),
    (["renovation", "improvement", "remodel", "construction", "build-out", "buildout",
      "leasehold"], "Leasehold Improvements", 120, "straight_line"),
]

_INTANGIBLE_RULES = [
    (["goodwill"], "Goodwill", 0, "straight_line"),                                   # indefinite life
    (["patent"], "Patents", 240, "straight_line"),                                    # 20 years
    (["trademark", "trade mark", "trade-mark"], "Trademarks", 120, "straight_line"), # 10 years
    (["customer list", "customer relationship"], "Customer Lists", 60, "straight_line"),
    (["non-compete", "noncompete", "non compete"], "Non-Compete Agreements", 36, "straight_line"),
    (["software", "saas"], "Capitalized Software", 36, "straight_line"),
    (["license", "licence", "domain"], "Licenses", 36, "straight_line"),
]


def _suggest(description: str) -> dict:
    desc_lower = description.lower()

    for keywords, category, useful_life, method in _INTANGIBLE_RULES:
        if any(kw in desc_lower for kw in keywords):
            return {
                "name": description,
                "category": category,
                "useful_life_months": useful_life,
                "depreciation_method": method,
                "salvage_value": 0.0,
                "asset_type": "intangible",
                "is_indefinite_life": category == "Goodwill",
            }

    for keywords, category, useful_life, method in _TANGIBLE_RULES:
        if any(kw in desc_lower for kw in keywords):
            return {
                "name": description,
                "category": category,
                "useful_life_months": useful_life,
                "depreciation_method": method,
                "salvage_value": 0.0,
                "asset_type": "tangible",
                "is_indefinite_life": False,
            }

    return {
        "name": description,
        "category": "Equipment",
        "useful_life_months": 60,
        "depreciation_method": "straight_line",
        "salvage_value": 0.0,
        "asset_type": "tangible",
        "is_indefinite_life": False,
    }


# ── Depreciation schedule computation ────────────────────────────────────────

def _compute_schedule(asset: models.FixedAsset) -> list[dict]:
    try:
        purchase = datetime.strptime(asset.purchase_date, "%Y-%m-%d").date()
    except Exception:
        return []

    if purchase.month == 12:
        start_year, start_month = purchase.year + 1, 1
    else:
        start_year, start_month = purchase.year, purchase.month + 1

    if getattr(asset, "is_indefinite_life", False) or asset.useful_life_months <= 0:
        return []

    depreciable = asset.purchase_price - asset.salvage_value
    nbv = float(asset.purchase_price)
    accum = 0.0
    schedule = []

    if asset.depreciation_method == "double_declining":
        ddb_rate = 2.0 / asset.useful_life_months
        for i in range(asset.useful_life_months):
            y = start_year + (start_month + i - 1) // 12
            m = (start_month + i - 1) % 12 + 1
            remaining = asset.useful_life_months - i
            sl = (nbv - asset.salvage_value) / remaining if remaining > 0 else 0
            dep = round(min(max(sl, nbv * ddb_rate), nbv - asset.salvage_value), 2)
            if dep <= 0:
                break
            accum = round(accum + dep, 2)
            nbv = round(nbv - dep, 2)
            last_day = calendar.monthrange(y, m)[1]
            schedule.append({
                "period": f"{y}-{m:02d}",
                "date": date(y, m, last_day).isoformat(),
                "depreciation": dep,
                "accumulated_depreciation": accum,
                "net_book_value": nbv,
            })
    else:  # straight_line
        if asset.useful_life_months <= 0:
            return []
        monthly = depreciable / asset.useful_life_months
        for i in range(asset.useful_life_months):
            y = start_year + (start_month + i - 1) // 12
            m = (start_month + i - 1) % 12 + 1
            dep = round(min(monthly, nbv - asset.salvage_value), 2)
            if dep <= 0:
                break
            accum = round(accum + dep, 2)
            nbv = round(nbv - dep, 2)
            last_day = calendar.monthrange(y, m)[1]
            schedule.append({
                "period": f"{y}-{m:02d}",
                "date": date(y, m, last_day).isoformat(),
                "depreciation": dep,
                "accumulated_depreciation": accum,
                "net_book_value": nbv,
            })

    return schedule


def _enrich(asset: models.FixedAsset) -> schemas.FixedAssetRead:
    schedule = _compute_schedule(asset)
    today_period = date.today().strftime("%Y-%m")
    accum_to_date = sum(p["depreciation"] for p in schedule if p["period"] <= today_period)
    nbv = round(asset.purchase_price - accum_to_date, 2)
    monthly_dep = schedule[0]["depreciation"] if schedule else 0.0

    r = schemas.FixedAssetRead.model_validate(asset)
    r.schedule = [schemas.DepreciationPeriod(**p) for p in schedule]
    r.accumulated_depreciation_to_date = round(accum_to_date, 2)
    r.net_book_value = nbv
    r.monthly_depreciation = monthly_dep
    return r


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _get_client_or_403(client_id: int, user: models.User, db: Session) -> models.Client:
    client = db.query(models.Client).filter(
        models.Client.id == client_id,
        models.Client.user_id == user.id,
    ).first()
    if not client:
        raise HTTPException(status_code=403, detail="Client not found")
    return client


def _get_asset_or_404(asset_id: int, client_id: int, db: Session) -> models.FixedAsset:
    asset = db.query(models.FixedAsset).filter(
        models.FixedAsset.id == asset_id,
        models.FixedAsset.client_id == client_id,
    ).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{client_id}/fixed-assets", response_model=List[schemas.FixedAssetRead])
def list_assets(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    assets = db.query(models.FixedAsset).filter(
        models.FixedAsset.client_id == client_id,
    ).order_by(models.FixedAsset.purchase_date).all()
    return [_enrich(a) for a in assets]


@router.get("/{client_id}/fixed-assets/export")
def export_schedule(
    client_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Download the depreciation schedule as an XLSX file."""
    _get_client_or_403(client_id, current_user, db)
    assets = db.query(models.FixedAsset).filter(
        models.FixedAsset.client_id == client_id,
    ).order_by(models.FixedAsset.purchase_date).all()
    enriched = [_enrich(a) for a in assets]

    wb = openpyxl.Workbook()

    # ── Styles ────────────────────────────────────────────────────────────────
    hdr_fill   = PatternFill("solid", fgColor="1E3A5F")
    hdr_font   = Font(bold=True, color="FFFFFF", size=10)
    total_font = Font(bold=True, size=10)
    title_font = Font(bold=True, size=12)
    thin       = Side(style="thin", color="CCCCCC")
    border     = Border(bottom=thin)
    center     = Alignment(horizontal="center", vertical="center")
    right      = Alignment(horizontal="right")

    def money(ws, row, col, val):
        c = ws.cell(row=row, column=col, value=round(val, 2) if val else 0)
        c.number_format = '#,##0.00'
        c.alignment = right
        return c

    def hdr_cell(ws, row, col, val):
        c = ws.cell(row=row, column=col, value=val)
        c.fill = hdr_fill
        c.font = hdr_font
        c.alignment = center
        return c

    # ── Sheet 1: Summary (one row per asset, one column per year) ────────────
    ws1 = wb.active
    ws1.title = "Schedule"

    # Collect all calendar years
    year_set: set[int] = set()
    for a in enriched:
        for p in a.schedule:
            year_set.add(int(p.period[:4]))
    years = sorted(year_set)

    # Title rows
    ws1.cell(row=1, column=1, value="Depreciation Schedule").font = title_font
    ws1.cell(row=2, column=1, value="For Financial Reporting Only.")
    ws1.merge_cells(start_row=4, start_column=9, end_row=4, end_column=max(9, 8 + len(years)))
    ws1.cell(row=4, column=9, value="Depreciation for Year …").font = Font(italic=True, size=9)
    ws1.cell(row=4, column=9).alignment = center

    # Header row: A=Asset B=Cost C=Accum.Dep D=Net Book Value E=YearAcq F=Salvage G=Life H=Method, then years
    headers = ["Asset", "Cost", "Accum.\nDep.", "Net Book\nValue", "Year\nAcquired", "Salvage\nValue", "Life\n(Yrs)", "Method"] + [str(y) for y in years]
    for col, h in enumerate(headers, 1):
        c = hdr_cell(ws1, 5, col, h)
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    ws1.row_dimensions[5].height = 30

    year_totals: dict[int, float] = {y: 0.0 for y in years}
    row = 6
    for asset in enriched:
        annual_dep: dict[int, float] = {y: 0.0 for y in years}
        for p in asset.schedule:
            y = int(p.period[:4])
            if y in annual_dep:
                annual_dep[y] = round(annual_dep[y] + p.depreciation, 2)

        method = "SL" if asset.depreciation_method == "straight_line" else "DDB"
        life = "Indefinite" if asset.is_indefinite_life else (
            f"{asset.useful_life_months / 12:.1f}" if asset.useful_life_months else "—"
        )

        ws1.cell(row=row, column=1, value=asset.name)
        money(ws1, row, 2, asset.purchase_price)
        money(ws1, row, 3, asset.accumulated_depreciation_to_date)
        money(ws1, row, 4, asset.net_book_value)
        ws1.cell(row=row, column=5, value=int(asset.purchase_date[:4])).alignment = center
        if asset.is_indefinite_life:
            ws1.cell(row=row, column=6, value="—").alignment = center
        else:
            money(ws1, row, 6, asset.salvage_value)
        ws1.cell(row=row, column=7, value=life).alignment = center
        ws1.cell(row=row, column=8, value=method).alignment = center
        for ci, y in enumerate(years, 9):
            dep = annual_dep[y]
            year_totals[y] = round(year_totals[y] + dep, 2)
            if dep:
                money(ws1, row, ci, dep)
            else:
                ws1.cell(row=row, column=ci, value=" - ").alignment = center
        row += 1

    # Total row
    row += 1
    ws1.cell(row=row, column=8, value="Total:").font = total_font
    for ci, y in enumerate(years, 9):
        c = money(ws1, row, ci, year_totals[y])
        c.font = total_font
        c.border = Border(top=thin)

    # Column widths
    col_widths = [34, 13, 14, 14, 10, 11, 9, 8] + [13] * len(years)
    for ci, w in enumerate(col_widths, 1):
        ws1.column_dimensions[get_column_letter(ci)].width = w

    # ── Sheet 2: Monthly Detail (pivot — one row per asset, months as columns) ──
    ws2 = wb.create_sheet("Monthly Detail")
    ws2.cell(row=1, column=1, value="Depreciation Schedule — Monthly Detail").font = title_font
    ws2.cell(row=2, column=1, value="For Financial Reporting Only.")

    # Collect all months across all assets
    month_set: set[str] = set()
    for a in enriched:
        for p in a.schedule:
            month_set.add(p.period)
    months = sorted(month_set)

    ws2.merge_cells(start_row=4, start_column=9, end_row=4, end_column=max(9, 8 + len(months)))
    ws2.cell(row=4, column=9, value="Depreciation for Month …").font = Font(italic=True, size=9)
    ws2.cell(row=4, column=9).alignment = center

    # Header row: same fixed columns as Schedule sheet, then months
    m_hdrs = ["Asset", "Cost", "Accum.\nDep.", "Net Book\nValue", "Year\nAcquired", "Salvage\nValue", "Life\n(Yrs)", "Method"] + months
    for col, h in enumerate(m_hdrs, 1):
        c = hdr_cell(ws2, 5, col, h)
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    ws2.row_dimensions[5].height = 30

    month_totals: dict[str, float] = {m: 0.0 for m in months}
    row2 = 6
    for asset in enriched:
        monthly_dep: dict[str, float] = {m: 0.0 for m in months}
        for p in asset.schedule:
            if p.period in monthly_dep:
                monthly_dep[p.period] = p.depreciation

        method = "SL" if asset.depreciation_method == "straight_line" else "DDB"
        life = "Indefinite" if asset.is_indefinite_life else (
            f"{asset.useful_life_months / 12:.1f}" if asset.useful_life_months else "—"
        )

        ws2.cell(row=row2, column=1, value=asset.name)
        money(ws2, row2, 2, asset.purchase_price)
        money(ws2, row2, 3, asset.accumulated_depreciation_to_date)
        money(ws2, row2, 4, asset.net_book_value)
        ws2.cell(row=row2, column=5, value=int(asset.purchase_date[:4])).alignment = center
        if asset.is_indefinite_life:
            ws2.cell(row=row2, column=6, value="—").alignment = center
        else:
            money(ws2, row2, 6, asset.salvage_value)
        ws2.cell(row=row2, column=7, value=life).alignment = center
        ws2.cell(row=row2, column=8, value=method).alignment = center
        for ci, m in enumerate(months, 9):
            dep = monthly_dep[m]
            month_totals[m] = round(month_totals[m] + dep, 2)
            if dep:
                money(ws2, row2, ci, dep)
            else:
                ws2.cell(row=row2, column=ci, value=" - ").alignment = center
        row2 += 1

    # Total row
    row2 += 1
    ws2.cell(row=row2, column=8, value="Total:").font = total_font
    for ci, m in enumerate(months, 9):
        c = money(ws2, row2, ci, month_totals[m])
        c.font = total_font
        c.border = Border(top=thin)

    # Column widths
    col_widths2 = [34, 13, 14, 14, 10, 11, 9, 8] + [10] * len(months)
    for ci, w in enumerate(col_widths2, 1):
        ws2.column_dimensions[get_column_letter(ci)].width = w

    # ── Stream response ───────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    month = date.today().strftime("%Y-%m")
    filename = f"depreciation-schedule-{month}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{client_id}/fixed-assets/suggest")
def suggest_asset(
    client_id: int,
    transaction_id: Optional[int] = Query(None),
    name: Optional[str] = Query(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    if transaction_id is not None:
        tx = db.query(models.Transaction).filter(
            models.Transaction.id == transaction_id,
            models.Transaction.client_id == client_id,
        ).first()
        if not tx:
            raise HTTPException(status_code=404, detail="Transaction not found")
        suggestion = _suggest(tx.description)
        suggestion["purchase_date"] = tx.date.strftime("%Y-%m-%d")
        suggestion["purchase_price"] = abs(tx.amount)
        return suggestion
    elif name:
        return _suggest(name)
    else:
        raise HTTPException(status_code=422, detail="Provide transaction_id or name")


@router.post("/{client_id}/fixed-assets", response_model=schemas.FixedAssetRead, status_code=201)
def create_asset(
    client_id: int,
    payload: schemas.FixedAssetCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)

    # Enforce GAAP rules for intangibles
    dep_method = payload.depreciation_method
    salvage = payload.salvage_value
    if payload.asset_type == "intangible":
        dep_method = "straight_line"
        salvage = 0.0

    asset = models.FixedAsset(
        client_id=client_id,
        transaction_id=payload.transaction_id,
        name=payload.name,
        category=payload.category,
        purchase_date=payload.purchase_date,
        purchase_price=payload.purchase_price,
        salvage_value=salvage,
        useful_life_months=payload.useful_life_months,
        depreciation_method=dep_method,
        asset_type=payload.asset_type,
        is_indefinite_life=payload.is_indefinite_life,
        qbo_asset_account=payload.qbo_asset_account,
        qbo_accum_dep_account=payload.qbo_accum_dep_account,
        qbo_dep_expense_account=payload.qbo_dep_expense_account,
        notes=payload.notes,
    )
    db.add(asset)
    db.flush()  # get asset.id

    # Recode the source transaction JE if provided
    if payload.je_id and payload.qbo_asset_account:
        je = db.query(models.JournalEntry).filter(
            models.JournalEntry.id == payload.je_id,
        ).first()
        if je:
            je.debit_account = payload.qbo_asset_account
            je.ai_reasoning = f"Recoded as fixed asset: {payload.name}"

    # Mark the source transaction as approved (not pending) so it leaves the review queue
    if payload.transaction_id:
        tx = db.query(models.Transaction).filter(
            models.Transaction.id == payload.transaction_id,
            models.Transaction.client_id == client_id,
        ).first()
        if tx:
            tx.status = models.TransactionStatus.approved
            tx.fixed_asset_id = asset.id

    db.commit()
    db.refresh(asset)

    # Generate historical depreciation/amortization JEs (skip indefinite-life assets like Goodwill)
    if not payload.is_indefinite_life:
        _generate_historical_dep_jes(asset, client_id, db)

    return _enrich(asset)


def _generate_historical_dep_jes(asset: models.FixedAsset, client_id: int, db: Session):
    """Generate depreciation JEs for all past periods, marked as already exported (assumed in QBO)."""
    schedule = _compute_schedule(asset)
    today_period = date.today().strftime("%Y-%m")

    existing_months = [
        f"{t.date.year}-{t.date.month:02d}"
        for t in db.query(models.Transaction).filter(
            models.Transaction.fixed_asset_id == asset.id,
            models.Transaction.source == "depreciation",
        ).all()
    ]

    _chart = _client_chart_names(client_id, db)
    for period in schedule:
        if period["period"] >= today_period:
            break  # don't auto-generate current or future months
        if period["period"] in existing_months:
            continue
        _create_dep_transaction(asset, period, client_id, db, status=models.TransactionStatus.exported,
                                chart_names=_chart)

    db.commit()


def _client_chart_names(client_id: int, db):
    """The client's live chart, for resolving depreciation accounts. None on failure."""
    try:
        import ai_coder as _ai
        import models as _m
        client = db.query(_m.Client).filter(_m.Client.id == client_id).first()
        return _ai._parse_coa_names(_ai._resolve_chart(client)) if client else None
    except Exception:
        return None


def _depreciation_accounts(asset, chart_names=None) -> tuple[str, str]:
    """(debit, credit) for one month of depreciation on `asset`.

    Depreciation never touches the asset account. It moves cost into expense
    and builds a contra-asset:

        DR  Depreciation Expense
        CR  Accumulated Depreciation

    The asset account only moves on purchase or disposal. This is enforced here
    rather than trusted from the asset record, because the record is populated
    by the AI when the asset is first recognised and it had set the *asset*
    account as the depreciation expense on two assets — so every month debited
    Long-term office equipment and grew the asset instead of expensing it.
    """
    term = "Amortization" if getattr(asset, "asset_type", "tangible") == "intangible" else "Depreciation"
    expense = (getattr(asset, "qbo_dep_expense_account", None) or f"{term} Expense").strip()
    accum = (getattr(asset, "qbo_accum_dep_account", None) or f"Accumulated {term}").strip()
    asset_acct = (getattr(asset, "qbo_asset_account", None) or "").strip()

    def _same(a: str, b: str) -> bool:
        if not a or not b:
            return False
        # "Long-term office equipment" and "Fixed Assets:Long-term office
        # equipment" are the same account under two spellings.
        return a.lower() == b.lower() or a.lower().endswith(":" + b.lower()) or b.lower().endswith(":" + a.lower())

    def _pick(keywords, fallback):
        for n in (chart_names or []):
            low = n.lower()
            if any(k in low for k in keywords) and "accumulated" not in low and not _same(n, asset_acct):
                return n
        return fallback

    if _same(expense, asset_acct):
        expense = _pick(
            ("amortization",) if term == "Amortization" else ("depreciation",),
            f"{term} Expense",
        )
    if _same(accum, asset_acct):
        accum = f"Accumulated {term}"
    return expense, accum


def _create_dep_transaction(
    asset: models.FixedAsset, period: dict, client_id: int, db: Session,
    status: models.TransactionStatus = models.TransactionStatus.pending,
    chart_names=None,
):
    y, m = int(period["period"].split("-")[0]), int(period["period"].split("-")[1])
    last_day = calendar.monthrange(y, m)[1]
    tx_date = datetime(y, m, last_day)
    month_label = tx_date.strftime("%B %Y")
    term = "Amortization" if getattr(asset, "asset_type", "tangible") == "intangible" else "Depreciation"
    memo = f"{term} - {asset.name} - {month_label}"

    tx = models.Transaction(
        client_id=client_id,
        description=memo,
        amount=period["depreciation"],
        date=tx_date,
        status=status,
        source="depreciation",
        fixed_asset_id=asset.id,
        imported_at=datetime.utcnow(),
    )
    db.add(tx)
    db.flush()

    debit_account, credit_account = _depreciation_accounts(asset, chart_names)
    je = models.JournalEntry(
        transaction_id=tx.id,
        je_number=next_je_number(db),
        debit_account=debit_account,
        credit_account=credit_account,
        amount=period["depreciation"],
        je_date=tx_date,
        memo=memo,
    )
    db.add(je)


@router.get("/{client_id}/fixed-assets/{asset_id}", response_model=schemas.FixedAssetRead)
def get_asset(
    client_id: int,
    asset_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    asset = _get_asset_or_404(asset_id, client_id, db)
    return _enrich(asset)


@router.put("/{client_id}/fixed-assets/{asset_id}", response_model=schemas.FixedAssetRead)
def update_asset(
    client_id: int,
    asset_id: int,
    payload: schemas.FixedAssetUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    asset = _get_asset_or_404(asset_id, client_id, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(asset, field, value)
    db.commit()
    db.refresh(asset)
    return _enrich(asset)


@router.post("/{client_id}/fixed-assets/{asset_id}/dispose", response_model=schemas.FixedAssetRead)
def dispose_asset(
    client_id: int,
    asset_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    asset = _get_asset_or_404(asset_id, client_id, db)
    asset.status = "disposed"
    db.commit()
    db.refresh(asset)
    return _enrich(asset)


@router.post("/{client_id}/fixed-assets/generate-depreciation")
def generate_depreciation(
    client_id: int,
    month: str = Query(...),  # "2026-04"
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_client_or_403(client_id, current_user, db)
    assets = db.query(models.FixedAsset).filter(
        models.FixedAsset.client_id == client_id,
        models.FixedAsset.status == "active",
    ).all()

    created = 0
    skipped = 0
    # One chart lookup for the whole run.
    _chart = _client_chart_names(client_id, db)

    for asset in assets:
        schedule = _compute_schedule(asset)
        period = next((p for p in schedule if p["period"] == month), None)
        if not period:
            skipped += 1
            continue

        # Check for duplicate
        existing_months = [
            f"{t.date.year}-{t.date.month:02d}"
            for t in db.query(models.Transaction).filter(
                models.Transaction.fixed_asset_id == asset.id,
                models.Transaction.source == "depreciation",
            ).all()
        ]
        if month in existing_months:
            skipped += 1
            continue

        _create_dep_transaction(asset, period, client_id, db, chart_names=_chart)

        # Update status if fully depreciated
        if schedule and schedule[-1]["period"] <= month:
            asset.status = "fully_depreciated"

        created += 1

    db.commit()
    return {"created": created, "skipped": skipped, "month": month}

# ── Read an asset off its receipt ────────────────────────────────────────────

_RECEIPT_MAX_BYTES = 20 * 1024 * 1024


@router.post("/{client_id}/fixed-assets/extract-receipt")
async def extract_asset_from_receipt(
    client_id: int,
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Read a receipt and return the Add Asset form, filled in.

    Fills a form; it does not create anything. Everything here is a proposal a
    person confirms, because the cost of a wrong useful life is a decade of
    wrong monthly entries and it is invisible once the schedule starts running.

    Accounts are resolved against the live chart rather than trusted. The model
    is asked for verbatim names, but asking is not enforcing — on invoices it
    returned "Legal Expenses" for a chart holding "Legal Fees" — so a name that
    does not resolve comes back as a suggestion the form leaves blank rather
    than a plausible-looking account nobody checks.
    """
    client = _get_client_or_403(client_id, current_user, db)

    media_type = _resolve_media_type(file.filename or "", file.content_type)
    if not media_type:
        raise HTTPException(400, "Unsupported file type. Upload a PDF or image (JPG, PNG, WEBP).")

    # Read in chunks and stop at the cap, rather than buffering a huge upload
    # in memory only to reject it afterwards.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > _RECEIPT_MAX_BYTES:
            raise HTTPException(413, "File too large (max 20 MB)")
        chunks.append(chunk)
    file_bytes = b"".join(chunks)
    if not file_bytes:
        raise HTTPException(400, "The file is empty.")
    if not _content_matches(file_bytes, media_type):
        raise HTTPException(400, f"That file is not really a {media_type}. Re-save it and try again.")

    try:
        chart = ai_coder._resolve_chart(client)
    except Exception:
        chart = None

    try:
        data = _extract_asset(file_bytes, media_type, chart)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        raise HTTPException(502, f"Could not read the receipt: {exc}")

    return data


def _extract_asset(file_bytes: bytes, media_type: str, chart: Optional[str]) -> dict:
    """Ask Claude what asset this receipt describes."""
    import base64
    import json as _json
    import os as _os

    api_key = _os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("AI is not configured on the server (no ANTHROPIC_API_KEY).")

    b64 = base64.standard_b64encode(file_bytes).decode("utf-8")
    kind = _CONTENT_TYPES[media_type]
    file_block = (
        {"type": "document", "source": {"type": "base64", "media_type": media_type, "data": b64}}
        if kind == "document"
        else {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}}
    )

    system = "\n".join([
        "You are an expert bookkeeper reading a purchase receipt to set up a fixed or intangible asset.",
        "Respond with ONLY valid JSON — no markdown fences, no explanation.",
        "",
        '{"name": "short asset name", "category": "<one of the categories below>",',
        ' "purchase_date": "YYYY-MM-DD", "purchase_price": 1234.56, "salvage_value": 0.0,',
        ' "useful_life_months": 60, "depreciation_method": "straight_line",',
        ' "asset_type": "tangible|intangible", "is_indefinite_life": false,',
        ' "qbo_asset_account": "", "qbo_accum_dep_account": "", "qbo_dep_expense_account": "",',
        ' "vendor": "", "confidence": 0.0, "reasoning": "one or two sentences"}',
        "",
        # These are exactly the options the Add Asset form offers. Returning
        # anything else means the form falls back to a blank category and the
        # autofill looks broken for the one field a person is least likely to
        # re-check.
        "category must be EXACTLY one of these.",
        "  Tangible (these depreciate):",
        "    Equipment, Furniture, Leasehold Improvements, Vehicles, Other",
        "  Intangible (these amortize):",
        "    Capitalized Software, Licenses, Patents, Trademarks, Customer Lists,",
        "    Non-Compete Agreements, Goodwill, Other Intangibles",
        "Set asset_type to match the half the category came from.",
        "",
        "Default useful_life_months by category, unless the receipt says otherwise:",
        "  Equipment 84, Furniture 84, Leasehold Improvements 120, Vehicles 60, Other 60",
        "  Capitalized Software 36, Licenses 36, Patents 240, Trademarks 120,",
        "  Customer Lists 60, Non-Compete Agreements 36, Other Intangibles 60",
        "  Computer hardware is Equipment with a 60-month life, not 84.",
        "  A domain name is a Trademark at 120 months.",
        "Goodwill is the only indefinite-life asset: useful_life_months 0 and",
        "is_indefinite_life true. Everything else gets a finite life.",
        "",
        "purchase_price is the capitalized cost: the asset plus anything needed to put it into",
        "service (delivery, installation, non-recoverable tax). Exclude recoverable sales tax,",
        "extended warranties and service plans — those are not part of the asset.",
        "",
        "purchase_date is the date on the receipt, not today.",
        "salvage_value is 0 unless the receipt states a residual or trade-in value.",
        "",
        "Set confidence below 0.5 when the document is not a purchase receipt at all, or when",
        "the price or date cannot be read. Say so plainly in reasoning. Do not invent a date or",
        "a price to fill the field — a blank a person notices is better than a number they do not.",
    ])
    if chart:
        system += (
            "\n\nUse ONLY these account names, copied verbatim, for the three account fields. "
            "If none fits, return an empty string for that field rather than inventing one.\n" + chart
        )

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model="claude-opus-5",
        max_tokens=1600,
        system=system,
        messages=[{"role": "user", "content": [file_block,
                   {"type": "text", "text": "Extract the asset details as JSON."}]}],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    try:
        data = _json.loads(raw)
    except Exception:
        raise RuntimeError("The AI did not return readable JSON for this receipt.")

    coa = _coa_index(chart)
    suggested: dict[str, str] = {}
    for key in ("qbo_asset_account", "qbo_accum_dep_account", "qbo_dep_expense_account"):
        name, ok = _resolve_account(data.get(key), coa)
        if ok:
            data[key] = name
        else:
            # Hand back what it proposed, separately, so the form can show
            # "we think X, pick the real one" instead of silently blanking.
            if data.get(key):
                suggested[key] = str(data[key])
            data[key] = ""
    data["unresolved_accounts"] = suggested

    # Keep the numbers sane before they reach a form a human will trust.
    try:
        data["purchase_price"] = round(abs(float(data.get("purchase_price") or 0)), 2)
    except Exception:
        data["purchase_price"] = 0.0
    try:
        data["salvage_value"] = round(abs(float(data.get("salvage_value") or 0)), 2)
    except Exception:
        data["salvage_value"] = 0.0
    try:
        life = int(data.get("useful_life_months") or 0)
    except Exception:
        life = 0
    data["useful_life_months"] = max(0, min(life, 600))
    if data.get("is_indefinite_life"):
        data["useful_life_months"] = 0
    if data.get("depreciation_method") not in ("straight_line", "double_declining"):
        data["depreciation_method"] = "straight_line"
    if data.get("asset_type") not in ("tangible", "intangible"):
        data["asset_type"] = "tangible"
    if data["salvage_value"] > data["purchase_price"]:
        data["salvage_value"] = 0.0
    return data
