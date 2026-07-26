import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeUrl } from "../src/canonicalize/index.ts";
import { readhackerRule } from "../src/canonicalize/readhacker.ts";

// ---- readhacker.news /s/ -> /c/ ----

test("canonicalizeUrl: readhacker /s/<id> -> /c/<id>", () => {
  assert.equal(
    canonicalizeUrl("https://readhacker.news/s/6YEpq"),
    "https://readhacker.news/c/6YEpq",
  );
});

test("canonicalizeUrl: readhacker /s/<id>/ trailing slash", () => {
  assert.equal(
    canonicalizeUrl("https://readhacker.news/s/6YEpq/"),
    "https://readhacker.news/c/6YEpq",
  );
});

test("canonicalizeUrl: readhacker www. host handled", () => {
  assert.equal(
    canonicalizeUrl("https://www.readhacker.news/s/AbC123"),
    "https://www.readhacker.news/c/AbC123",
  );
});

test("canonicalizeUrl: readhacker /c/ left unchanged", () => {
  assert.equal(
    canonicalizeUrl("https://readhacker.news/c/6YEpq"),
    "https://readhacker.news/c/6YEpq",
  );
});

test("canonicalizeUrl: readhacker other paths unchanged", () => {
  assert.equal(canonicalizeUrl("https://readhacker.news/"), "https://readhacker.news/");
  assert.equal(
    canonicalizeUrl("https://readhacker.news/about"),
    "https://readhacker.news/about",
  );
  // nested path under /s/ is not the simple story form -> unchanged
  assert.equal(
    canonicalizeUrl("https://readhacker.news/s/6YEpq/extra"),
    "https://readhacker.news/s/6YEpq/extra",
  );
});

// ---- non-matching / tolerant behavior ----

test("canonicalizeUrl: unrelated host untouched", () => {
  assert.equal(canonicalizeUrl("https://example.com/s/6YEpq"), "https://example.com/s/6YEpq");
});

test("canonicalizeUrl: unparseable input returned as-is", () => {
  assert.equal(canonicalizeUrl("not a url"), "not a url");
  assert.equal(canonicalizeUrl(""), "");
});

test("canonicalizeUrl: preserves query and hash on non-matching urls", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/a?b=1#x"),
    "https://example.com/a?b=1#x",
  );
});

// ---- rule directly ----

test("readhackerRule: returns undefined (no change) for non-readhacker", () => {
  const u = new URL("https://example.com/s/1");
  assert.equal(readhackerRule.apply(u), undefined);
});

test("readhackerRule: rewrites path in place and returns string", () => {
  const u = new URL("https://readhacker.news/s/zzz");
  const out = readhackerRule.apply(u);
  assert.equal(out, "https://readhacker.news/c/zzz");
});
