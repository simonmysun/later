import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectBackend,
  createFetcher,
  browserlessHtmlToContent,
  type FetcherEnv,
} from "../lib/fetcher.ts";

const noop = { acquire: async () => {} };

// ---- backend selection ----

test("selectBackend: explicit values", () => {
  assert.equal(selectBackend({ SUMMARY_FETCH_BACKEND: "crawl4ai" }), "crawl4ai");
  assert.equal(selectBackend({ SUMMARY_FETCH_BACKEND: "browserless" }), "browserless");
  assert.equal(selectBackend({ SUMMARY_FETCH_BACKEND: "BrowserLess" }), "browserless");
});

test("selectBackend: explicit invalid throws", () => {
  assert.throws(() => selectBackend({ SUMMARY_FETCH_BACKEND: "wget" }), /invalid SUMMARY_FETCH_BACKEND/);
});

test("selectBackend: auto prefers crawl4ai", () => {
  assert.equal(
    selectBackend({ CRAWL4AI_BASE_URL: "http://c", BROWSERLESS_API_URL: "http://b" }),
    "crawl4ai",
  );
});

test("selectBackend: auto falls back to browserless", () => {
  assert.equal(selectBackend({ BROWSERLESS_API_URL: "http://b" }), "browserless");
});

test("selectBackend: none configured throws", () => {
  assert.throws(() => selectBackend({}), /no fetch backend configured/);
});

// ---- browserless HTML conversion ----

test("browserlessHtmlToContent: extracts title + text", () => {
  const c = browserlessHtmlToContent(
    "<html><head><title>My Page</title></head><body><p>Body text here.</p></body></html>",
  );
  assert.equal(c.title, "My Page");
  assert.match(c.markdown, /Body text here\./);
});

test("browserlessHtmlToContent: empty content throws", () => {
  assert.throws(() => browserlessHtmlToContent("<html><body>   </body></html>"), /empty content/);
});

// ---- crawl4ai fetcher (injected fetch) ----

test("createFetcher: crawl4ai posts to /crawl and parses markdown", async () => {
  let calledUrl = "";
  let body = "";
  const fetchImpl = (async (url: string, init: any) => {
    calledUrl = String(url);
    body = String(init.body);
    return new Response(
      JSON.stringify({ results: [{ markdown: "# Hi\n\ntext", metadata: { title: "T" } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const env: FetcherEnv = { CRAWL4AI_BASE_URL: "http://crawl:1/", CRAWL4AI_TOKEN: "tok" };
  const f = createFetcher(env, { ...noop, fetchImpl });
  assert.equal(f.name, "crawl4ai");
  const out = await f.fetch("https://example.com/x");
  assert.match(calledUrl, /\/crawl$/);
  assert.match(body, /example\.com/);
  assert.equal(out.markdown, "# Hi\n\ntext");
  assert.equal(out.title, "T");
});

test("createFetcher: crawl4ai non-200 throws", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const f = createFetcher({ CRAWL4AI_BASE_URL: "http://c" }, { ...noop, fetchImpl });
  await assert.rejects(() => f.fetch("https://x"), /crawl4ai HTTP 500/);
});

test("createFetcher: crawl4ai empty content throws", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ results: [{ markdown: "   " }] }), { status: 200 })) as unknown as typeof fetch;
  const f = createFetcher({ CRAWL4AI_BASE_URL: "http://c" }, { ...noop, fetchImpl });
  await assert.rejects(() => f.fetch("https://x"), /empty content/);
});

// ---- browserless fetcher (injected fetch) ----

test("createFetcher: browserless posts to /content with token + url, converts HTML", async () => {
  let calledUrl = "";
  let body = "";
  const fetchImpl = (async (url: string, init: any) => {
    calledUrl = String(url);
    body = String(init.body);
    return new Response(
      "<html><head><title>BL</title></head><body><p>Rendered page.</p></body></html>",
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const env: FetcherEnv = {
    SUMMARY_FETCH_BACKEND: "browserless",
    BROWSERLESS_API_URL: "https://bl.example",
    BROWSERLESS_API_TOKEN: "secret",
  };
  const f = createFetcher(env, { ...noop, fetchImpl });
  assert.equal(f.name, "browserless");
  const out = await f.fetch("https://example.com/page");
  assert.match(calledUrl, /\/content\?/);
  assert.match(calledUrl, /token=secret/);
  assert.match(body, /example\.com\/page/);
  assert.equal(out.title, "BL");
  assert.match(out.markdown, /Rendered page\./);
});

test("createFetcher: browserless non-200 throws", async () => {
  const fetchImpl = (async () => new Response("x", { status: 403 })) as unknown as typeof fetch;
  const f = createFetcher(
    { SUMMARY_FETCH_BACKEND: "browserless", BROWSERLESS_API_URL: "http://b" },
    { ...noop, fetchImpl },
  );
  await assert.rejects(() => f.fetch("https://x"), /browserless HTTP 403/);
});

test("createFetcher: acquire is called before fetch (rate limiting)", async () => {
  const order: string[] = [];
  const deps = {
    acquire: async () => {
      order.push("acquire");
    },
    fetchImpl: (async () => {
      order.push("fetch");
      return new Response(JSON.stringify({ markdown: "ok" }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  const f = createFetcher({ CRAWL4AI_BASE_URL: "http://c" }, deps);
  await f.fetch("https://x");
  assert.deepEqual(order, ["acquire", "fetch"]);
});
