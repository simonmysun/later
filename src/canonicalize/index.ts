/**
 * URL canonicalization applied at the storage boundary (createItem).
 *
 * This normalizes the URL we PERSIST and de-duplicate on — distinct from the
 * summarizer's URL preprocessing, which only affects the fetch target and never
 * changes the stored value. Per-site rules live in their own files and are
 * registered here.
 */
import type { SiteRule } from "./types.ts";
import { readhackerRule } from "./readhacker.ts";

export type { SiteRule } from "./types.ts";

/** Ordered list of site rules. Add new per-site rules here. */
export const SITE_RULES: SiteRule[] = [readhackerRule];

/**
 * Apply all site rules to a URL and return the canonical form to store.
 * Tolerant: unparseable input or a throwing rule leaves the URL unchanged.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not an absolute URL; store as-is (tolerant policy)
  }
  for (const rule of SITE_RULES) {
    try {
      const next = rule.apply(url);
      if (typeof next === "string" && next) {
        // Re-parse so subsequent rules see the updated URL.
        try {
          url = new URL(next);
        } catch {
          return next;
        }
      }
    } catch {
      /* a misbehaving rule must never break item creation */
    }
  }
  return url.toString();
}
