/**
 * One-off importer: extract URLs from markdown files/dirs into the later app.
 *
 * Usage:
 *   node scripts/import-md.ts [--dry-run] [--base http://127.0.0.1:8787] <file-or-dir>...
 *
 * Requires LATER_TOKEN in the environment (unless --dry-run).
 *
 * Rules (conservative, predictable):
 *  - Track the most recent markdown heading (# .. ######); its normalized text
 *    becomes the item's single tag.
 *  - Extract http(s) URLs per line (a line may have several).
 *  - Skip fenced code blocks (``` or ~~~) so command URLs are not imported.
 *  - note = remaining text on the URL's line after removing the URL.
 *  - title empty; priority 0; is_read false.
 *  - No de-duplication.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

interface Extracted {
  url: string;
  tags: string[];
  note: string;
  source: string;
  line: number;
}

const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/g;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function stripTrailingPunctuation(url: string): string {
  // URLs at the end of a sentence often catch trailing punctuation.
  let u = url.replace(/[.,;:!?]+$/, "");
  // Strip unbalanced trailing ')' (common with markdown link syntax spillover).
  const opens = (u.match(/\(/g) || []).length;
  let closes = (u.match(/\)/g) || []).length;
  while (closes > opens && u.endsWith(")")) {
    u = u.slice(0, -1);
    closes--;
  }
  return u;
}

function normalizeHeadingTag(text: string): string | null {
  const t = text.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function extractFromMarkdown(content: string, source: string): Extracted[] {
  const out: Extracted[] = [];
  const lines = content.split(/\r?\n/);
  let currentTag: string | null = null;
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!; // ` or ~
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      currentTag = normalizeHeadingTag(heading[2]!);
      continue;
    }

    const matches = line.match(URL_RE);
    if (!matches) continue;

    for (const raw of matches) {
      const url = stripTrailingPunctuation(raw);
      const note = line.split(raw).join(" ").replace(/\s+/g, " ").trim();
      out.push({
        url,
        tags: currentTag ? [currentTag] : [],
        note,
        source,
        line: i + 1,
      });
    }
  }
  return out;
}

async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      const nested = entries.map((e) => join(p, e.name));
      files.push(...(await collectFiles(nested)));
    } else if (/\.(md|markdown)$/i.test(p)) {
      files.push(p);
    }
  }
  return files;
}

async function postItem(base: string, token: string, item: Extracted): Promise<void> {
  const res = await fetch(`${base}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      url: item.url,
      note: item.note || undefined,
      tags: item.tags,
      priority: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let base = "http://127.0.0.1:8787";
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") continue;
    if (a === "--base") {
      base = args[++i] ?? base;
      continue;
    }
    paths.push(a);
  }

  if (paths.length === 0) {
    console.error("Usage: node scripts/import-md.ts [--dry-run] [--base URL] <file-or-dir>...");
    process.exit(1);
  }

  const token = process.env.LATER_TOKEN;
  if (!dryRun && !token) {
    console.error("LATER_TOKEN is required (or use --dry-run).");
    process.exit(1);
  }

  const files = await collectFiles(paths);
  const all: Extracted[] = [];
  for (const f of files) {
    const content = await readFile(f, "utf8");
    all.push(...extractFromMarkdown(content, f));
  }

  console.log(`Found ${all.length} URL(s) across ${files.length} file(s).`);

  if (dryRun) {
    for (const it of all) {
      console.log(
        `[dry] ${it.source}:${it.line}  tag=${it.tags.join(",") || "-"}  ${it.url}` +
          (it.note ? `\n        note: ${it.note}` : ""),
      );
    }
    console.log(`\nDry run: nothing written.`);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const it of all) {
    try {
      await postItem(base, token!, it);
      ok++;
    } catch (e) {
      fail++;
      console.error(`FAIL ${it.source}:${it.line} ${it.url} -> ${(e as Error).message}`);
    }
  }
  console.log(`\nDone. success=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
