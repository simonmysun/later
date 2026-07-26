import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

import { getDb, closeDb } from "./db.ts";
import {
  createItem,
  getItem,
  hardDeleteItem,
  listItems,
  softDeleteItem,
  updateItem,
  type ListQuery,
} from "./items.ts";
import { listTagsWithCount } from "./tags.ts";
import {
  HttpError,
  badRequest,
  notFound,
  parseBool,
  parseEnum,
  parseNonNegInt,
  parseOptionalNonNegInt,
  readJsonBody,
  sendError,
  sendJson,
  unauthorized,
} from "./util.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const TOKEN = process.env.LATER_TOKEN;
const AUTH_READ = process.env.LATER_AUTH_READ === "true";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function requireToken(req: IncomingMessage): void {
  const header = req.headers["authorization"];
  const expected = `Bearer ${TOKEN}`;
  if (!TOKEN || header !== expected) throw unauthorized("missing or invalid token");
}

function parseListQuery(sp: URLSearchParams): ListQuery {
  const untagged = parseBool(sp.get("untagged"), "untagged");

  // tags: comma separated, trim + lowercase + drop empties.
  const rawTags = sp.get("tags");
  let tags: string[] | undefined;
  if (rawTags !== null) {
    tags = rawTags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    if (tags.length === 0) tags = undefined;
  }

  if (untagged && tags) {
    throw badRequest("tags and untagged are mutually exclusive");
  }

  const tag_mode = parseEnum(sp.get("tag_mode"), "tag_mode", ["and", "or"] as const, "or");
  const sort = parseEnum(
    sp.get("sort"),
    "sort",
    ["added_desc", "added_asc", "random"] as const,
    "added_desc",
  );
  const archived = parseEnum(
    sp.get("archived"),
    "archived",
    ["false", "true", "all"] as const,
    "false",
  );

  const domainRaw = sp.get("domain");
  const domain = domainRaw !== null ? domainRaw : undefined;

  // Exact URL match (used by automation scripts for dedup).
  const urlRaw = sp.get("url");
  const url = urlRaw !== null && urlRaw !== "" ? urlRaw : undefined;

  const from = parseOptionalNonNegInt(sp.get("from"), "from");
  const to = parseOptionalNonNegInt(sp.get("to"), "to");
  const read = parseBool(sp.get("read"), "read");
  const has_summary = parseBool(sp.get("has_summary"), "has_summary");

  const qRaw = sp.get("q");
  const q = qRaw !== null && qRaw !== "" ? qRaw : undefined;

  const limit = parseOptionalNonNegInt(sp.get("limit"), "limit");
  const offset = parseNonNegInt(sp.get("offset"), "offset", 0);

  return {
    tags,
    tag_mode,
    untagged: untagged === true ? true : undefined,
    domain,
    url,
    from,
    to,
    read,
    archived,
    has_summary,
    q,
    sort,
    limit,
    offset,
  };
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return false; // path traversal guard
  try {
    const data = await readFile(full);
    const ext = full.slice(full.lastIndexOf("."));
    const type = STATIC_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const db = getDb();

  // ---- API routes ----
  if (path.startsWith("/api/")) {
    // read auth toggle
    if (method === "GET" && AUTH_READ) requireToken(req);

    // GET /api/items
    if (path === "/api/items" && method === "GET") {
      const q = parseListQuery(url.searchParams);
      return sendJson(res, 200, listItems(db, q));
    }
    // POST /api/items
    if (path === "/api/items" && method === "POST") {
      requireToken(req);
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const item = createItem(db, {
        url: body.url,
        title: body.title,
        note: body.note,
        tags: body.tags,
        priority: body.priority,
      });
      return sendJson(res, 201, item);
    }

    // /api/items/:id
    const itemMatch = /^\/api\/items\/(\d+)$/.exec(path);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      if (method === "GET") {
        const item = getItem(db, id);
        if (!item) throw notFound("item not found");
        return sendJson(res, 200, item);
      }
      if (method === "PATCH") {
        requireToken(req);
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const item = updateItem(db, id, body);
        if (!item) throw notFound("item not found");
        return sendJson(res, 200, item);
      }
      if (method === "DELETE") {
        requireToken(req);
        const hard = url.searchParams.get("hard") === "true";
        if (hard) {
          const ok = hardDeleteItem(db, id);
          if (!ok) throw notFound("item not found");
          return sendJson(res, 200, { ok: true, hard: true });
        }
        const item = softDeleteItem(db, id);
        if (!item) throw notFound("item not found");
        return sendJson(res, 200, item);
      }
      throw new HttpError(405, "method not allowed");
    }

    // GET /api/tags
    if (path === "/api/tags" && method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "all";
      return sendJson(res, 200, listTagsWithCount(db, includeArchived));
    }

    throw notFound("unknown endpoint");
  }

  // ---- static (GET only) ----
  if (method === "GET" || method === "HEAD") {
    const served = await serveStatic(res, path);
    if (served) return;
  }

  throw notFound("not found");
}

export async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handle(req, res);
  } catch (err) {
    sendError(res, err);
  }
}

function main(): void {
  if (!TOKEN) {
    // eslint-disable-next-line no-console
    console.error("FATAL: LATER_TOKEN environment variable is required.");
    process.exit(1);
  }

  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "8787");

  getDb(); // open + migrate eagerly

  const server = createServer(requestListener);
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`later listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
