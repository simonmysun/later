/**
 * RSS / Atom importer for the `later` app.
 *
 * Reads a feed list (default `scripts/feeds.json`), fetches each feed, extracts
 * each entry's link + title, and creates an item via the app API — de-duplicated
 * by exact URL. Stateless: dedup is by URL, so re-running adds nothing new.
 *
 * The script never writes `note` (user-authored).
 *
 * Usage:
 *   node rss.ts [--config <path>] [--dry-run]
 *
 * Env:
 *   LATER_BASE_URL   default http://127.0.0.1:8787
 *   LATER_TOKEN      required unless --dry-run
 *
 * feeds.json shape: [{ "url": "https://…", "tags": ["optional"] }, ...]
 * Tags applied to each imported item = feed.tags ∪ ["rss"].
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { LaterClient, paced } from "./lib/later-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FeedConfig {
  url: string;
  tags?: string[];
}

export interface Entry {
  url: string;
  title?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // fast-xml-parser puts text of an element with attributes under "#text".
    const t = (v as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t.trim() || undefined;
  }
  return undefined;
}

/** Extract the entry link from an Atom <entry>, preferring rel=alternate. */
function atomLink(entry: Record<string, unknown>): string | undefined {
  const links = asArray(entry["link"]);
  if (links.length === 0) return undefined;
  const hrefs = links
    .map((l) => {
      if (typeof l === "string") return { href: l, rel: undefined as string | undefined };
      const o = l as Record<string, unknown>;
      return {
        href: typeof o["@_href"] === "string" ? (o["@_href"] as string) : undefined,
        rel: typeof o["@_rel"] === "string" ? (o["@_rel"] as string) : undefined,
      };
    })
    .filter((l): l is { href: string; rel: string | undefined } => !!l.href);
  if (hrefs.length === 0) return undefined;
  const alt = hrefs.find((l) => l.rel === "alternate" || l.rel === undefined);
  return (alt ?? hrefs[0])!.href;
}

/** Parse a feed document into entries (RSS 2.0 <item> and Atom <entry>). */
export function parseFeed(xml: string): Entry[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const out: Entry[] = [];

  // RSS 2.0: rss > channel > item
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = rss?.["channel"] as Record<string, unknown> | undefined;
  if (channel) {
    for (const item of asArray(channel["item"])) {
      const o = item as Record<string, unknown>;
      const url = textOf(o["link"]);
      if (!url) continue;
      out.push({ url, title: textOf(o["title"]) });
    }
  }

  // RDF / RSS 1.0: rdf:RDF > item (link is a direct child)
  const rdf = (doc["rdf:RDF"] ?? doc["RDF"]) as Record<string, unknown> | undefined;
  if (rdf) {
    for (const item of asArray(rdf["item"])) {
      const o = item as Record<string, unknown>;
      const url = textOf(o["link"]);
      if (!url) continue;
      out.push({ url, title: textOf(o["title"]) });
    }
  }

  // Atom: feed > entry
  const feed = doc["feed"] as Record<string, unknown> | undefined;
  if (feed) {
    for (const entry of asArray(feed["entry"])) {
      const o = entry as Record<string, unknown>;
      const url = atomLink(o);
      if (!url) continue;
      out.push({ url, title: textOf(o["title"]) });
    }
  }

  return out;
}

function parseArgs(argv: string[]): { dryRun: boolean; configPath: string } {
  let dryRun = false;
  let configPath = join(__dirname, "feeds.json");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--config") configPath = resolve(argv[++i] ?? configPath);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { dryRun, configPath };
}

async function loadFeeds(path: string): Promise<FeedConfig[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of feeds`);
  const feeds: FeedConfig[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object" || typeof (f as FeedConfig).url !== "string") {
      throw new Error(`${path}: each feed must be an object with a string "url"`);
    }
    const fc = f as FeedConfig;
    feeds.push({ url: fc.url, tags: Array.isArray(fc.tags) ? fc.tags : undefined });
  }
  return feeds;
}

export function mergeTags(feedTags: string[] | undefined): string[] {
  const set = new Set<string>(["rss"]);
  for (const t of feedTags ?? []) {
    const n = String(t).trim().toLowerCase();
    if (n) set.add(n);
  }
  return [...set];
}

async function main(): Promise<void> {
  const { dryRun, configPath } = parseArgs(process.argv.slice(2));
  const feeds = await loadFeeds(configPath);

  if (!dryRun && !process.env.LATER_TOKEN) {
    console.error("LATER_TOKEN is required (or use --dry-run).");
    process.exit(1);
  }

  const client = new LaterClient();
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const feed of feeds) {
    const tags = mergeTags(feed.tags);
    let entries: Entry[] = [];
    try {
      const res = await fetch(feed.url, { headers: { "User-Agent": "later-rss/0.1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = parseFeed(await res.text());
    } catch (e) {
      failed++;
      console.error(`FEED FAIL ${feed.url} -> ${(e as Error).message}`);
      continue;
    }

    console.log(`Feed ${feed.url}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (tags=${tags.join(",")})`);

    await paced(entries, 50, async (entry) => {
      if (dryRun) {
        console.log(`[dry] ${entry.url}  title=${entry.title ?? "-"}`);
        return;
      }
      try {
        const created = await client.createIfNew({
          url: entry.url,
          title: entry.title,
          tags,
        });
        if (created) added++;
        else skipped++;
      } catch (e) {
        failed++;
        console.error(`FAIL ${entry.url} -> ${(e as Error).message}`);
      }
    });
  }

  if (dryRun) console.log("\nDry run: nothing written.");
  else console.log(`\nDone. added=${added} skipped=${skipped} failed=${failed}`);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
