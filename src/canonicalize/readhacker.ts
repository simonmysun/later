import type { SiteRule } from "./types.ts";

/**
 * readhacker.news uses two link shapes for the same story id:
 *   /s/<id>  -> the source article
 *   /c/<id>  -> the Hacker News comments/discussion
 *
 * We canonicalize the stored URL to the `/c/<id>` form so a story link and its
 * discussion link collapse to one item, and so the summarizer (which follows
 * redirects) lands on the HN thread -> article + discussion.
 */
export const readhackerRule: SiteRule = {
  name: "readhacker.news",
  apply(url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "readhacker.news") return;
    const m = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return;
    url.pathname = `/c/${m[1]}`;
    return url.toString();
  },
};
