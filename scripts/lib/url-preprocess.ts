/**
 * URL preprocessing for the summarizer.
 *
 * Ported from the lessons of simonmysun/telegram-summarize-bot: before fetching
 * a page for summarization, rewrite URLs to more machine-readable equivalents
 * and resolve indirection so the summary is about the actual article, not a
 * link-aggregator page.
 *
 * Two layers:
 *  - `normalizeUrl(raw)`  — pure, synchronous transforms (no network):
 *      * add a scheme when missing
 *      * arxiv /abs/ | /pdf/ -> /html/ (HTML is far better for LLMs than PDF)
 *      * strip common tracking query params (utm_*, fbclid, gclid, ...)
 *  - `resolveForSummary(url, deps)` — async; may hit the network:
 *      * Hacker News item?id=<id> story -> the linked article URL (fetch HN API)
 *      * arxiv HTML existence check with ar5iv.labs.arxiv.org fallback
 *
 * `resolveForSummary` takes injectable `fetchJson`/`headOk` so it is testable
 * without real network access.
 */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gclsrc$/i,
  /^dclid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^ref_?src$/i,
  /^ref$/i,
  /^spm$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^vero_(id|conv)$/i,
  /^yclid$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAMS.some((re) => re.test(key));
}

/** Add a scheme if the string looks like a bare host/path without one. */
export function ensureScheme(raw: string): string {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  // Protocol-relative //host/... -> https:
  if (s.startsWith("//")) return `https:${s}`;
  return `http://${s}`;
}

/** Remove known tracking query parameters, preserving order of the rest. */
export function stripTrackingParams(u: URL): void {
  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (!isTrackingParam(k)) keep.push([k, v]);
  }
  // Rebuild deterministically.
  const kept = new URLSearchParams();
  for (const [k, v] of keep) kept.append(k, v);
  u.search = kept.toString();
}

/**
 * Pure, synchronous URL normalization. Returns the rewritten URL string.
 * On unparseable input, returns the scheme-normalized string unchanged.
 */
export function normalizeUrl(raw: string): string {
  const withScheme = ensureScheme(raw);
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return withScheme;
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  // arxiv: prefer the HTML rendering over abs/pdf.
  if (host === "arxiv.org") {
    if (u.pathname.startsWith("/abs/") || u.pathname.startsWith("/pdf/")) {
      u.pathname = u.pathname.replace(/^\/(abs|pdf)\//, "/html/");
      // arxiv pdf links sometimes end in .pdf
      u.pathname = u.pathname.replace(/\.pdf$/i, "");
    }
  }

  stripTrackingParams(u);

  // Drop empty query/hash noise for stable output.
  if (u.search === "?") u.search = "";
  return u.toString();
}

/** Is this a Hacker News item URL? Returns the numeric id, or null. */
export function hnItemId(raw: string): number | null {
  let u: URL;
  try {
    u = new URL(ensureScheme(raw));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "news.ycombinator.com") return null;
  if (u.pathname !== "/item") return null;
  const id = u.searchParams.get("id");
  if (id === null || !/^\d+$/.test(id)) return null;
  return Number(id);
}

export interface ResolveDeps {
  /** Fetch JSON from a URL (used for the HN item API). Returns null on failure. */
  fetchJson: (url: string) => Promise<unknown>;
  /** HEAD/GET existence check: true if the resource exists (2xx/3xx, not 404). */
  headOk: (url: string) => Promise<boolean>;
  /**
   * Follow HTTP redirects and return the final URL (e.g. a link shortener or
   * readhacker.news/s/<id> that 302s to a Hacker News item). Return the input
   * unchanged when there is no redirect or resolution fails. This is only used
   * to pick the summarization target — the item's stored URL is never changed.
   */
  resolveRedirect?: (url: string) => Promise<string>;
}

/**
 * How the item should be summarized, which selects the prompt:
 *   - "content"    : a normal article/page (content prompt)
 *   - "hn-story"   : a Hacker News story — summarize the linked article (or the
 *                    HN self-post page) with the content prompt AND the HN
 *                    thread with the discussion prompt
 *   - "hn-comment" : a single Hacker News comment page (comment prompt)
 */
export type SummaryKind = "content" | "hn-story" | "hn-comment";

export interface ResolveResult {
  /** Kind of item; selects which prompt(s) to use. */
  kind: SummaryKind;
  /** URL to fetch and summarize for the primary (content) pass. */
  url: string;
  /** HN thread URL to fetch for the discussion pass (only for hn-story). */
  discussionUrl?: string;
  /** Human-readable note about what rewriting happened (for logging). */
  via?: string;
}

/**
 * Resolve a URL to the best target(s) for summarization and classify its kind,
 * possibly hitting the network. Steps:
 *   1. Follow HTTP redirects (link shorteners, readhacker.news/s/<id> -> HN
 *      item, etc.) to get the final URL. The stored item URL is never changed.
 *   2. Normalize the final URL.
 *   3. Classify via the HN item API (authoritative; tags not required) or
 *      handle arxiv existence, choosing the summarization target(s).
 */
export async function resolveForSummary(raw: string, deps: ResolveDeps): Promise<ResolveResult> {
  // Step 1: follow redirects on the raw URL so shorteners/redirectors resolve to
  // their real destination before classification. Only meaningful when the raw
  // URL is not already a canonical HN item link.
  let effective = raw;
  let redirectVia: string | undefined;
  if (deps.resolveRedirect && hnItemId(raw) === null) {
    try {
      const final = await deps.resolveRedirect(ensureScheme(raw));
      if (final && final !== raw && final !== ensureScheme(raw)) {
        effective = final;
        redirectVia = `redirect->${final}`;
      }
    } catch {
      /* keep raw on failure */
    }
  }

  const result = await classify(effective, deps);
  if (redirectVia) {
    result.via = result.via ? `${redirectVia} (${result.via})` : redirectVia;
  }
  return result;
}

/** Classify an already-redirect-resolved URL and pick summarization target(s). */
async function classify(raw: string, deps: ResolveDeps): Promise<ResolveResult> {
  const id = hnItemId(raw);
  if (id !== null) {
    const info = (await deps.fetchJson(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
    )) as { type?: string; url?: string } | null;
    const hnUrl = `https://news.ycombinator.com/item?id=${id}`;

    if (info && info.type === "comment") {
      return { kind: "hn-comment", url: hnUrl, via: "hn-comment" };
    }

    if (info && info.type === "story") {
      // External-link story: summarize the linked article + the HN discussion.
      if (typeof info.url === "string" && info.url) {
        const article = normalizeUrl(info.url);
        const resolved = await resolveArxiv(article, deps);
        return {
          kind: "hn-story",
          url: resolved.url,
          discussionUrl: hnUrl,
          via: `hn-story->article${resolved.via ? ` (${resolved.via})` : ""}`,
        };
      }
      // Self-post (Ask/Show/text): the post text and discussion share one page.
      // Summarize it once with the discussion prompt so comments are covered.
      return { kind: "hn-story", url: hnUrl, discussionUrl: hnUrl, via: "hn-self-story" };
    }

    // Unknown/failed HN lookup, or job/poll: summarize the HN page as content.
    return { kind: "content", url: normalizeUrl(raw), via: info?.type ? `hn-${info.type}` : "hn-unknown" };
  }

  // Non-HN: normalize + arxiv existence handling; always content.
  const normalized = normalizeUrl(raw);
  const resolved = await resolveArxiv(normalized, deps);
  return { kind: "content", url: resolved.url, via: resolved.via };
}

/**
 * If the URL is an arxiv HTML link, verify it exists; if not (404), fall back to
 * ar5iv.labs.arxiv.org, and if that also fails, fall back to the /abs/ page.
 */
async function resolveArxiv(url: string, deps: ResolveDeps): Promise<{ url: string; via?: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "arxiv.org" || !u.pathname.startsWith("/html/")) {
    return { url };
  }

  if (await deps.headOk(u.toString())) {
    return { url: u.toString(), via: "arxiv-html" };
  }

  // Fallback 1: ar5iv
  const ar5iv = new URL(u.toString());
  ar5iv.hostname = "ar5iv.labs.arxiv.org";
  if (await deps.headOk(ar5iv.toString())) {
    return { url: ar5iv.toString(), via: "arxiv-ar5iv" };
  }

  // Fallback 2: abstract page (has at least the abstract text)
  const abs = new URL(u.toString());
  abs.pathname = abs.pathname.replace(/^\/html\//, "/abs/");
  return { url: abs.toString(), via: "arxiv-abs-fallback" };
}
