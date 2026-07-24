# later

A minimal, single-user reading-list manager: record URLs with tags, notes and
priority, then filter and sort them (newest / oldest / random). Backend is
Node.js + TypeScript using the built-in `node:sqlite` and `node:http` modules —
**no runtime dependencies, no build step**. The frontend is a single static
`index.html` served by the backend.

The `summary` field (AI summary) is only stored; this service never fetches web
pages or calls an LLM. An **external service** fills summaries by polling
`GET /api/items?has_summary=false` and `PATCH`ing the result back.

## Requirements

- **Node.js >= 24** (LTS or newer). `node:sqlite` is stable there and can run
  `.ts` files directly with no build step.

```sh
node --version   # must be v24 or newer
```

## Setup

```sh
cp .env.example .env      # then edit LATER_TOKEN
npm install               # only devDependencies (typescript, @types/node)
```

Environment variables (see `.env.example`):

| Var               | Default              | Meaning                                            |
| ----------------- | -------------------- | -------------------------------------------------- |
| `LATER_TOKEN`     | (required)           | Bearer token for write operations (POST/PATCH/DELETE) |
| `HOST`            | `127.0.0.1`          | Bind address (localhost only by default)           |
| `PORT`            | `8787`               | Listen port                                        |
| `DB_PATH`         | `./data/later.db`    | SQLite file path (WAL sidecar files created beside it) |
| `LATER_AUTH_READ` | `false`              | If `true`, also require the token on GET requests  |

## Run

```sh
# load .env into the environment however you prefer, e.g.:
export $(grep -v '^#' .env | xargs)

npm start        # node src/server.ts
npm run dev      # node --watch src/server.ts (auto-restart)
```

Then open http://127.0.0.1:8787/ and set your token in the top-right field
(stored in `localStorage`) before adding/editing items.

Type-check and test:

```sh
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

## Run with Docker

The image runs the `.ts` source directly on Node 24 (no build) as a non-root
user, with no runtime dependencies.

```sh
cp .env.example .env      # set LATER_TOKEN (docker compose reads it from here)

docker compose up -d      # build + start
docker compose logs -f    # follow logs
docker compose down       # stop
```

By default the port is published only to `127.0.0.1:8787` on the host. The
SQLite database (and its `-wal`/`-shm` sidecars) is persisted to `./data` via a
bind mount. Change the published address in `docker-compose.yml` if you need to
reach it from other hosts, and consider `LATER_AUTH_READ=true` in that case.

Plain Docker without compose:

```sh
docker build -t later:latest .
docker run -d --name later \
  -e LATER_TOKEN=change-me \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/data:/app/data" \
  later:latest
```

## API

JSON over HTTP. Write operations require `Authorization: Bearer <LATER_TOKEN>`.
Reads are open by default (personal tool bound to localhost); set
`LATER_AUTH_READ=true` to require the token on reads too.

### Item shape

Every endpoint that returns an item uses the same shape:

```json
{
  "id": 1,
  "url": "https://example.com/article",
  "domain": "example.com",
  "title": null,
  "note": null,
  "summary": null,
  "priority": 0,
  "is_read": false,
  "added_at": 1721790000000,
  "read_at": null,
  "archived_at": null,
  "tags": ["tag-a", "tag-b"]
}
```

- Time fields are **epoch milliseconds** integers (or `null`). Same unit as the
  `from`/`to` query params. Format client-side with `new Date(ms)`.
- `is_read` is a boolean. `archived_at` non-null means archived.
- Empty text fields (`title`/`note`/`summary`) are returned as `null`, not `""`.

### `POST /api/items` — create

Body: `url` (required, non-empty string; not required to be http/https),
optional `title`, `note`, `tags` (string array), `priority` (integer).
`is_read` / `summary` / `archived` are **ignored** on create. Returns `201`
with the created item. No de-duplication — the same URL may be added repeatedly.

### `GET /api/items` — list, filter, sort

Query params:

| Param         | Values                                            | Notes |
| ------------- | ------------------------------------------------- | ----- |
| `tags`        | comma-separated tag names                         | trimmed + lowercased |
| `tag_mode`    | `and` \| `or` (default `or`)                       | `and` = all tags present |
| `untagged`    | `true`                                            | mutually exclusive with `tags` |
| `domain`      | exact host match                                  | `domain=` matches unparseable-URL items |
| `from` / `to` | epoch ms, inclusive range on `added_at`           | non-negative integers |
| `read`        | `true` \| `false`                                  | |
| `archived`    | `false` (default) \| `true` \| `all`               | default hides archived |
| `has_summary` | `true` \| `false`                                  | `false` = summary NULL or empty |
| `q`           | keyword                                           | LIKE across url/title/note/summary |
| `sort`        | `added_desc` (default) \| `added_asc` \| `random`  | non-random sorts have `id` tiebreak |
| `limit`       | default 50 (10 for random), hard cap 200          | over cap is clamped, not an error |
| `offset`      | default 0 (ignored for random)                    | |

Response (non-random): `{ "items": [...], "total": N, "limit": L, "offset": O }`.
Response (random): `{ "items": [...] }`.

Invalid enum/boolean/integer params return `400`.

### `GET /api/items/:id` — one item

### `PATCH /api/items/:id` — update

Body: any subset of `title`, `note`, `summary`, `priority`, `is_read`, `tags`,
`archived`. Only provided fields change.

- `is_read` `false→true` sets `read_at`; `true→false` clears it.
- `archived` `true` sets `archived_at` (if not already archived); `false` clears
  it (restore). This is the archive/restore entry point.
- `tags` replaces the item's whole tag set.
- `summary` empty/whitespace is normalized to `null`.

### `DELETE /api/items/:id` — soft delete (archive)

Equivalent to `PATCH {archived:true}`; the item stays in the DB.
`DELETE /api/items/:id?hard=true` permanently deletes (cascades `item_tags`).

### `GET /api/tags` — tags with counts

Returns `[{ "name": "...", "count": N }, ...]`. Counts only active
(non-archived) items by default; pass `archived=all` to count everything.

## External summary service

The summary is populated out-of-band:

1. `GET /api/items?has_summary=false` to fetch items needing a summary
   (active items only by default).
2. Generate the summary externally.
3. `PATCH /api/items/:id` with `{ "summary": "..." }` and the Bearer token.

This service does not distinguish "not yet processed" from "failed". If you need
to avoid retrying permanently failing items, write a placeholder summary or keep
your own failure list on the external side.

## Importing history from markdown

One-off importer for URLs scattered across markdown files:

```sh
# preview without writing
node scripts/import-md.ts --dry-run path/to/notes.md path/to/dir

# import for real (server must be running; LATER_TOKEN in env)
node scripts/import-md.ts --base http://127.0.0.1:8787 path/to/notes.md
```

Rules: the most recent markdown heading becomes the item's single tag; http(s)
URLs are extracted per line; fenced code blocks are skipped; the rest of the
URL's line becomes the note. No de-duplication.

## Notes & caveats

- `node:sqlite` uses a **synchronous** API and blocks the event loop; fine for a
  single-user tool.
- WAL mode is enabled (`journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`). The DB file must live on a **local**
  filesystem (not NFS).
- The DB and its `-wal` / `-shm` sidecar files are gitignored. To back up, copy
  all three together, or checkpoint first.
- Time-range filters depend on the client converting dates to epoch ms in the
  correct timezone.
