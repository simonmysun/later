/**
 * Hacker News importer for the `later` app.
 *
 * Adds HN stories and best comments as items, de-duplicated by exact canonical
 * URL: `https://news.ycombinator.com/item?id=<id>` for BOTH stories and
 * comments. The only distinction is tags: ["hn","hn-story"] vs
 * ["hn","hn-comment"]. The script never writes `note` (user-authored).
 *
 * Two phases:
 *   Forward  — current top stories (Firebase topstories) + current best comments
 *              (scrape news.ycombinator.com/bestcomments).
 *   Backfill — walk a day cursor backward k days per run. Stories via Algolia
 *              search_by_date (points >= threshold, ALL matching, not top-N);
 *              comments via Wayback CDX snapshots of /bestcomments (best-effort,
 *              sparse, skip missing/503).
 *
 * State (day cursor + last run) lives in HN_STATE_PATH (default
 * ./data/hn-state.json). RSS is stateless; HN backfill is not.
 *
 * Usage:
 *   node hn.ts [--forward-only | --backfill-only] [--dry-run]
 *
 * Env:
 *   LATER_BASE_URL          default http://127.0.0.1:8787
 *   LATER_TOKEN             required unless --dry-run
 *   HN_BACKFILL_DAYS        k, default 3
 *   HN_STORY_MIN_POINTS     threshold, default 100
 *   HN_COMMENTS_FORWARD_MAX M forward comments, default 30
 *   HN_STATE_PATH           default ./data/hn-state.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LaterClient, paced, sleep } from "./lib/later-client.ts";

const FIREBASE = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA = "https://hn.algolia.com/api/v1";
const HN_BASE = "https://news.ycombinator.com";
const WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx";
const UA = { "User-Agent": "later-hn/0.1" };

const HN_BACKFILL_DAYS = Number(process.env.HN_BACKFILL_DAYS ?? "3");
const HN_STORY_MIN_POINTS = Number(process.env.HN_STORY_MIN_POINTS ?? "100");
const HN_COMMENTS_FORWARD_MAX = Number(process.env.HN_COMMENTS_FORWARD_MAX ?? "30");
const HN_STATE_PATH = resolve(process.env.HN_STATE_PATH ?? "./data/hn-state.json");

const DAY_MS = 86_400_000;

interface HnState {
  /** Backfill cursor: epoch ms at start of the earliest day already covered. */
  cursor: number;
  lastRunAt?: number;
}

interface Args {
  forwardOnly: boolean;
  backfillOnly: boolean;
  dryRun: boolean;
}

function canonicalUrl(id: number): string {
  return `${HN_BASE}/item?id=${id}`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { forwardOnly: false, backfillOnly: false, dryRun: false };
  for (const a of argv) {
    if (a === "--forward-only") args.forwardOnly = true;
    else if (a === "--backfill-only") args.backfillOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (args.forwardOnly && args.backfillOnly) {
    console.error("--forward-only and --backfill-only are mutually exclusive");
    process.exit(1);
  }
  return args;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

async function loadState(): Promise<HnState> {
  try {
    const raw = await readFile(HN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<HnState>;
    if (typeof parsed.cursor === "number") {
      return { cursor: parsed.cursor, lastRunAt: parsed.lastRunAt };
    }
  } catch {
    /* fall through to init */
  }
  // Init cursor at start of today (backfill walks backward from here).
  return { cursor: startOfUtcDay(Date.now()) };
}

async function saveState(state: HnState): Promise<void> {
  await mkdir(dirname(HN_STATE_PATH), { recursive: true });
  await writeFile(HN_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ---- external fetch helpers ----

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

interface FirebaseStory {
  id: number;
  title?: string;
  type?: string;
}

/** Parse comment item ids from a news.ycombinator.com/bestcomments HTML page. */
function parseCommentIds(html: string): number[] {
  const ids = new Set<number>();
  const re = /item\?id=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) ids.add(id);
  }
  return [...ids];
}

// ---- forward ----

async function forwardStories(client: LaterClient, dryRun: boolean, counts: Counts): Promise<void> {
  const ids = await getJson<number[]>(`${FIREBASE}/topstories.json`);
  console.log(`Forward stories: ${ids.length} top ids`);
  await paced(ids, 60, async (id) => {
    let story: FirebaseStory;
    try {
      story = await getJson<FirebaseStory>(`${FIREBASE}/item/${id}.json`);
    } catch (e) {
      counts.failed++;
      console.error(`  story ${id} fetch failed: ${(e as Error).message}`);
      return;
    }
    if (!story || story.type !== "story") return;
    await addItem(client, id, story.title, ["hn", "hn-story"], dryRun, counts);
  });
}

async function forwardComments(client: LaterClient, dryRun: boolean, counts: Counts): Promise<void> {
  let html: string;
  try {
    html = await getText(`${HN_BASE}/bestcomments`);
  } catch (e) {
    counts.failed++;
    console.error(`Forward comments: fetch /bestcomments failed: ${(e as Error).message}`);
    return;
  }
  const ids = parseCommentIds(html).slice(0, HN_COMMENTS_FORWARD_MAX);
  console.log(`Forward comments: ${ids.length} comment ids`);
  await paced(ids, 40, async (id) => {
    // Comments have no useful title; tag distinguishes them.
    await addItem(client, id, undefined, ["hn", "hn-comment"], dryRun, counts);
  });
}

// ---- backfill ----

interface AlgoliaStory {
  objectID: string;
  title?: string;
  points?: number | null;
}
interface AlgoliaSearchResponse {
  hits: AlgoliaStory[];
  nbPages: number;
  page: number;
}

async function backfillStoriesForWindow(
  client: LaterClient,
  d0: number,
  d1: number,
  dryRun: boolean,
  counts: Counts,
): Promise<void> {
  const start = Math.floor(d0 / 1000);
  const end = Math.floor(d1 / 1000);
  let page = 0;
  let pages = 1;
  do {
    const url =
      `${ALGOLIA}/search_by_date?tags=story` +
      `&numericFilters=created_at_i>=${start},created_at_i<${end}` +
      `&hitsPerPage=100&page=${page}`;
    let resp: AlgoliaSearchResponse;
    try {
      resp = await getJson<AlgoliaSearchResponse>(url);
    } catch (e) {
      counts.failed++;
      console.error(`  algolia page ${page} failed: ${(e as Error).message}`);
      break;
    }
    pages = resp.nbPages;
    for (const hit of resp.hits) {
      const points = typeof hit.points === "number" ? hit.points : 0;
      if (points < HN_STORY_MIN_POINTS) continue;
      const id = Number(hit.objectID);
      if (!Number.isFinite(id)) continue;
      await addItem(client, id, hit.title, ["hn", "hn-story"], dryRun, counts);
    }
    if (page >= 9 && pages > 10) {
      console.warn(
        `  WARN: window hit Algolia pagination cap (>1000 hits); coverage partial`,
      );
      break;
    }
    page++;
    await sleep(50);
  } while (page < pages);
}

interface CdxRow {
  timestamp: string;
  original: string;
  statuscode: string;
}

async function waybackSnapshots(from: string, to: string): Promise<CdxRow[]> {
  const url =
    `${WAYBACK_CDX}?url=news.ycombinator.com/bestcomments&output=json` +
    `&from=${from}&to=${to}`;
  let rows: string[][];
  try {
    rows = await getJson<string[][]>(url);
  } catch (e) {
    console.error(`  wayback CDX failed: ${(e as Error).message}`);
    return [];
  }
  if (!Array.isArray(rows) || rows.length <= 1) return [];
  // First row is the header: [urlkey,timestamp,original,mimetype,statuscode,digest,length]
  const out: CdxRow[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 5) continue;
    out.push({ timestamp: r[1]!, original: r[2]!, statuscode: r[4]! });
  }
  return out.filter((r) => r.statuscode === "200");
}

async function backfillCommentsForWindow(
  client: LaterClient,
  d0: number,
  d1: number,
  dryRun: boolean,
  counts: Counts,
): Promise<void> {
  const from = yyyymmdd(d0);
  const to = yyyymmdd(d1 - DAY_MS);
  const snaps = await waybackSnapshots(from, to);
  if (snaps.length === 0) {
    console.log(`  comments backfill ${from}..${to}: no usable snapshots`);
    return;
  }
  console.log(`  comments backfill ${from}..${to}: ${snaps.length} snapshot(s)`);
  for (const snap of snaps) {
    const archiveUrl = `http://web.archive.org/web/${snap.timestamp}/https://news.ycombinator.com/bestcomments`;
    let html: string;
    try {
      html = await getText(archiveUrl);
    } catch (e) {
      console.error(`    skip snapshot ${snap.timestamp}: ${(e as Error).message}`);
      continue;
    }
    const ids = parseCommentIds(html);
    await paced(ids, 40, async (id) => {
      await addItem(client, id, undefined, ["hn", "hn-comment"], dryRun, counts);
    });
    await sleep(100);
  }
}

function yyyymmdd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ---- shared add ----

interface Counts {
  added: number;
  skipped: number;
  failed: number;
}

async function addItem(
  client: LaterClient,
  id: number,
  title: string | undefined,
  tags: string[],
  dryRun: boolean,
  counts: Counts,
): Promise<void> {
  const url = canonicalUrl(id);
  if (dryRun) {
    console.log(`[dry] ${tags.join(",")}  ${url}  ${title ?? ""}`.trimEnd());
    return;
  }
  try {
    const created = await client.createIfNew({ url, title, tags });
    if (created) counts.added++;
    else counts.skipped++;
  } catch (e) {
    counts.failed++;
    console.error(`  FAIL ${url} -> ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !process.env.LATER_TOKEN) {
    console.error("LATER_TOKEN is required (or use --dry-run).");
    process.exit(1);
  }

  const client = new LaterClient();
  const counts: Counts = { added: 0, skipped: 0, failed: 0 };

  const doForward = !args.backfillOnly;
  const doBackfill = !args.forwardOnly;

  if (doForward) {
    await forwardStories(client, args.dryRun, counts);
    await forwardComments(client, args.dryRun, counts);
  }

  if (doBackfill) {
    const state = await loadState();
    const newCursor = state.cursor - HN_BACKFILL_DAYS * DAY_MS;
    console.log(
      `Backfill: ${HN_BACKFILL_DAYS} day(s), cursor ${yyyymmdd(state.cursor)} -> ${yyyymmdd(newCursor)}`,
    );
    // Walk each day window in [newCursor, cursor).
    for (let d0 = state.cursor - DAY_MS; d0 >= newCursor; d0 -= DAY_MS) {
      const d1 = d0 + DAY_MS;
      console.log(`Day ${yyyymmdd(d0)}:`);
      await backfillStoriesForWindow(client, d0, d1, args.dryRun, counts);
      await backfillCommentsForWindow(client, d0, d1, args.dryRun, counts);
    }
    if (!args.dryRun) {
      await saveState({ cursor: newCursor, lastRunAt: Date.now() });
      console.log(`State saved: cursor=${yyyymmdd(newCursor)} -> ${HN_STATE_PATH}`);
    } else {
      console.log(`[dry] would advance cursor to ${yyyymmdd(newCursor)}`);
    }
  }

  console.log(`\nDone. added=${counts.added} skipped=${counts.skipped} failed=${counts.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
