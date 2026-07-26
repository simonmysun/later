/**
 * Shared HTTP client for the `later` app used by the automation scripts.
 *
 * All communication is over HTTP against the app's public API — scripts never
 * touch the SQLite DB directly, and they NEVER write the `note` field (it is
 * user-authored). De-duplication is done by exact URL match via the `url=`
 * query parameter (with `archived=all` so archived duplicates are also found).
 *
 * Config (env):
 *   LATER_BASE_URL   default http://127.0.0.1:8787
 *   LATER_TOKEN      required for writes (POST/PATCH); reads work without it
 *                    unless the server has LATER_AUTH_READ=true.
 */

export interface Item {
  id: number;
  url: string;
  domain: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  priority: number;
  is_read: boolean;
  added_at: number;
  read_at: number | null;
  archived_at: number | null;
  tags: string[];
}

interface ListResult {
  items: Item[];
  total?: number;
  limit?: number;
  offset?: number;
}

/** Fields a script is allowed to send when creating an item. Note is excluded by design. */
export interface CreateInput {
  url: string;
  title?: string;
  tags?: string[];
  priority?: number;
}

/** Fields a script is allowed to send when patching an item. Note is excluded by design. */
export interface PatchInput {
  title?: string;
  summary?: string | null;
  tags?: string[];
  priority?: number;
  is_read?: boolean;
  archived?: boolean;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LaterClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly maxRetries: number;

  constructor(opts?: { baseUrl?: string; token?: string; maxRetries?: number }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.LATER_BASE_URL ?? "http://127.0.0.1:8787").replace(
      /\/+$/,
      "",
    );
    this.token = opts?.token ?? process.env.LATER_TOKEN;
    this.maxRetries = opts?.maxRetries ?? 4;
  }

  private requireToken(): string {
    if (!this.token) {
      throw new Error(
        "LATER_TOKEN is required for write operations. Set it in the environment.",
      );
    }
    return this.token;
  }

  /** fetch with retry/backoff on 429 + 5xx and network errors. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    auth = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers["Authorization"] = `Bearer ${this.requireToken()}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.baseUrl + path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
      }
    }
    throw new Error(`request failed after retries: ${method} ${path}: ${String(lastErr)}`);
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch {
        /* keep raw text */
      }
      throw new Error(`${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** True if an item with this exact URL already exists (including archived). */
  async existsByUrl(url: string): Promise<boolean> {
    const path = `/api/items?url=${encodeURIComponent(url)}&archived=all&limit=1`;
    const res = await this.request("GET", path);
    const data = await this.json<ListResult>(res);
    return data.items.length > 0;
  }

  /**
   * Create an item unless one with the same exact URL already exists.
   * Returns the created item, or null if it was skipped as a duplicate.
   * Never sends `note`.
   */
  async createIfNew(input: CreateInput): Promise<Item | null> {
    if (await this.existsByUrl(input.url)) return null;
    const body: CreateInput = { url: input.url };
    if (input.title !== undefined) body.title = input.title;
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.priority !== undefined) body.priority = input.priority;
    const res = await this.request("POST", "/api/items", body, true);
    return this.json<Item>(res);
  }

  /** Iterate all items lacking a summary (active items only), paginating. */
  async *listNeedingSummary(pageSize = 100): AsyncGenerator<Item> {
    let offset = 0;
    for (;;) {
      const path =
        `/api/items?has_summary=false&archived=false&sort=added_asc` +
        `&limit=${pageSize}&offset=${offset}`;
      const res = await this.request("GET", path);
      const data = await this.json<ListResult>(res);
      for (const it of data.items) yield it;
      const got = data.items.length;
      offset += got;
      if (got < pageSize || offset >= (data.total ?? offset)) break;
    }
  }

  /** Fetch a single item by id, or null if it does not exist. */
  async getItem(id: number): Promise<Item | null> {
    const res = await this.request("GET", `/api/items/${id}`);
    if (res.status === 404) {
      await res.text();
      return null;
    }
    return this.json<Item>(res);
  }

  /** PATCH an item. `note` is intentionally not part of PatchInput. */
  async patchItem(id: number, patch: PatchInput): Promise<Item> {
    const res = await this.request("PATCH", `/api/items/${id}`, patch, true);
    return this.json<Item>(res);
  }

  /**
   * Search items whose text matches `q` (LIKE substring). Paginated helper used
   * to find summary-failure placeholders. Callers must re-verify client-side.
   */
  async *search(q: string, archived: "false" | "true" | "all" = "all", pageSize = 100): AsyncGenerator<Item> {
    let offset = 0;
    for (;;) {
      const path =
        `/api/items?q=${encodeURIComponent(q)}&archived=${archived}` +
        `&has_summary=true&limit=${pageSize}&offset=${offset}`;
      const res = await this.request("GET", path);
      const data = await this.json<ListResult>(res);
      for (const it of data.items) yield it;
      const got = data.items.length;
      offset += got;
      if (got < pageSize || offset >= (data.total ?? offset)) break;
    }
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 250);
}

/** Small helper for pacing external (non-app) HTTP calls politely. */
export async function paced<T>(items: T[], delayMs: number, fn: (t: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    await fn(items[i]!);
    if (delayMs > 0 && i < items.length - 1) await sleep(delayMs);
  }
}

export { sleep };
