/**
 * AI summary worker for the `later` app.
 *
 * Selects items lacking a summary, fetches the page via a self-hosted crawl4ai
 * REST API, summarizes with an OpenAI-compatible chat/completions endpoint, then
 * PATCHes `{ summary }` (and `title` only when the item title is empty). On any
 * fetch/LLM failure it writes a placeholder summary with a fixed prefix so the
 * item is no longer selected by `has_summary=false` — recoverable later via the
 * frontend export + `--retry-file`.
 *
 * Three prompts are selected by item kind (like telegram-summarize-bot):
 *   - content     — normal article/page (and a HN story's linked article)
 *   - hn-story    — HN story: summarize the linked article (content prompt) AND
 *                   the HN thread (discussion prompt), combined into one summary
 *   - hn-comment  — a single HN comment page (comment prompt)
 * HN kind is decided authoritatively via the HN item API, not tags.
 *
 * The script NEVER writes `note` (user-authored).
 *
 * Usage:
 *   node summarize.ts [--limit N] [--dry-run] [--retry-file <path>]
 *
 * Env:
 *   LATER_BASE_URL          default http://127.0.0.1:8787
 *   LATER_TOKEN             required unless --dry-run
 *   SUMMARY_FETCH_BACKEND   crawl4ai | browserless (optional; auto-detected from
 *                           whichever base URL is set, preferring crawl4ai)
 *   CRAWL4AI_BASE_URL       e.g. http://127.0.0.1:11235   (crawl4ai backend)
 *   CRAWL4AI_TOKEN          optional bearer for crawl4ai
 *   BROWSERLESS_API_URL     e.g. https://browserless.example  (browserless backend)
 *   BROWSERLESS_API_TOKEN   token for browserless (?token=)
 *   OPENAI_BASE_URL         default https://api.openai.com/v1
 *   OPENAI_API_KEY          required for real runs
 *   OPENAI_MODEL            default gpt-4o-mini
 *   SUMMARY_MAX_INPUT_CHARS default 12000
 *   SUMMARY_FAIL_PREFIX     default [auto-summary-failed]
 *                           NOTE: this default is duplicated as a hardcoded
 *                           constant in public/index.html (export filter). Keep
 *                           the two in sync — see README.
 *   SUMMARY_PROMPT_DIR      optional dir with content.md / discussion.md /
 *                           comment.md; each missing file uses a built-in
 *                           default. Default dir: ./prompts.
 *   SUMMARY_PROMPT_PATH     legacy single-file override for the CONTENT prompt.
 *   SUMMARY_MAX_PER_MIN     external-call rate cap (default 20/min)
 *   SUMMARY_MIN_INTERVAL_MS min ms between external calls (default 200)
 *
 * Before crawling, the target URL is rewritten for better summaries:
 *   - HTTP redirects are followed (link shorteners, readhacker.news/s|c/<id> ->
 *     the article or the HN item) to get the real destination first.
 *   - Hacker News story item?id=<id> -> the linked article (thread kept as the
 *     discussion URL); comment -> comment page; Ask/Show self-post -> HN page.
 *   - arxiv /abs/ | /pdf/ -> /html/, with ar5iv.labs.arxiv.org and /abs/
 *     fallbacks when the HTML rendering is missing.
 *   - missing scheme is added; common tracking params (utm_*, fbclid, ...) are
 *     stripped. The stored item URL is never modified.
 *
 * --retry-file: a JSON array of { "id": number, "url"?: string } (as produced by
 * the frontend "Export failed summaries" button). Those items are reprocessed,
 * overwriting the placeholder, ignoring `has_summary`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LaterClient, type Item, sleep } from "./lib/later-client.ts";
import { resolveForSummary, type ResolveDeps } from "./lib/url-preprocess.ts";
import { Throttle } from "./lib/throttle.ts";
import { loadPrompts, renderDiscussionPrompt, type Prompts } from "./lib/prompts.ts";
import { createFetcher, type PageFetcher } from "./lib/fetcher.ts";

const CRAWL4AI_BASE_URL = process.env.CRAWL4AI_BASE_URL;
const CRAWL4AI_TOKEN = process.env.CRAWL4AI_TOKEN;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const SUMMARY_MAX_INPUT_CHARS = Number(process.env.SUMMARY_MAX_INPUT_CHARS ?? "12000");
const SUMMARY_FAIL_PREFIX = process.env.SUMMARY_FAIL_PREFIX ?? "[auto-summary-failed]";
// Directory holding content.md / discussion.md / comment.md (defaults built in).
const SUMMARY_PROMPT_DIR = process.env.SUMMARY_PROMPT_DIR;
// Legacy single-file override for the content prompt (back-compat).
const SUMMARY_PROMPT_PATH = process.env.SUMMARY_PROMPT_PATH;

// Polite pacing for external (non-app) HTTP: URL-resolution probes + crawl4ai.
const externalThrottle = new Throttle({
  maxPerWindow: Number(process.env.SUMMARY_MAX_PER_MIN ?? "20"),
  windowMs: 60_000,
  minIntervalMs: Number(process.env.SUMMARY_MIN_INTERVAL_MS ?? "200"),
});

/** Network deps for URL resolution (HN API lookup + arxiv HTML existence). */
const resolveDeps: ResolveDeps = {
  async fetchJson(url: string): Promise<unknown> {
    try {
      await externalThrottle.acquire();
      const res = await fetch(url, { headers: { "User-Agent": "later-summarize/0.1" } });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  },
  async headOk(url: string): Promise<boolean> {
    try {
      await externalThrottle.acquire();
      // Some hosts reject HEAD; fall back to a ranged GET.
      let res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
      }
      return res.status !== 404 && res.status < 500;
    } catch {
      return false;
    }
  },
  async resolveRedirect(url: string): Promise<string> {
    try {
      await externalThrottle.acquire();
      // A HEAD with redirect:follow reports the final URL cheaply. Some hosts
      // reject HEAD or don't redirect on it, so fall back to a ranged GET.
      let res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "User-Agent": "later-summarize/0.1" },
      });
      if (res.status === 405 || res.status === 501 || !res.ok) {
        res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "later-summarize/0.1", Range: "bytes=0-0" },
        });
      }
      return res.url || url;
    } catch {
      return url;
    }
  },
};

interface Args {
  limit: number | undefined;
  dryRun: boolean;
  retryFile: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let limit: number | undefined;
  let dryRun = false;
  let retryFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) {
        console.error("--limit expects a non-negative integer");
        process.exit(1);
      }
      limit = n;
    } else if (a === "--retry-file") {
      retryFile = resolve(argv[++i] ?? "");
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { limit, dryRun, retryFile };
}

// Page fetch backend (crawl4ai or browserless), created lazily so --dry-run and
// help do not require a backend to be configured.
let fetcherInstance: PageFetcher | null = null;
function getFetcher(): PageFetcher {
  if (!fetcherInstance) {
    fetcherInstance = createFetcher(
      {
        SUMMARY_FETCH_BACKEND: process.env.SUMMARY_FETCH_BACKEND,
        CRAWL4AI_BASE_URL,
        CRAWL4AI_TOKEN,
        BROWSERLESS_API_URL: process.env.BROWSERLESS_API_URL,
        BROWSERLESS_API_TOKEN: process.env.BROWSERLESS_API_TOKEN,
      },
      { acquire: () => externalThrottle.acquire() },
    );
    console.log(`fetch backend: ${fetcherInstance.name}`);
  }
  return fetcherInstance;
}

/** Fetch a URL's content via the configured backend. */
async function crawl(url: string): Promise<{ markdown: string; title?: string }> {
  return getFetcher().fetch(url);
}

/** Summarize markdown text via an OpenAI-compatible chat/completions endpoint. */
async function summarizeText(
  systemPrompt: string,
  title: string | undefined,
  markdown: string,
): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const content = markdown.slice(0, SUMMARY_MAX_INPUT_CHARS);
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `${title ? `Title: ${title}\n\n` : ""}${content}`,
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned empty summary");
  return text;
}

/** Resolve the list of items to process. */
async function resolveTargets(client: LaterClient, args: Args): Promise<Item[]> {
  if (args.retryFile) {
    const raw = await readFile(args.retryFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${args.retryFile}: expected a JSON array`);
    const items: Item[] = [];
    for (const entry of parsed) {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== "number") continue;
      const item = await client.getItem(id);
      if (item) items.push(item);
      else console.error(`skip: item ${id} not found`);
    }
    return args.limit !== undefined ? items.slice(0, args.limit) : items;
  }

  const items: Item[] = [];
  for await (const it of client.listNeedingSummary()) {
    items.push(it);
    if (args.limit !== undefined && items.length >= args.limit) break;
  }
  return items;
}

/**
 * Produce the summary + optional title for one item, choosing prompts by kind:
 *   - content    : crawl the page, content prompt.
 *   - hn-story    : crawl the linked article (content prompt) AND crawl the HN
 *                   thread (discussion prompt), then combine both sections.
 *   - hn-comment  : crawl the comment page, comment prompt.
 * Never touches `note`. The stored item URL is never changed.
 */
async function summarizeItem(
  item: Item,
  prompts: Prompts,
): Promise<{ summary: string; title?: string }> {
  const resolved = await resolveForSummary(item.url, resolveDeps);
  if (resolved.url !== item.url || resolved.kind !== "content") {
    console.log(
      `  #${item.id} kind=${resolved.kind}` +
        (resolved.url !== item.url ? ` target=${resolved.url}` : "") +
        (resolved.via ? ` [${resolved.via}]` : ""),
    );
  }

  if (resolved.kind === "hn-comment") {
    const crawled = await crawl(resolved.url);
    const summary = await summarizeText(prompts.comment, item.title ?? undefined, crawled.markdown);
    return { summary };
  }

  if (resolved.kind === "hn-story") {
    // 1) Content pass on the article (or the self-post page).
    const article = await crawl(resolved.url);
    const contentSummary = await summarizeText(
      prompts.content,
      article.title ?? item.title ?? undefined,
      article.markdown,
    );

    // 2) Discussion pass on the HN thread (best-effort; keep content if it fails).
    let discussionSummary = "";
    if (resolved.discussionUrl) {
      try {
        const thread = await crawl(resolved.discussionUrl);
        const prompt = renderDiscussionPrompt(prompts.discussion, contentSummary, thread.markdown);
        discussionSummary = await summarizeText(prompt, undefined, thread.markdown);
      } catch (e) {
        console.error(`  #${item.id} discussion pass failed: ${(e as Error).message}`);
      }
    }

    const summary = discussionSummary
      ? `${contentSummary}\n\n**Discussion**\n\n${discussionSummary}`
      : contentSummary;
    const out: { summary: string; title?: string } = { summary };
    if (!item.title && article.title) out.title = article.title;
    return out;
  }

  // content
  const crawled = await crawl(resolved.url);
  const summary = await summarizeText(
    prompts.content,
    crawled.title ?? item.title ?? undefined,
    crawled.markdown,
  );
  const out: { summary: string; title?: string } = { summary };
  if (!item.title && crawled.title) out.title = crawled.title;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !process.env.LATER_TOKEN) {
    console.error("LATER_TOKEN is required (or use --dry-run).");
    process.exit(1);
  }

  const client = new LaterClient();
  const prompts = await loadPrompts({
    dir: SUMMARY_PROMPT_DIR,
    legacyContentPath: SUMMARY_PROMPT_PATH,
  });
  const targets = await resolveTargets(client, args);
  console.log(`Processing ${targets.length} item(s).`);

  let ok = 0;
  let failed = 0;
  for (const item of targets) {
    if (args.dryRun) {
      console.log(`[dry] would summarize #${item.id} ${item.url}`);
      continue;
    }
    try {
      const patch = await summarizeItem(item, prompts);
      await client.patchItem(item.id, patch);
      ok++;
      console.log(`ok #${item.id} ${item.url}`);
    } catch (e) {
      failed++;
      const reason = (e as Error).message;
      console.error(`FAIL #${item.id} ${item.url} -> ${reason}`);
      try {
        await client.patchItem(item.id, { summary: `${SUMMARY_FAIL_PREFIX} ${reason}` });
      } catch (e2) {
        console.error(`  (could not write placeholder for #${item.id}): ${(e2 as Error).message}`);
      }
    }
    await sleep(200);
  }

  if (args.dryRun) console.log("\nDry run: nothing written.");
  else console.log(`\nDone. summarized=${ok} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
