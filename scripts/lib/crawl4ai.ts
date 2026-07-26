/**
 * crawl4ai response handling, isolated so the (uncertain) response contract can
 * be adjusted in one place and unit-tested without network or env access.
 *
 * The self-hosted crawl4ai REST shape varies by version; we tolerate:
 *   { results: [ { markdown, metadata } ] }
 *   { markdown, metadata }                       (single result)
 *   markdown as a string, or as { raw_markdown | fit_markdown }
 */

export interface CrawlResult {
  markdown?: string;
  title?: string;
}

function pick(obj: Record<string, unknown>): CrawlResult {
  let markdown: string | undefined;
  const md = obj["markdown"];
  if (typeof md === "string") {
    markdown = md;
  } else if (md && typeof md === "object") {
    const mo = md as Record<string, unknown>;
    const raw = mo["raw_markdown"] ?? mo["fit_markdown"] ?? mo["markdown"];
    if (typeof raw === "string") markdown = raw;
  }

  let title: string | undefined;
  const meta = obj["metadata"];
  if (meta && typeof meta === "object") {
    const t = (meta as Record<string, unknown>)["title"];
    if (typeof t === "string" && t.trim()) title = t.trim();
  }

  return { markdown, title };
}

/** Extract markdown + optional title from an arbitrary crawl4ai response body. */
export function extractCrawlResult(data: unknown): CrawlResult {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const results = obj["results"];
    if (
      Array.isArray(results) &&
      results.length > 0 &&
      results[0] &&
      typeof results[0] === "object"
    ) {
      return pick(results[0] as Record<string, unknown>);
    }
    return pick(obj);
  }
  return {};
}

/** True when a crawl result has usable (non-whitespace) content. */
export function hasContent(result: CrawlResult): boolean {
  return typeof result.markdown === "string" && result.markdown.trim().length > 0;
}
