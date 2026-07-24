import type { DB } from "./db.ts";

export interface TagWithCount {
  name: string;
  count: number;
}

/**
 * Insert the tag if missing and return its id. Assumes a caller-managed
 * transaction. Tag names are expected to be pre-normalized.
 */
export function upsertTag(db: DB, name: string): number {
  const existing = db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as unknown as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const res = db.prepare("INSERT INTO tags(name) VALUES(?)").run(name);
  return Number(res.lastInsertRowid);
}

/**
 * List tags with item counts. By default counts only active (non-archived)
 * items so the filter panel matches the default list.
 */
export function listTagsWithCount(db: DB, includeArchived: boolean): TagWithCount[] {
  const sql = `
    SELECT t.name AS name, COUNT(i.id) AS count
    FROM tags t
    LEFT JOIN item_tags it ON it.tag_id = t.id
    LEFT JOIN items i ON i.id = it.item_id
      ${includeArchived ? "" : "AND i.archived_at IS NULL"}
    GROUP BY t.id
    ORDER BY count DESC, t.name ASC
  `;
  const rows = db.prepare(sql).all() as unknown as Array<{ name: string; count: number }>;
  return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
}
