/**
 * A per-site URL canonicalization rule, applied at the storage boundary
 * (createItem) so the value we persist and de-duplicate on is stable.
 *
 * Rules are pure string->string transforms. A rule should:
 *   - only touch URLs it recognizes (check the host/path);
 *   - return the input unchanged when it does not apply;
 *   - never throw (return the input on any problem).
 */
export interface SiteRule {
  /** Short identifier for logging/tests. */
  name: string;
  /**
   * Transform a parsed URL in place (or return a replacement string). Return
   * the (possibly modified) URL string, or the original string if not handled.
   */
  apply: (url: URL) => string | void;
}
