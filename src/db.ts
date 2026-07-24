import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const DB_PATH = process.env.DB_PATH ?? "./data/later.db";

let db: DB | null = null;

/**
 * Open (once) and return the shared DatabaseSync connection.
 * Applies PRAGMAs in order and ensures the schema exists.
 */
export function getDb(): DB {
  if (db) return db;

  // Ensure the parent directory exists (WAL requires a real local file).
  mkdirSync(dirname(DB_PATH), { recursive: true });

  db = new DatabaseSync(DB_PATH);

  // Order-sensitive PRAGMAs.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  migrate(db);
  return db;
}

function migrate(d: DB): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY,
      url         TEXT NOT NULL,
      domain      TEXT NOT NULL DEFAULT '',
      title       TEXT,
      note        TEXT,
      summary     TEXT,
      priority    INTEGER NOT NULL DEFAULT 0,
      is_read     INTEGER NOT NULL DEFAULT 0,
      added_at    INTEGER NOT NULL,
      read_at     INTEGER,
      archived_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS item_tags (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (item_id, tag_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_items_added_at    ON items(added_at);
    CREATE INDEX IF NOT EXISTS idx_items_domain      ON items(domain);
    CREATE INDEX IF NOT EXISTS idx_items_is_read     ON items(is_read);
    CREATE INDEX IF NOT EXISTS idx_items_archived_at ON items(archived_at);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag_id  ON item_tags(tag_id);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
