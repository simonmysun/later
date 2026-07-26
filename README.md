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

The app image runs the `.ts` source directly on Node 24 (no build) as a
non-root user, with no runtime dependencies.

```sh
cp .env.example .env      # set LATER_TOKEN (docker compose reads it from here)

docker compose up -d later # app only: build + start
docker compose logs -f later
docker compose down        # stop everything
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

### Compose with the automation workers

`docker compose` defines four services: the app (`later`) plus three
independently-scheduled workers — `rss`, `summarize`, and `hn` — built from
`Dockerfile.scripts` (a separate image that installs the scripts' single
dependency, `fast-xml-parser`). Each worker runs its script in a loop: run,
`sleep <INTERVAL>`, repeat.

```sh
cp .env.example .env      # set LATER_TOKEN, CRAWL4AI_BASE_URL, OPENAI_API_KEY, ...

docker compose up -d              # app + all three workers
docker compose up -d later hn     # app + only the HN worker
docker compose logs -f summarize  # follow one worker
docker compose ps                 # see all services
```

Key properties:

- **State persistence / resume.** The HN backfill cursor lives in
  `./data/hn-state.json` (mounted from the host `./data` volume). A plain
  `docker compose up` after `down` **resumes exactly where the previous run left
  off** — the cursor keeps walking further into the past each run. RSS is
  stateless (dedup by URL); the summarizer is driven by `has_summary=false`.
- **Editable prompts.** `./scripts/prompts` is mounted read-only into the
  `summarize` worker at `/app/prompts` (`SUMMARY_PROMPT_DIR`). It holds three
  prompts — `content.md`, `discussion.md`, `comment.md` — selected by item kind
  (see the summarizer section). Edit them on the host and changes take effect on
  the worker's next loop iteration — no rebuild. Any missing/empty file falls
  back to a built-in default.
- **Editable feeds.** `./feeds.json` is mounted read-only into the `rss` worker,
  overriding the image's built-in `scripts/feeds.json`.
- **Networking.** Workers reach the app over the compose network at
  `http://later:8787` (set automatically); `LATER_BASE_URL` in `.env` only
  affects host-run scripts.
- **Cadence.** `RSS_INTERVAL`, `SUMMARY_INTERVAL` (+ `SUMMARY_LIMIT`), and
  `HN_INTERVAL` (seconds) control how often each worker runs; see `.env.example`.

The `summarize` worker needs `OPENAI_API_KEY` plus a fetch backend — set either
`CRAWL4AI_BASE_URL` or `BROWSERLESS_API_URL` (see below). If you don't want the
AI summary worker, start only the services you need, e.g.
`docker compose up -d later rss hn`.

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

**Per-site URL canonicalization.** On create, the stored `url` is passed through
site-specific canonicalization rules (in `src/canonicalize/`) so the persisted
value and the exact-URL dedup key are stable. Currently:

- `readhacker.news/s/<id>` (source-article link) → `readhacker.news/c/<id>`
  (comments/discussion link), so a story link and its discussion link collapse
  to the same stored URL. The summarizer then follows the redirect to the HN
  thread and produces an article + discussion summary.

Rules are pure, tolerant string transforms and each lives in its own file; add a
new site by dropping a rule in `src/canonicalize/` and registering it in
`src/canonicalize/index.ts`. This storage-time canonicalization is distinct from
the summarizer's fetch-time URL preprocessing, which never changes the stored
value.

### `GET /api/items` — list, filter, sort

Query params:

| Param         | Values                                            | Notes |
| ------------- | ------------------------------------------------- | ----- |
| `tags`        | comma-separated tag names                         | trimmed + lowercased |
| `tag_mode`    | `and` \| `or` (default `or`)                       | `and` = all tags present |
| `untagged`    | `true`                                            | mutually exclusive with `tags` |
| `domain`      | exact host match                                  | `domain=` matches unparseable-URL items |
| `url`         | exact URL match                                   | equality, not substring; used by scripts for de-dup |
| `from` / `to` | epoch ms, inclusive range on `added_at`           | non-negative integers |
| `read`        | `true` \| `false`                                  | |
| `archived`    | `false` (default) \| `true` \| `all`               | default hides archived |
| `has_summary` | `true` \| `false`                                  | `false` = summary NULL or empty |
| `q`           | keyword                                           | LIKE substring across url/title/note/summary |
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

This service does not distinguish "not yet processed" from "failed". The bundled
`summarize.ts` script (below) handles this by writing a **placeholder summary**
with a fixed prefix on failure, so the item drops out of `has_summary=false`;
the frontend can then export those items for a targeted retry.

## Automation scripts

The `scripts/` directory is a **separate subpackage** with its own
dependencies. The scripts are **host-run only** — they are **not** part of the
Docker image, and the server has **zero runtime dependencies**. All scripts talk
to the app **only over HTTP** (never the DB directly) and **never write the
`note` field** (it is user-authored).

### Install

```sh
cd scripts
npm install        # installs into scripts/node_modules (gitignored)
```

### Test / typecheck

```sh
cd scripts
npm run typecheck
npm test           # node --test over scripts/test/**
```

Unit tests cover the pure/util logic that has historically been error-prone:
URL preprocessing + HN kind classification (`lib/url-preprocess.ts`), prompt
loading (`lib/prompts.ts`), the rate limiter (`lib/throttle.ts`), fetch-backend
selection + browserless/crawl4ai parsing (`lib/fetcher.ts`, `lib/crawl4ai.ts`,
`lib/html2md.ts`), and RSS/Atom feed parsing (`rss.ts`).

### De-duplication

Scripts skip URLs that already exist by querying the exact-URL filter:

```
GET /api/items?url=<exact>&archived=all&limit=1
```

`archived=all` is required so archived duplicates are also detected. There is no
unique constraint in the DB by design, so concurrent runs can still race; this
is acceptable for a personal tool.

### Common env

| Var             | Default                   | Used by       |
| --------------- | ------------------------- | ------------- |
| `LATER_BASE_URL`| `http://127.0.0.1:8787`   | all scripts   |
| `LATER_TOKEN`   | (required for writes)     | all scripts   |

Scripts that write fail fast with a clear message if `LATER_TOKEN` is missing
(unless `--dry-run`).

### `import-md.ts` — one-off markdown importer

```sh
node scripts/import-md.ts --dry-run path/to/notes.md path/to/dir
node scripts/import-md.ts --base http://127.0.0.1:8787 path/to/notes.md
```

The most recent markdown heading becomes the item's single tag; http(s) URLs are
extracted per line; fenced code blocks are skipped; the rest of the URL's line
becomes the note. No de-duplication.

### `rss.ts` — RSS / Atom import

Reads a feed list (default `scripts/feeds.json`), fetches each feed, and creates
an item per entry (link + title), de-duplicated by exact URL. Stateless.

```sh
node scripts/rss.ts --dry-run
node scripts/rss.ts                       # real import (LATER_TOKEN required)
node scripts/rss.ts --config other.json   # custom feed list
```

`feeds.json` shape:

```json
[
  { "url": "https://hnrss.org/frontpage", "tags": ["hn"] },
  { "url": "https://example.com/atom.xml" }
]
```

Tags applied to each imported item are `feed.tags ∪ ["rss"]`. RSS 2.0 `<item>`,
RSS 1.0/RDF `<item>`, and Atom `<entry>` (preferring `rel=alternate` links) are
all supported.

### `summarize.ts` — AI summaries

Selects items lacking a summary
(`GET /api/items?has_summary=false&archived=false`), fetches each page via a
**pluggable fetch backend**, summarizes with an **OpenAI-compatible**
`/chat/completions` endpoint, then `PATCH`es `{ summary }` (and `title` only when
the item title is empty). `note` is never touched.

**Fetch backends** (choose with `SUMMARY_FETCH_BACKEND`, or auto-detected from
whichever base URL is set, crawl4ai preferred):

- **crawl4ai** (`CRAWL4AI_BASE_URL`): `POST {base}/crawl {"urls":[url]}` → returns
  Markdown + `metadata.title`.
- **browserless** (`BROWSERLESS_API_URL` + `BROWSERLESS_API_TOKEN`): `POST
  {base}/content?token=..` → returns rendered HTML (JS executed, ads blocked,
  stealth), which is converted to text locally (`lib/html2md.ts`) with the
  `<title>` used as the page title. Good for JS-heavy or anti-bot pages.

Backend implementations live in `lib/fetcher.ts`.

On any crawl/LLM failure it writes a **placeholder summary**
`"<SUMMARY_FAIL_PREFIX> <reason>"` so the item is no longer selected by
`has_summary=false` (no infinite retry).

```sh
node scripts/summarize.ts --dry-run
node scripts/summarize.ts --limit 20
node scripts/summarize.ts --retry-file summary-failed.json
```

**Per-kind prompts.** The item's kind is decided authoritatively via the HN item
API (not tags), and selects the prompt (all three live in `SUMMARY_PROMPT_DIR`):

- **content** — a normal article/page → `content.md`.
- **hn-story** — a Hacker News story → the linked **article** is summarized with
  `content.md`, and the HN **thread** is summarized with `discussion.md`
  (a template with `{content}` = the article summary and `{discussion}` = the
  thread text). The two are combined into one `summary` ("… / **Discussion** …").
  Ask HN / Show HN self-posts summarize the HN page itself.
- **hn-comment** — a single Hacker News comment page → `comment.md`.

Any missing prompt file falls back to a built-in default.

**URL preprocessing (better summaries).** Before crawling, the target URL is
rewritten to a more machine-readable / more relevant page (**the stored item URL
is never changed** — only the summarization target is):

- **Redirects are followed.** Link shorteners and redirectors (e.g.
  `readhacker.news/s/<id>` → the source article, `readhacker.news/c/<id>` → the
  Hacker News item) are resolved to their final destination first, then
  classified. So a stored `readhacker.news/c/…` link is kept as-is, but the
  summary is produced from the real HN story (article + discussion).
- **arxiv** `/abs/` or `/pdf/` → `/html/` (HTML is far better for an LLM than a
  PDF), with existence checks that fall back to `ar5iv.labs.arxiv.org` and then
  the `/abs/` page.
- Missing scheme is added; common tracking params (`utm_*`, `fbclid`, `gclid`,
  …) are stripped.

External calls (URL-resolution probes + page fetch) go through a **sliding-window
rate limiter** (`SUMMARY_MAX_PER_MIN`, `SUMMARY_MIN_INTERVAL_MS`).

Env:

| Var                       | Default                     | Meaning |
| ------------------------- | --------------------------- | ------- |
| `SUMMARY_FETCH_BACKEND`   | (auto)                      | force `crawl4ai` or `browserless`; auto-detects otherwise |
| `CRAWL4AI_BASE_URL`       | (backend)                   | crawl4ai base; `POST {base}/crawl {"urls":[url]}` |
| `CRAWL4AI_TOKEN`          | (none)                      | optional bearer for crawl4ai |
| `BROWSERLESS_API_URL`     | (backend)                   | browserless base; `POST {base}/content?token=..` |
| `BROWSERLESS_API_TOKEN`   | (none)                      | browserless token |
| `OPENAI_BASE_URL`         | `https://api.openai.com/v1` | OpenAI-compatible base |
| `OPENAI_API_KEY`          | (required)                  | LLM API key |
| `OPENAI_MODEL`            | `gpt-4o-mini`               | model name |
| `SUMMARY_MAX_INPUT_CHARS` | `12000`                     | page text truncation before the LLM call |
| `SUMMARY_FAIL_PREFIX`     | `[auto-summary-failed]`     | placeholder prefix (see coupling note below) |
| `SUMMARY_PROMPT_DIR`      | `./prompts`                 | dir with `content.md` / `discussion.md` / `comment.md` |
| `SUMMARY_PROMPT_PATH`     | (none)                      | legacy single-file override for the content prompt |
| `SUMMARY_MAX_PER_MIN`     | `20`                        | max external HTTP calls per minute |
| `SUMMARY_MIN_INTERVAL_MS` | `200`                       | min milliseconds between external calls |

Fetch backends live in `lib/fetcher.ts`; the crawl4ai response parsing is
isolated in `lib/crawl4ai.ts` (`extractCrawlResult`, `hasContent`) and the
browserless HTML→text conversion in `lib/html2md.ts`, so both are unit-tested
without network access. URL rewriting + kind classification live in
`lib/url-preprocess.ts`, prompt loading in `lib/prompts.ts`, and the rate limiter
in `lib/throttle.ts`.

#### Failure / retry loop (coupling note)

`SUMMARY_FAIL_PREFIX` is **duplicated** as a hardcoded constant
(`SUMMARY_FAIL_PREFIX`) in `public/index.html`. If you change the env value, you
must change the frontend constant too. The retry loop is:

1. Run `summarize.ts`; failures get the placeholder summary.
2. In the web UI, click **"Export failed summaries"**. It queries
   `q=<PREFIX>&has_summary=true&archived=all`, re-verifies each result with
   `summary.startsWith(PREFIX)` (guarding LIKE substring false positives), and
   downloads a `summary-failed.json` file of `{ id, url }`.
3. Re-run `node scripts/summarize.ts --retry-file summary-failed.json`, which
   reprocesses those items by id and overwrites the placeholder, ignoring
   `has_summary`.

### `hn.ts` — Hacker News stories + best comments

Adds HN stories and best comments as items, de-duplicated by the canonical URL
`https://news.ycombinator.com/item?id=<id>` (same for stories and comments; only
the tags differ: `["hn","hn-story"]` vs `["hn","hn-comment"]`).

```sh
node scripts/hn.ts --forward-only --dry-run
node scripts/hn.ts --forward-only          # current top stories + best comments
node scripts/hn.ts --backfill-only         # walk cursor back k days
node scripts/hn.ts                          # forward + backfill
```

- **Forward stories**: Firebase `topstories.json`, hydrated per id.
- **Forward comments**: scrape `news.ycombinator.com/bestcomments` for comment
  ids (capped by `HN_COMMENTS_FORWARD_MAX`).
- **Backfill stories**: Algolia `search_by_date` per day window; keeps **all**
  stories with `points >= HN_STORY_MIN_POINTS` (not top-N).
- **Backfill comments**: Wayback CDX snapshots of `/bestcomments`
  (best-effort — snapshots are sparse; missing/503 are skipped).

A day cursor + last-run time is persisted to `HN_STATE_PATH`
(default `./data/hn-state.json`); each backfill run advances it by
`HN_BACKFILL_DAYS`. RSS is stateless; only HN keeps state.

Env:

| Var                       | Default                  | Meaning |
| ------------------------- | ------------------------ | ------- |
| `HN_BACKFILL_DAYS`        | `3`                      | days the cursor advances per backfill run |
| `HN_STORY_MIN_POINTS`     | `100`                    | backfill story points threshold |
| `HN_COMMENTS_FORWARD_MAX` | `30`                     | max forward best-comments per run |
| `HN_STATE_PATH`           | `./data/hn-state.json`   | cursor + last-run state file |

### Cron examples

Run on the host (not in the container). Ensure the script env vars are exported
(e.g. `set -a; . /path/to/.env; set +a`).

```cron
# RSS every 30 minutes
*/30 * * * * cd /path/to/later/scripts && node rss.ts >> /var/log/later-rss.log 2>&1
# HN forward hourly, plus a backfill step
0 * * * *   cd /path/to/later/scripts && node hn.ts >> /var/log/later-hn.log 2>&1
# Summaries every 15 minutes
*/15 * * * * cd /path/to/later/scripts && node summarize.ts --limit 20 >> /var/log/later-sum.log 2>&1
```

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
