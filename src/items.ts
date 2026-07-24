import type { SQLInputValue } from "node:sqlite";
import type { DB } from "./db.ts";
import { upsertTag } from "./tags.ts";
import {
  badRequest,
  normalizeOptionalText,
  normalizeTags,
  parseDomain,
  toBool,
} from "./util.ts";

const LIMIT_HARD_CAP = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_RANDOM_LIMIT = 10;

/** Public JSON shape returned by every endpoint that returns an item. */
export interface ItemResponse {
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

interface ItemRow {
  id: number;
  url: string;
  domain: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  priority: number;
  is_read: number;
  added_at: number;
  read_at: number | null;
  archived_at: number | null;
}

function rowToResponse(row: ItemRow, tags: string[]): ItemResponse {
  return {
    id: row.id,
    url: row.url,
    domain: row.domain,
    title: row.title ?? null,
    note: row.note ?? null,
    summary: row.summary ?? null,
    priority: row.priority,
    is_read: toBool(row.is_read),
    added_at: row.added_at,
    read_at: row.read_at ?? null,
    archived_at: row.archived_at ?? null,
    tags,
  };
}

/** Fetch tag names for a set of item ids in one query (avoids N+1). */
function tagsForItems(db: DB, ids: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const id of ids) map.set(id, []);
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT it.item_id AS item_id, t.name AS name
       FROM item_tags it
       JOIN tags t ON t.id = it.tag_id
       WHERE it.item_id IN (${placeholders})
       ORDER BY t.name ASC`,
    )
    .all(...ids) as unknown as Array<{ item_id: number; name: string }>;
  for (const r of rows) {
    const arr = map.get(r.item_id);
    if (arr) arr.push(r.name);
  }
  return map;
}

function tagsForItem(db: DB, id: number): string[] {
  return tagsForItems(db, [id]).get(id) ?? [];
}

// ---- create ----

export interface CreateItemInput {
  url: unknown;
  title?: unknown;
  note?: unknown;
  tags?: unknown;
  priority?: unknown;
}

export function createItem(db: DB, input: CreateItemInput): ItemResponse {
  if (typeof input.url !== "string" || input.url.trim() === "") {
    throw badRequest("url is required and must be a non-empty string");
  }
  const url = input.url;
  const domain = parseDomain(url);

  const title = normalizeOptionalText(input.title) ?? null;
  const note = normalizeOptionalText(input.note) ?? null;
  const tags = normalizeTags(input.tags);

  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== "number" || !Number.isInteger(input.priority)) {
      throw badRequest("priority must be an integer");
    }
    priority = input.priority;
  }

  const addedAt = Date.now();

  db.exec("BEGIN");
  try {
    const res = db
      .prepare(
        `INSERT INTO items(url, domain, title, note, summary, priority, is_read, added_at, read_at, archived_at)
         VALUES(?, ?, ?, ?, NULL, ?, 0, ?, NULL, NULL)`,
      )
      .run(url, domain, title, note, priority, addedAt);
    const id = Number(res.lastInsertRowid);
    for (const name of tags) {
      const tagId = upsertTag(db, name);
      db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?, ?)").run(id, tagId);
    }
    db.exec("COMMIT");
    return getItem(db, id)!;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- read ----

export function getItem(db: DB, id: number): ItemResponse | null {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as
    | ItemRow
    | undefined;
  if (!row) return null;
  return rowToResponse(row, tagsForItem(db, id));
}

export interface ListQuery {
  tags?: string[];
  tag_mode: "and" | "or";
  untagged?: boolean;
  domain?: string;
  from?: number;
  to?: number;
  read?: boolean;
  archived: "false" | "true" | "all";
  has_summary?: boolean;
  q?: string;
  sort: "added_desc" | "added_asc" | "random";
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: ItemResponse[];
  total?: number;
  limit?: number;
  offset?: number;
}

/** Build the WHERE clause + params shared by list and count. */
function buildWhere(q: ListQuery): { clause: string; params: SQLInputValue[] } {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];

  // archived
  if (q.archived === "false") conds.push("i.archived_at IS NULL");
  else if (q.archived === "true") conds.push("i.archived_at IS NOT NULL");
  // "all" => no condition

  if (q.domain !== undefined) {
    conds.push("i.domain = ?");
    params.push(q.domain);
  }
  if (q.from !== undefined) {
    conds.push("i.added_at >= ?");
    params.push(q.from);
  }
  if (q.to !== undefined) {
    conds.push("i.added_at <= ?");
    params.push(q.to);
  }
  if (q.read !== undefined) {
    conds.push("i.is_read = ?");
    params.push(q.read ? 1 : 0);
  }
  if (q.has_summary === true) {
    conds.push("i.summary IS NOT NULL AND i.summary <> ''");
  } else if (q.has_summary === false) {
    conds.push("(i.summary IS NULL OR i.summary = '')");
  }
  if (q.q !== undefined && q.q !== "") {
    conds.push(
      "(i.url LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.note LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')",
    );
    const el = `%${escapeLike(q.q)}%`;
    params.push(el, el, el, el);
  }

  // tags / untagged
  if (q.untagged) {
    conds.push("i.id NOT IN (SELECT item_id FROM item_tags)");
  } else if (q.tags && q.tags.length > 0) {
    const ph = q.tags.map(() => "?").join(",");
    if (q.tag_mode === "and") {
      conds.push(
        `i.id IN (
          SELECT it.item_id FROM item_tags it
          JOIN tags t ON t.id = it.tag_id
          WHERE t.name IN (${ph})
          GROUP BY it.item_id
          HAVING COUNT(DISTINCT t.id) = ?
        )`,
      );
      params.push(...q.tags, q.tags.length);
    } else {
      conds.push(
        `i.id IN (
          SELECT it.item_id FROM item_tags it
          JOIN tags t ON t.id = it.tag_id
          WHERE t.name IN (${ph})
        )`,
      );
      params.push(...q.tags);
    }
  }

  const clause = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return { clause, params };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function listItems(db: DB, q: ListQuery): ListResult {
  const { clause, params } = buildWhere(q);

  if (q.sort === "random") {
    const limit = clampLimit(q.limit ?? DEFAULT_RANDOM_LIMIT);
    const rows = db
      .prepare(`SELECT * FROM items i ${clause} ORDER BY RANDOM() LIMIT ?`)
      .all(...params, limit) as unknown as ItemRow[];
    return { items: assemble(db, rows) };
  }

  const orderBy =
    q.sort === "added_asc" ? "ORDER BY i.added_at ASC, i.id ASC" : "ORDER BY i.added_at DESC, i.id DESC";
  const limit = clampLimit(q.limit ?? DEFAULT_LIMIT);
  const offset = q.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM items i ${clause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as ItemRow[];

  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM items i ${clause}`).get(...params) as {
    n: number;
  };

  return { items: assemble(db, rows), total: Number(countRow.n), limit, offset };
}

function clampLimit(n: number): number {
  return Math.min(Math.max(n, 0), LIMIT_HARD_CAP);
}

function assemble(db: DB, rows: ItemRow[]): ItemResponse[] {
  const ids = rows.map((r) => r.id);
  const tagMap = tagsForItems(db, ids);
  return rows.map((r) => rowToResponse(r, tagMap.get(r.id) ?? []));
}

// ---- update ----

export interface UpdateItemInput {
  title?: unknown;
  note?: unknown;
  summary?: unknown;
  priority?: unknown;
  is_read?: unknown;
  tags?: unknown;
  archived?: unknown;
}

export function updateItem(db: DB, id: number, input: UpdateItemInput): ItemResponse | null {
  const existing = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as
    | ItemRow
    | undefined;
  if (!existing) return null;

  const sets: string[] = [];
  const params: SQLInputValue[] = [];

  if ("title" in input && input.title !== undefined) {
    sets.push("title = ?");
    params.push(normalizeOptionalText(input.title) ?? null);
  }
  if ("note" in input && input.note !== undefined) {
    sets.push("note = ?");
    params.push(normalizeOptionalText(input.note) ?? null);
  }
  if ("summary" in input && input.summary !== undefined) {
    // Empty / whitespace-only => NULL (consistent with has_summary).
    let summary: string | null = null;
    if (input.summary !== null) {
      if (typeof input.summary !== "string") throw badRequest("summary must be a string or null");
      summary = input.summary.trim() === "" ? null : input.summary;
    }
    sets.push("summary = ?");
    params.push(summary);
  }
  if ("priority" in input && input.priority !== undefined) {
    if (typeof input.priority !== "number" || !Number.isInteger(input.priority)) {
      throw badRequest("priority must be an integer");
    }
    sets.push("priority = ?");
    params.push(input.priority);
  }
  if ("is_read" in input && input.is_read !== undefined) {
    const next = coerceBoolInput(input.is_read, "is_read");
    sets.push("is_read = ?");
    params.push(next ? 1 : 0);
    // read_at linkage
    const wasRead = existing.is_read === 1;
    if (next && !wasRead) {
      sets.push("read_at = ?");
      params.push(Date.now());
    } else if (!next && wasRead) {
      sets.push("read_at = NULL");
    }
  }
  if ("archived" in input && input.archived !== undefined) {
    const next = coerceBoolInput(input.archived, "archived");
    const isArchived = existing.archived_at !== null;
    if (next && !isArchived) {
      sets.push("archived_at = ?");
      params.push(Date.now());
    } else if (!next && isArchived) {
      sets.push("archived_at = NULL");
    }
  }

  const replaceTags = "tags" in input && input.tags !== undefined;
  const newTags = replaceTags ? normalizeTags(input.tags) : [];

  if (sets.length === 0 && !replaceTags) {
    // Nothing to change; return current state.
    return getItem(db, id);
  }

  db.exec("BEGIN");
  try {
    if (sets.length > 0) {
      db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }
    if (replaceTags) {
      db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(id);
      for (const name of newTags) {
        const tagId = upsertTag(db, name);
        db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?, ?)").run(id, tagId);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getItem(db, id);
}

function coerceBoolInput(v: unknown, name: string): boolean {
  if (typeof v === "boolean") return v;
  if (v === 1) return true;
  if (v === 0) return false;
  throw badRequest(`${name} must be a boolean`);
}

// ---- delete ----

/** Soft delete: archive. Returns updated item, or null if not found. */
export function softDeleteItem(db: DB, id: number): ItemResponse | null {
  return updateItem(db, id, { archived: true });
}

/** Hard delete from the database (cascades item_tags). Returns true if a row was removed. */
export function hardDeleteItem(db: DB, id: number): boolean {
  const res = db.prepare("DELETE FROM items WHERE id = ?").run(id);
  return res.changes > 0;
}
