# Project Overview

- **Full-stack features are shipped in single commits spanning backend router + schemas + models + frontend page + api.ts.** New features are committed as atomic units containing all layers: SQLAlchemy model, Pydantic schemas, FastAPI router, frontend api.ts types/functions, and the page.tsx component. The commit message uses a bullet-list format describing Backend, DB, and Frontend changes. This ensures every commit is deployable and self-contained.

  **Good:**

  Commit message format:

  Add Fixed Asset Depreciation Schedule module

  - Backend: FixedAsset model, schemas, full router with schedule computation
  - DB migrations: transactions.source, transactions.fixed\_asset\_id, fixed\_assets table
  - Fixed Assets page: summary cards, asset list with expandable schedule
  - Nav: Fixed Assets added between Review Queue and Monthly Close

  **Bad:**

  Splitting a feature across multiple unrelated commits:

  Commit 1: Add FixedAsset model
  Commit 2: Add fixed assets schemas
  Commit 3: Add fixed assets router
  Commit 4: Add fixed assets frontend page

## Backend Conventions (FastAPI + SQLAlchemy)

- **Use \_get\_\<entity>\_or\_\<status> private helpers for auth/ownership checks in FastAPI routers.** Every FastAPI router defines private helper functions that combine resource lookup with authorization in a single call. These follow the naming pattern \_get\_\<entity>\_or\_\<status\_code> (e.g. \_get\_client\_or\_403, \_get\_asset\_or\_404, \_get\_transaction\_or\_404). Client ownership helpers return 403, while entity-not-found helpers return 404. A separate variant \_assert\_client\_owned exists in some routers. These are always called at the top of each endpoint handler to gate access before any business logic.

  **Good:**

  ```python
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
  ```

  **Bad:**

  ```python
  @router.get("/{client_id}/fixed-assets")
  def list_assets(client_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
      client = db.query(models.Client).filter(models.Client.id == client_id).first()
      if not client or client.user_id != current_user.id:
          raise HTTPException(status_code=403)
      # ... business logic inline with auth check
  ```

- **Pydantic schemas follow Create/Read/Update triple naming with Read including computed fields.** Every domain entity has three Pydantic schemas: \<Entity>Create (required fields for creation), \<Entity>Update (all Optional fields for partial updates), and \<Entity>Read (full representation including computed/derived fields and model\_config = {"from\_attributes": True}). The Read schema is used as the response\_model. Computed fields like aggregated totals or schedules are added to Read schemas with default values.

  **Good:**

  ```python
  class FixedAssetCreate(BaseModel):
      name: str
      category: str
      purchase_price: float
      useful_life_months: int

  class FixedAssetUpdate(BaseModel):
      name: Optional[str] = None
      category: Optional[str] = None

  class FixedAssetRead(BaseModel):
      id: int
      name: str
      # Computed fields
      monthly_depreciation: float = 0.0
      accumulated_depreciation_to_date: float = 0.0
      schedule: list[DepreciationPeriod] = []
      model_config = {"from_attributes": True}
  ```

  **Bad:**

  ```python
  class FixedAsset(BaseModel):
      id: Optional[int] = None
      name: str
      category: str
      # Using one schema for both create and read
  ```

- **Use model\_dump(exclude\_unset=True) with setattr loop for PATCH-style updates.** All Update endpoints use a consistent pattern: accept a Pydantic schema where all fields are Optional with default None, then apply only the fields the client actually sent using model\_dump(exclude\_unset=True) iterated with setattr. This gives PATCH semantics through PUT endpoints without needing to distinguish between 'field set to None' and 'field not sent'.

  **Good:**

  ```python
  @router.put("/{client_id}/fixed-assets/{asset_id}")
  def update_asset(client_id: int, asset_id: int, payload: schemas.FixedAssetUpdate, ...):
      asset = _get_asset_or_404(asset_id, client_id, db)
      for field, value in payload.model_dump(exclude_unset=True).items():
          setattr(asset, field, value)
      db.commit()
      db.refresh(asset)
      return _enrich(asset)
  ```

  **Bad:**

  ```python
  @router.put("/{client_id}/fixed-assets/{asset_id}")
  def update_asset(client_id: int, asset_id: int, payload: schemas.FixedAssetUpdate, ...):
      asset = _get_asset_or_404(asset_id, client_id, db)
      asset.name = payload.name if payload.name is not None else asset.name
      asset.category = payload.category if payload.category is not None else asset.category
      # ... repeat for every field
      db.commit()
  ```

- **Use inline string comments for enum-like column values instead of Python Enum types.** SQLAlchemy String columns that hold a fixed set of values document their options via inline comments rather than using Python Enum types or SQLAlchemy Enum columns. The pattern is: Column(String, default="value") followed by a comment listing valid values. This avoids migration complexity from Enum changes and keeps the schema flexible.

  **Good:**

  ```python
  status = Column(String, default="active", nullable=False)  # active, fully_depreciated, disposed
  depreciation_method = Column(String, default="straight_line", nullable=False)  # straight_line, double_declining
  recurrence = Column(String, nullable=False, default="monthly")
  # recurrence values: "monthly", "quarter_end", "once"
  ```

  **Bad:**

  ```python
  class AssetStatus(enum.Enum):
      active = "active"
      fully_depreciated = "fully_depreciated"
      disposed = "disposed"

  status = Column(Enum(AssetStatus), default=AssetStatus.active, nullable=False)
  ```

- **Use \_enrich() helpers to compute derived fields onto Read schemas before returning.** When a Read schema contains computed/derived fields (like aggregated totals or schedules), a private \_enrich() function takes the SQLAlchemy model and returns a fully-populated Pydantic Read schema with computed values set. The endpoint returns \_enrich(model) rather than the raw model. This keeps computation logic out of the endpoint handler and makes it reusable across list and detail endpoints.

  **Good:**

  ```python
  def _enrich(asset: models.FixedAsset) -> schemas.FixedAssetRead:
      schedule = _compute_schedule(asset)
      today_period = date.today().strftime("%Y-%m")
      accum = sum(p["depreciation"] for p in schedule if p["period"] <= today_period)
      r = schemas.FixedAssetRead.model_validate(asset)
      r.schedule = [schemas.DepreciationPeriod(**p) for p in schedule]
      r.accumulated_depreciation_to_date = round(accum, 2)
      return r

  @router.get("/{client_id}/fixed-assets", response_model=List[schemas.FixedAssetRead])
  def list_assets(...):
      assets = db.query(models.FixedAsset).filter(...).all()
      return [_enrich(a) for a in assets]
  ```

  **Bad:**

  ```python
  @router.get("/{client_id}/fixed-assets")
  def list_assets(...):
      assets = db.query(models.FixedAsset).filter(...).all()
      results = []
      for a in assets:
          schedule = _compute_schedule(a)
          # Inline computation cluttering the endpoint
          r = schemas.FixedAssetRead.model_validate(a)
          r.schedule = schedule
          results.append(r)
      return results
  ```

- **Move complex file generation (XLSX, PDF) to backend endpoints returning StreamingResponse.** When generating complex file exports (especially XLSX with formatting/styling), the work is done server-side using openpyxl and streamed via FastAPI's StreamingResponse. The frontend makes a simple fetch with auth and triggers a download via blob URL. This replaces client-side JS library usage (like the xlsx npm package) which was found to be unreliable.

  **Good:**

  ```python
  @router.get("/{client_id}/fixed-assets/export")
  def export_schedule(client_id: int, current_user = Depends(get_current_user), db = Depends(get_db)):
      wb = openpyxl.Workbook()
      # ... build sheets with styles ...
      buf = io.BytesIO()
      wb.save(buf)
      buf.seek(0)
      return StreamingResponse(
          buf,
          media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          headers={"Content-Disposition": f'attachment; filename="{filename}"'},
      )
  ```

  **Bad:**

  ```typescript
  // Don't generate XLSX client-side with npm packages
  import * as XLSX from "xlsx";
  function exportScheduleXlsx(assets: FixedAsset[]) {
    const wb = XLSX.utils.book_new();
    // ... limited styling, large bundle size
    XLSX.writeFile(wb, filename);
  }
  ```

## Frontend Conventions (Next.js + Tailwind)

- **Each page is a single "use client" file with inline sub-components, not split into separate files.** Feature pages are built as single large page.tsx files containing all UI sub-components (forms, rows, panels, modals) defined as local functions within the same file. Helper functions (formatting, date logic, CSV export) are also defined at the top of the same file. Components are not extracted into separate files in a components/ directory. This keeps each feature self-contained in one file.

  **Good:**

  ```typescript
  // frontend/app/(app)/clients/[id]/fixed-assets/page.tsx
  "use client";

  function fmt(n: number) { /* ... */ }
  function statusBadge(status: string) { /* ... */ }
  function EditPanel({ asset, accounts, onSave, onClose }: { ... }) { /* ... */ }
  function AssetRow({ asset, onEdit, onDispose }: { ... }) { /* ... */ }

  export default function FixedAssetsPage() { /* ... */ }
  ```

  **Bad:**

  ```typescript
  // Don't split into separate component files
  // components/fixed-assets/EditPanel.tsx
  // components/fixed-assets/AssetRow.tsx
  // app/clients/[id]/fixed-assets/page.tsx imports from above
  ```

- **Use dark theme Tailwind classes with gray-800/900 backgrounds and indigo accent for all UI components.** All UI follows a consistent dark theme: bg-gray-900 for cards/panels, border-gray-800 for borders, text-gray-400/500 for secondary text, text-white for primary text, and bg-indigo-600/700 for primary action buttons. Form inputs use bg-gray-800 border-gray-700. Status colors use semantic accents (green-400 for positive, yellow-400 for warnings, red-400/500 for destructive). Badges use bg-\<color>-900/50 with border-\<color>-800.

  **Good:**

  ```typescript
  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500";

  <button className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">
  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
  ```

  **Bad:**

  ```typescript
  // Don't use light theme or inconsistent color tokens
  <button className="bg-blue-500 text-white py-2 rounded">
  <div className="bg-white border border-gray-200 rounded-lg p-5">
  ```
