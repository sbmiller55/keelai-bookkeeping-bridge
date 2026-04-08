## Project Structure

- **FastAPI routers with prefix and tags in dedicated files.** Each API domain gets its own file under \`backend/routers/\` with a single \`router = APIRouter(prefix="/...", tags=\["..."])\`. The main app file imports each router module and calls \`app.include\_router(module.router)\`. Pydantic BaseModel classes for request/response are defined at the top of each router file, not in a shared schemas file (unless also needed elsewhere).
  ```
  // Good
    # backend/routers/files.py
    router = APIRouter(prefix="/files", tags=["files"])
    
    class UploadResponse(BaseModel):
        path: str
        filename: str
    
    @router.post("/upload", response_model=UploadResponse)
    async def upload_file(...):

  // Bad
    # All routes in main.py
    @app.post("/files/upload")
    async def upload_file(...):
  ```

## Code Organization

- **Section headers in TypeScript files using box-drawing comment dividers.** The codebase organizes related code sections within files using comment dividers with Unicode box-drawing characters (─). This convention is used consistently in both frontend TypeScript (api.ts) and backend Python (chat.py) files to visually separate logical sections like Types, Auth, Clients, Transactions, File readers, System prompt builder, etc.
  ```
  // Good
    // ── Types ─────────────────────────────────────────────────────────────────────
    
    export interface User { ... }
    
    // ── Auth ──────────────────────────────────────────────────────────────────────
    
    export function login() { ... }

  // Bad
    /* Types */
    export interface User { ... }
    
    /* Auth */
    export function login() { ... }
  ```

## Backend Conventions

- **Environment-based feature switching with local fallback defaults.** Infrastructure abstractions (database, storage, etc.) are toggled between local dev and production modes by checking for an environment variable, with the local/simple option as the default fallback. The env var name directly indicates the production service (e.g., DATABASE\_URL, AWS\_S3\_BUCKET). Conditional logic is based on the presence or prefix of the env var value, not a separate MODE flag.
  ```
  // Good
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./bookkeeping.db")
    connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

  // Bad
    MODE = os.getenv("APP_MODE", "development")
    if MODE == "production":
        DATABASE_URL = os.getenv("DATABASE_URL")
    else:
        DATABASE_URL = "sqlite:///./bookkeeping.db"
  ```

- **Reference storage items as opaque strings resolved at read time via context manager.** Store file storage references (local paths or S3 keys) as opaque strings in the database. Resolve them at read time through a storage abstraction module that provides an \`as\_local\_path\` context manager. The context manager attempts multiple resolution strategies for backward compatibility, yields a Path for accessible files or None if not found, and handles cleanup of temporary files. This eliminates direct filesystem path manipulation and ensures existing records continue working across storage backends.
  ```
  // Good
    with storage.as_local_path(client.chart_of_accounts_path) as p:
        if p is None:
            return None
        return p.read_text(errors="replace")[:12000]
    
    # Upload returns opaque reference string
    ref = storage.upload(unique_name, contents)  # Returns S3 key or local path
    client.chart_of_accounts_path = ref

  // Bad
    # Storing absolute paths tied to specific environment
    client.chart_of_accounts_path = "/app/backend/uploads/coa.txt"
    
    # Direct path manipulation with manual fallback logic
    candidates = [UPLOADS_DIR / Path(path).name, Path(path)]
    for p in candidates:
        if not p.exists():
            continue
        return p.read_text(errors="replace")[:12000]
  ```

- **Fallback chain with \`or\` for extracting optional dict fields.** When extracting a value from an API response dict that may appear under multiple keys, use a chained \`or\` expression across .get() calls with a final fallback string. This provides graceful degradation through multiple possible field names without nested if/else blocks.
  ```
  // Good
    date_raw = txn.get("postedAt") or txn.get("createdAt") or txn.get("canonicalDay") or txn.get("estimatedDeliveryDate")
    description = txn.get("bankDescription") or txn.get("externalMemo") or txn.get("note") or txn.get("description") or counterparty or "No description"

  // Bad
    if "postedAt" in txn:
        date_raw = txn["postedAt"]
    elif "createdAt" in txn:
        date_raw = txn["createdAt"]
    elif "canonicalDay" in txn:
        date_raw = txn["canonicalDay"]
    else:
        date_raw = txn.get("estimatedDeliveryDate")
  ```

- **DB-agnostic schema migration using SQLAlchemy inspect().** When adding columns to existing tables without a migration framework, use SQLAlchemy's inspect() to check existing columns (not PRAGMA table\_info which is SQLite-only). Conditional SQL is used for SQLite vs PostgreSQL (ADD COLUMN vs ADD COLUMN IF NOT EXISTS). The migration list is a flat tuple array of (table, column, type).
  ```
  // Good
    insp = inspect(engine)
    for table, column, col_type in new_columns:
        existing_cols = [c["name"] for c in insp.get_columns(table)]
        if column not in existing_cols:
            if is_sqlite:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
            else:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}"))

  // Bad
    existing = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    col_names = [row[1] for row in existing]
    if column not in col_names:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
  ```

## Frontend Conventions

- **Centralize all API calls through typed apiFetch helper with automatic auth handling.** All API calls must go through a single \`apiFetch\<T>\` generic helper that handles auth token injection, JSON parsing, and centralized error handling. On 401 responses, it automatically clears the stored token and redirects to /login, preventing auth errors from propagating as unhandled exceptions. Each API endpoint gets a thin, typed wrapper function that delegates to \`apiFetch\` with proper generic type parameters. Use \`?? null\` for optional parameters and \`?? \[]\` for optional arrays in JSON-serialized request bodies to ensure explicit null/empty array values are sent to the backend rather than omitting undefined fields.
  ```
  // Good
    // Centralized apiFetch helper (in one place)
    export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
      const token = getToken();
      const res = await fetch(url, {
        ...options,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
      
      if (res.status === 401) {
        removeToken();
        window.location.href = "/login";
        throw new Error("Session expired");
      }
      
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    }
    
    // Thin typed wrappers (one-liners per endpoint)
    export function getClients(): Promise<Client[]> {
      return apiFetch<Client[]>("/clients/");
    }
    
    export function createClient(data: ClientCreate): Promise<Client> {
      return apiFetch<Client>("/clients/", {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          email: data.email ?? null,
          tags: data.tags ?? [],
        }),
      });
    }

  // Bad
    // Scattered fetch logic across components
    export async function getClients(): Promise<Client[]> {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/clients/`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json(); // 401 errors bubble up unhandled
    }
    
    // In component:
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Request failed"); // No automatic redirect
    
    // Body serialization without null defaults
    body: JSON.stringify({
      email: data.email,        // undefined → field omitted
      tags: data.tags,          // undefined → field omitted
    })
  ```

- **Wrap useSearchParams in Suspense boundary with spinner fallback.** Next.js 14+ requires useSearchParams() to be wrapped in a Suspense boundary for static export. The pattern is to extract the component using useSearchParams into a separate inner component (e.g., QboCallbackContent), then export a default page component that wraps it in \<Suspense> with a centered spinner fallback matching the app's dark theme.
  ```
  // Good
    function QboCallbackContent() {
      const searchParams = useSearchParams();
      // ... component logic
    }
    
    export default function QboCallbackPage() {
      return (
        <Suspense fallback={<div className="min-h-screen bg-gray-950 flex items-center justify-center"><div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" /></div>}>
          <QboCallbackContent />
        </Suspense>
      );
    }

  // Bad
    export default function QboCallbackPage() {
      const searchParams = useSearchParams();
      // ... component logic directly in the page
    }
  ```
