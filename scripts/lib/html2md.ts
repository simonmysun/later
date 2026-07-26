/**
 * Minimal, zero-dependency HTML -> plain-text extraction for the browserless
 * backend (which returns rendered HTML). This is intentionally lightweight: it
 * strips boilerplate and produces readable text for the LLM, not perfect
 * Markdown. crawl4ai already returns good Markdown, so this only feeds the
 * browserless path.
 *
 * Approach (mirrors the bot's html2text config: ignore tables/links, images to
 * alt): drop script/style/head/nav/etc., convert a few block tags to newlines,
 * decode common entities, and collapse whitespace.
 */

/** Extract the <title> text from an HTML document, if any. */
export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!).replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : undefined;
}

const DROP_BLOCKS = ["script", "style", "noscript", "template", "svg", "head"];

/** Convert HTML to readable plain text. */
export function htmlToText(html: string): string {
  let s = html;

  // Remove whole unwanted elements (including content).
  for (const tag of DROP_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Turn block-level boundaries into newlines so text doesn't run together.
  s = s.replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<h[1-6][^>]*>/gi, "\n\n");

  // Replace images with their alt text.
  s = s.replace(/<img[^>]*\balt=(["'])(.*?)\1[^>]*>/gi, (_m, _q, alt: string) => (alt ? ` ${alt} ` : " "));

  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");

  // Decode entities and normalize whitespace.
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/** Decode numeric (&#123; / &#x1F;) and common named HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key]! : m;
    });
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}
