import { test } from "node:test";
import assert from "node:assert/strict";

import { extractCrawlResult, hasContent } from "../lib/crawl4ai.ts";

test("extractCrawlResult: { results: [ { markdown, metadata } ] }", () => {
  const r = extractCrawlResult({
    results: [{ markdown: "# Hello\n\nbody", metadata: { title: "Hi" } }],
  });
  assert.equal(r.markdown, "# Hello\n\nbody");
  assert.equal(r.title, "Hi");
});

test("extractCrawlResult: single object { markdown, metadata }", () => {
  const r = extractCrawlResult({ markdown: "text", metadata: { title: "T" } });
  assert.equal(r.markdown, "text");
  assert.equal(r.title, "T");
});

test("extractCrawlResult: markdown object with raw_markdown", () => {
  const r = extractCrawlResult({
    results: [{ markdown: { raw_markdown: "raw body", fit_markdown: "fit" } }],
  });
  assert.equal(r.markdown, "raw body");
});

test("extractCrawlResult: markdown object with only fit_markdown", () => {
  const r = extractCrawlResult({ markdown: { fit_markdown: "fit only" } });
  assert.equal(r.markdown, "fit only");
});

test("extractCrawlResult: missing title is undefined", () => {
  const r = extractCrawlResult({ markdown: "x" });
  assert.equal(r.title, undefined);
});

test("extractCrawlResult: blank title ignored", () => {
  const r = extractCrawlResult({ markdown: "x", metadata: { title: "   " } });
  assert.equal(r.title, undefined);
});

test("extractCrawlResult: garbage input yields no usable content", () => {
  for (const bad of [null, "nope", 42, { results: [] }, {}]) {
    assert.equal(hasContent(extractCrawlResult(bad)), false);
  }
  // primitives / null explicitly produce the empty object
  assert.deepEqual(extractCrawlResult(null), {});
  assert.deepEqual(extractCrawlResult("nope"), {});
});

// ---- hasContent (the "converted text has no content" guard) ----

test("hasContent: true only for non-whitespace markdown", () => {
  assert.equal(hasContent({ markdown: "real content" }), true);
  assert.equal(hasContent({ markdown: "   \n\t  " }), false);
  assert.equal(hasContent({ markdown: "" }), false);
  assert.equal(hasContent({}), false);
  assert.equal(hasContent({ title: "only title" }), false);
});
