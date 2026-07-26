/**
 * Prompt loading for the summarizer.
 *
 * Three prompts select behaviour by item kind (ported from
 * simonmysun/telegram-summarize-bot's summarize_content / summarize_discussion /
 * summarize_comment):
 *
 *   content     — a normal article/page, and a HN story's linked article
 *   discussion  — a HN story's thread; a template with {content} and {discussion}
 *                 placeholders (content = the already-produced article summary)
 *   comment     — a single HN comment page
 *
 * Files are read from SUMMARY_PROMPT_DIR (default ./prompts) as
 * content.md / discussion.md / comment.md. Any missing/empty file falls back to
 * the built-in default below. For backward compatibility, SUMMARY_PROMPT_PATH
 * (a single file) overrides the *content* prompt if set.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PromptKey = "content" | "discussion" | "comment";

export interface Prompts {
  content: string;
  discussion: string;
  comment: string;
}

export const DEFAULT_PROMPTS: Prompts = {
  content:
    "You are a concise summarizer. Given the extracted text of a web page, " +
    "write a neutral 2-4 sentence summary of its main content, optionally with a " +
    "few short bullet points. Use only basic Markdown. Output only the summary.",
  discussion:
    "You have already summarized the linked article; now summarize what the " +
    "Hacker News discussion adds beyond it: main supportive/critical points, " +
    "corrections, useful extra facts or links, recurring themes, and overall " +
    "sentiment. Be concise and use only basic Markdown. Output only the summary.\n\n" +
    "Article summary (reference):\n\n```\n{content}\n```\n\n" +
    "Discussion thread:\n\n```\n{discussion}\n```",
  comment:
    "You are given a single Hacker News comment page: the top comment and its " +
    "replies. Summarize the top comment's point and the gist of notable replies; " +
    "mention the author and the story it is under if available. Be concise and " +
    "use only basic Markdown. Output only the summary.",
};

const FILES: Record<PromptKey, string> = {
  content: "content.md",
  discussion: "discussion.md",
  comment: "comment.md",
};

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export interface LoadPromptsOptions {
  /** Directory containing content.md/discussion.md/comment.md. */
  dir?: string;
  /** Legacy single-file override for the content prompt. */
  legacyContentPath?: string;
  /** Injectable reader for tests; defaults to filesystem. */
  read?: (path: string) => Promise<string | null>;
  /** Sink for informational warnings; defaults to console.error. */
  warn?: (msg: string) => void;
}

/**
 * Load the three prompts, falling back to built-in defaults per key when a file
 * is missing or empty. Never throws for missing files.
 */
export async function loadPrompts(opts: LoadPromptsOptions = {}): Promise<Prompts> {
  const dir = resolve(opts.dir ?? "./prompts");
  const read = opts.read ?? readIfPresent;
  const warn = opts.warn ?? ((m: string) => console.error(m));

  const result: Prompts = { ...DEFAULT_PROMPTS };

  for (const key of Object.keys(FILES) as PromptKey[]) {
    const path = join(dir, FILES[key]);
    const text = await read(path);
    if (text) result[key] = text;
    else warn(`prompt: using built-in default for "${key}" (no ${path})`);
  }

  // Legacy single-file override for the content prompt.
  if (opts.legacyContentPath) {
    const text = await read(resolve(opts.legacyContentPath));
    if (text) result.content = text;
    else warn(`prompt: SUMMARY_PROMPT_PATH ${opts.legacyContentPath} not readable; ignored`);
  }

  return result;
}

/** Fill {content}/{discussion} placeholders in the discussion prompt template. */
export function renderDiscussionPrompt(
  template: string,
  contentSummary: string,
  discussion: string,
): string {
  return template
    .replaceAll("{content}", contentSummary)
    .replaceAll("{discussion}", discussion);
}
