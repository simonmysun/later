/**
 * Pluggable page-fetch backends for the summarizer.
 *
 * Two backends produce the same `PageContent` (markdown/text + optional title):
 *   - crawl4ai   : POST {base}/crawl {urls:[url]} -> Markdown + metadata.title
 *   - browserless : POST {base}/content?token=.. -> rendered HTML, converted to
 *                   text locally (html2md).
 *
 * Selection (env):
 *   SUMMARY_FETCH_BACKEND = crawl4ai | browserless   (explicit)
 *   otherwise: crawl4ai if CRAWL4AI_BASE_URL is set, else browserless if
 *   BROWSERLESS_API_URL is set. Errors if neither is configured.
 */

import { extractCrawlResult, hasContent } from "./crawl4ai.ts";
import { htmlToText, extractTitle } from "./html2md.ts";

export interface PageContent {
  /** Extracted text/markdown to summarize. Guaranteed non-empty by the fetcher. */
  markdown: string;
  /** Page title if the backend could determine one. */
  title?: string;
}

export interface PageFetcher {
  readonly name: string;
  fetch(url: string): Promise<PageContent>;
}

export interface FetcherEnv {
  SUMMARY_FETCH_BACKEND?: string;
  CRAWL4AI_BASE_URL?: string;
  CRAWL4AI_TOKEN?: string;
  BROWSERLESS_API_URL?: string;
  BROWSERLESS_API_TOKEN?: string;
}

export interface FetcherDeps {
  /** Acquire a rate-limit permit before each external call. */
  acquire: () => Promise<void>;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

const stripSlash = (s: string): string => s.replace(/\/+$/, "");

// ---- crawl4ai ----

export function createCrawl4aiFetcher(
  baseUrl: string,
  token: string | undefined,
  deps: FetcherDeps,
): PageFetcher {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: "crawl4ai",
    async fetch(url: string): Promise<PageContent> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      await deps.acquire();
      const res = await doFetch(`${stripSlash(baseUrl)}/crawl`, {
        method: "POST",
        headers,
        body: JSON.stringify({ urls: [url] }),
      });
      if (!res.ok) throw new Error(`crawl4ai HTTP ${res.status}`);
      const result = extractCrawlResult(await res.json());
      if (!hasContent(result)) throw new Error("crawl4ai returned empty content");
      return { markdown: result.markdown!.trim(), title: result.title };
    },
  };
}

// ---- browserless ----

/**
 * browserless /content returns rendered HTML for a URL. We convert it to text
 * locally. Options mirror the bot: block ads, enable JS, stealth, best attempt.
 */
export function createBrowserlessFetcher(
  baseUrl: string,
  token: string | undefined,
  deps: FetcherDeps,
): PageFetcher {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: "browserless",
    async fetch(url: string): Promise<PageContent> {
      const qs = new URLSearchParams({ blockAds: "true", stealth: "true" });
      if (token) qs.set("token", token);
      await deps.acquire();
      const res = await doFetch(`${stripSlash(baseUrl)}/content?${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          bestAttempt: true,
          gotoOptions: { waitUntil: "networkidle2", timeout: 55000 },
        }),
      });
      if (!res.ok) throw new Error(`browserless HTTP ${res.status}`);
      const html = await res.text();
      return browserlessHtmlToContent(html);
    },
  };
}

/** Convert browserless HTML into PageContent (exported for tests). */
export function browserlessHtmlToContent(html: string): PageContent {
  const title = extractTitle(html);
  const markdown = htmlToText(html);
  if (markdown.trim().length === 0) throw new Error("browserless returned empty content");
  return { markdown, title };
}

// ---- selection ----

export function selectBackend(env: FetcherEnv): "crawl4ai" | "browserless" {
  const explicit = env.SUMMARY_FETCH_BACKEND?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "crawl4ai" || explicit === "browserless") return explicit;
    throw new Error(
      `invalid SUMMARY_FETCH_BACKEND "${env.SUMMARY_FETCH_BACKEND}" (expected crawl4ai | browserless)`,
    );
  }
  if (env.CRAWL4AI_BASE_URL) return "crawl4ai";
  if (env.BROWSERLESS_API_URL) return "browserless";
  throw new Error(
    "no fetch backend configured: set CRAWL4AI_BASE_URL or BROWSERLESS_API_URL",
  );
}

/** Build the configured page fetcher. Throws with a clear message if unset. */
export function createFetcher(env: FetcherEnv, deps: FetcherDeps): PageFetcher {
  const backend = selectBackend(env);
  if (backend === "crawl4ai") {
    if (!env.CRAWL4AI_BASE_URL) throw new Error("CRAWL4AI_BASE_URL is not set");
    return createCrawl4aiFetcher(env.CRAWL4AI_BASE_URL, env.CRAWL4AI_TOKEN, deps);
  }
  if (!env.BROWSERLESS_API_URL) throw new Error("BROWSERLESS_API_URL is not set");
  return createBrowserlessFetcher(env.BROWSERLESS_API_URL, env.BROWSERLESS_API_TOKEN, deps);
}
