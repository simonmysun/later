import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PROMPTS,
  loadPrompts,
  renderDiscussionPrompt,
} from "../lib/prompts.ts";

test("loadPrompts: all defaults when dir has no files", async () => {
  const warnings: string[] = [];
  const p = await loadPrompts({
    dir: "/nonexistent-dir-xyz",
    read: async () => null,
    warn: (m) => warnings.push(m),
  });
  assert.equal(p.content, DEFAULT_PROMPTS.content);
  assert.equal(p.discussion, DEFAULT_PROMPTS.discussion);
  assert.equal(p.comment, DEFAULT_PROMPTS.comment);
  assert.equal(warnings.length, 3); // one per missing file
});

test("loadPrompts: reads real files from a dir, missing ones fall back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  try {
    writeFileSync(join(dir, "content.md"), "MY CONTENT PROMPT\n");
    writeFileSync(join(dir, "comment.md"), "MY COMMENT PROMPT");
    // discussion.md intentionally absent -> default
    const p = await loadPrompts({ dir, warn: () => {} });
    assert.equal(p.content, "MY CONTENT PROMPT");
    assert.equal(p.comment, "MY COMMENT PROMPT");
    assert.equal(p.discussion, DEFAULT_PROMPTS.discussion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPrompts: empty file is treated as missing (default used)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  try {
    writeFileSync(join(dir, "content.md"), "   \n\t  ");
    const p = await loadPrompts({ dir, warn: () => {} });
    assert.equal(p.content, DEFAULT_PROMPTS.content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPrompts: legacy SUMMARY_PROMPT_PATH overrides content only", async () => {
  const p = await loadPrompts({
    dir: "/nope",
    legacyContentPath: "/legacy.md",
    read: async (path) => (path.endsWith("/legacy.md") ? "LEGACY CONTENT" : null),
    warn: () => {},
  });
  assert.equal(p.content, "LEGACY CONTENT");
  assert.equal(p.discussion, DEFAULT_PROMPTS.discussion);
  assert.equal(p.comment, DEFAULT_PROMPTS.comment);
});

test("loadPrompts: legacy path unreadable is ignored, dir content kept", async () => {
  const p = await loadPrompts({
    dir: "/d",
    legacyContentPath: "/missing.md",
    read: async (path) => (path.endsWith("/content.md") ? "DIR CONTENT" : null),
    warn: () => {},
  });
  assert.equal(p.content, "DIR CONTENT"); // legacy missing -> dir value stays
});

// ---- renderDiscussionPrompt ----

test("renderDiscussionPrompt: fills both placeholders", () => {
  const out = renderDiscussionPrompt(
    "SUM:\n{content}\nTHREAD:\n{discussion}",
    "the article summary",
    "the raw thread text",
  );
  assert.equal(out, "SUM:\nthe article summary\nTHREAD:\nthe raw thread text");
});

test("renderDiscussionPrompt: replaces all occurrences", () => {
  const out = renderDiscussionPrompt("{content} {content} | {discussion}", "A", "B");
  assert.equal(out, "A A | B");
});

test("default discussion prompt contains both placeholders", () => {
  assert.match(DEFAULT_PROMPTS.discussion, /\{content\}/);
  assert.match(DEFAULT_PROMPTS.discussion, /\{discussion\}/);
});
