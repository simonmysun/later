import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ensureScheme,
  normalizeUrl,
  hnItemId,
  resolveForSummary,
  stripTrackingParams,
  type ResolveDeps,
} from "../lib/url-preprocess.ts";

// ---- ensureScheme ----

test("ensureScheme: adds http:// to bare host", () => {
  assert.equal(ensureScheme("example.com/x"), "http://example.com/x");
  assert.equal(ensureScheme("  example.com  "), "http://example.com");
});

test("ensureScheme: preserves existing scheme", () => {
  assert.equal(ensureScheme("https://example.com"), "https://example.com");
  assert.equal(ensureScheme("http://example.com"), "http://example.com");
  assert.equal(ensureScheme("ftp://host/f"), "ftp://host/f");
});

test("ensureScheme: protocol-relative becomes https", () => {
  assert.equal(ensureScheme("//cdn.example.com/a.js"), "https://cdn.example.com/a.js");
});

// ---- normalizeUrl: arxiv ----

test("normalizeUrl: arxiv /abs/ -> /html/", () => {
  assert.equal(
    normalizeUrl("https://arxiv.org/abs/2401.12345"),
    "https://arxiv.org/html/2401.12345",
  );
});

test("normalizeUrl: arxiv /pdf/ -> /html/ and drops .pdf", () => {
  assert.equal(
    normalizeUrl("https://arxiv.org/pdf/2401.12345.pdf"),
    "https://arxiv.org/html/2401.12345",
  );
  assert.equal(
    normalizeUrl("https://arxiv.org/pdf/2401.12345"),
    "https://arxiv.org/html/2401.12345",
  );
});

test("normalizeUrl: www.arxiv.org also handled", () => {
  assert.equal(
    normalizeUrl("https://www.arxiv.org/abs/1234.5678"),
    "https://www.arxiv.org/html/1234.5678",
  );
});

test("normalizeUrl: non-arxiv path untouched", () => {
  assert.equal(normalizeUrl("https://arxiv.org/list/cs.AI/recent"), "https://arxiv.org/list/cs.AI/recent");
});

// ---- normalizeUrl: tracking params ----

test("normalizeUrl: strips utm_* and friends, keeps real params", () => {
  const out = normalizeUrl(
    "https://example.com/p?id=42&utm_source=nl&utm_medium=email&fbclid=abc&gclid=xyz",
  );
  const u = new URL(out);
  assert.equal(u.searchParams.get("id"), "42");
  assert.equal(u.searchParams.get("utm_source"), null);
  assert.equal(u.searchParams.get("utm_medium"), null);
  assert.equal(u.searchParams.get("fbclid"), null);
  assert.equal(u.searchParams.get("gclid"), null);
});

test("normalizeUrl: all-tracking query becomes clean", () => {
  assert.equal(normalizeUrl("https://example.com/p?utm_source=x"), "https://example.com/p");
});

test("normalizeUrl: scheme added for bare host", () => {
  assert.equal(normalizeUrl("example.com/a?b=1"), "http://example.com/a?b=1");
});

test("stripTrackingParams: preserves order of kept params", () => {
  const u = new URL("https://e.com/?a=1&utm_source=x&b=2&c=3");
  stripTrackingParams(u);
  assert.equal(u.search, "?a=1&b=2&c=3");
});

// ---- hnItemId ----

test("hnItemId: extracts numeric id", () => {
  assert.equal(hnItemId("https://news.ycombinator.com/item?id=41972880"), 41972880);
  assert.equal(hnItemId("https://news.ycombinator.com/item?id=1"), 1);
});

test("hnItemId: rejects non-HN or malformed", () => {
  assert.equal(hnItemId("https://example.com/item?id=1"), null);
  assert.equal(hnItemId("https://news.ycombinator.com/newest"), null);
  assert.equal(hnItemId("https://news.ycombinator.com/item?id=abc"), null);
  assert.equal(hnItemId("not a url"), null);
});

// ---- resolveForSummary ----

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    fetchJson: async () => null,
    headOk: async () => true,
    ...over,
  };
}

test("resolveForSummary: HN story -> linked article, keeps discussion url", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=100", {
    ...deps(),
    fetchJson: async (url) => {
      assert.match(url, /item\/100\.json$/);
      return { type: "story", url: "https://blog.example.com/post?utm_source=hn" };
    },
  });
  assert.equal(r.kind, "hn-story");
  assert.equal(r.url, "https://blog.example.com/post"); // tracker stripped
  assert.equal(r.discussionUrl, "https://news.ycombinator.com/item?id=100");
  assert.match(r.via ?? "", /hn-story/);
});

test("resolveForSummary: HN comment -> kind hn-comment on the comment page", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=200", {
    ...deps(),
    fetchJson: async () => ({ type: "comment" }),
  });
  assert.equal(r.kind, "hn-comment");
  assert.equal(r.url, "https://news.ycombinator.com/item?id=200");
  assert.equal(r.discussionUrl, undefined);
  assert.equal(r.via, "hn-comment");
});

test("resolveForSummary: HN Ask/self story (no url) -> hn-story on HN page, self-discussion", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=300", {
    ...deps(),
    fetchJson: async () => ({ type: "story" }), // no url field (Ask HN)
  });
  assert.equal(r.kind, "hn-story");
  assert.equal(r.url, "https://news.ycombinator.com/item?id=300");
  assert.equal(r.discussionUrl, "https://news.ycombinator.com/item?id=300");
  assert.equal(r.via, "hn-self-story");
});

test("resolveForSummary: HN API failure -> content on HN page", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=400", {
    ...deps(),
    fetchJson: async () => null,
  });
  assert.equal(r.kind, "content");
  assert.equal(r.url, "https://news.ycombinator.com/item?id=400");
});

test("resolveForSummary: HN job/poll -> content", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=450", {
    ...deps(),
    fetchJson: async () => ({ type: "job" }),
  });
  assert.equal(r.kind, "content");
  assert.equal(r.url, "https://news.ycombinator.com/item?id=450");
});

test("resolveForSummary: arxiv HTML exists -> content kind, keep html", async () => {
  const r = await resolveForSummary("https://arxiv.org/abs/2401.00001", {
    ...deps(),
    headOk: async (u) => u === "https://arxiv.org/html/2401.00001",
  });
  assert.equal(r.kind, "content");
  assert.equal(r.url, "https://arxiv.org/html/2401.00001");
  assert.equal(r.via, "arxiv-html");
});

test("resolveForSummary: arxiv HTML missing -> ar5iv fallback", async () => {
  const r = await resolveForSummary("https://arxiv.org/abs/2401.00002", {
    ...deps(),
    headOk: async (u) => u.includes("ar5iv.labs.arxiv.org"),
  });
  assert.equal(r.url, "https://ar5iv.labs.arxiv.org/html/2401.00002");
  assert.equal(r.via, "arxiv-ar5iv");
});

test("resolveForSummary: arxiv HTML and ar5iv missing -> abs fallback", async () => {
  const r = await resolveForSummary("https://arxiv.org/pdf/2401.00003", {
    ...deps(),
    headOk: async () => false,
  });
  assert.equal(r.url, "https://arxiv.org/abs/2401.00003");
  assert.equal(r.via, "arxiv-abs-fallback");
});

test("resolveForSummary: plain url just normalized (scheme + tracker), content kind", async () => {
  const r = await resolveForSummary("example.com/x?utm_source=y&keep=1", deps());
  assert.equal(r.kind, "content");
  assert.equal(r.url, "http://example.com/x?keep=1");
});

test("resolveForSummary: HN story pointing at arxiv resolves both hops", async () => {
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=500", {
    fetchJson: async () => ({ type: "story", url: "https://arxiv.org/pdf/2401.99999" }),
    headOk: async (u) => u === "https://arxiv.org/html/2401.99999",
  });
  assert.equal(r.kind, "hn-story");
  assert.equal(r.url, "https://arxiv.org/html/2401.99999");
  assert.equal(r.discussionUrl, "https://news.ycombinator.com/item?id=500");
});

// ---- redirect resolution ----

test("resolveForSummary: readhacker.news/s redirect -> HN story -> article", async () => {
  const HNURL = "https://news.ycombinator.com/item?id=41972880";
  const r = await resolveForSummary("https://readhacker.news/s/6YEpq", {
    // shortener 302s to the HN item (numeric id)
    resolveRedirect: async (u) => {
      assert.match(u, /readhacker\.news/);
      return HNURL;
    },
    fetchJson: async (u) => {
      assert.match(u, /item\/41972880\.json$/);
      return { type: "story", url: "https://real-article.example/post" };
    },
    headOk: async () => true,
  });
  // redirect target classified as an HN story -> summarize the linked article,
  // keep the HN thread as the discussion; stored URL is untouched by the caller.
  assert.equal(r.kind, "hn-story");
  assert.equal(r.url, "https://real-article.example/post");
  assert.equal(r.discussionUrl, "https://news.ycombinator.com/item?id=41972880");
  assert.match(r.via ?? "", /redirect->/);
});

test("resolveForSummary: generic shortener -> final article (content)", async () => {
  const r = await resolveForSummary("https://t.co/abc", {
    ...deps(),
    resolveRedirect: async () => "https://example.com/real?utm_source=tw&keep=1",
  });
  assert.equal(r.kind, "content");
  // final URL is normalized (tracker stripped) after following the redirect
  assert.equal(r.url, "https://example.com/real?keep=1");
  assert.match(r.via ?? "", /redirect->/);
});

test("resolveForSummary: no redirect -> unchanged, no redirect via", async () => {
  const r = await resolveForSummary("https://example.com/direct", {
    ...deps(),
    resolveRedirect: async (u) => u, // no change
  });
  assert.equal(r.kind, "content");
  assert.equal(r.url, "https://example.com/direct");
  assert.equal(r.via ?? "", "");
});

test("resolveForSummary: redirect on an HN item URL is skipped (already canonical)", async () => {
  let redirectCalled = false;
  const r = await resolveForSummary("https://news.ycombinator.com/item?id=700", {
    resolveRedirect: async (u) => {
      redirectCalled = true;
      return u;
    },
    fetchJson: async () => ({ type: "comment" }),
    headOk: async () => true,
  });
  assert.equal(redirectCalled, false, "should not resolve redirects for canonical HN item URLs");
  assert.equal(r.kind, "hn-comment");
});

test("resolveForSummary: redirect failure keeps raw URL", async () => {
  const r = await resolveForSummary("https://example.com/x", {
    ...deps(),
    resolveRedirect: async () => {
      throw new Error("network");
    },
  });
  assert.equal(r.kind, "content");
  assert.equal(r.url, "https://example.com/x");
});
