import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFeed, mergeTags } from "../rss.ts";

test("parseFeed: RSS 2.0 items with link + title", () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Example</title>
      <item><title>First</title><link>https://e.com/1</link></item>
      <item><title>Second</title><link>https://e.com/2</link></item>
    </channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { url: "https://e.com/1", title: "First" });
  assert.deepEqual(entries[1], { url: "https://e.com/2", title: "Second" });
});

test("parseFeed: RSS 2.0 single item (not array)", () => {
  const xml = `<rss><channel><item><title>Only</title><link>https://e.com/x</link></item></channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.url, "https://e.com/x");
});

test("parseFeed: RSS 2.0 item missing link is skipped", () => {
  const xml = `<rss><channel>
    <item><title>NoLink</title></item>
    <item><title>Good</title><link>https://e.com/ok</link></item>
  </channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.url, "https://e.com/ok");
});

test("parseFeed: CDATA titles are unwrapped/trimmed", () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[  Hello & <World>  ]]></title><link>https://e.com/c</link></item>
  </channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, "Hello & <World>");
});

test("parseFeed: Atom entries use link href, prefer rel=alternate", () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Post</title>
        <link rel="edit" href="https://e.com/edit"/>
        <link rel="alternate" href="https://e.com/post"/>
      </entry>
    </feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.url, "https://e.com/post");
  assert.equal(entries[0]!.title, "Post");
});

test("parseFeed: Atom single link without rel", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>T</title><link href="https://e.com/only"/></entry>
  </feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries[0]!.url, "https://e.com/only");
});

test("parseFeed: RDF / RSS 1.0 items", () => {
  const xml = `<?xml version="1.0"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <item><title>RDF One</title><link>https://e.com/rdf1</link></item>
      <item><title>RDF Two</title><link>https://e.com/rdf2</link></item>
    </rdf:RDF>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.url, "https://e.com/rdf1");
});

test("parseFeed: empty / non-feed XML yields nothing", () => {
  assert.deepEqual(parseFeed("<html><body>not a feed</body></html>"), []);
  assert.deepEqual(parseFeed("<rss><channel></channel></rss>"), []);
});

test("parseFeed: item without title still imported (title optional)", () => {
  const xml = `<rss><channel><item><link>https://e.com/nt</link></item></channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.url, "https://e.com/nt");
  assert.equal(entries[0]!.title, undefined);
});

// ---- mergeTags ----

test("mergeTags: always includes rss, lowercased + de-duplicated", () => {
  assert.deepEqual(mergeTags(undefined), ["rss"]);
  assert.deepEqual(mergeTags([]), ["rss"]);
  assert.deepEqual(mergeTags(["Tech", "News"]), ["rss", "tech", "news"]);
  assert.deepEqual(mergeTags(["rss", "RSS", "x"]), ["rss", "x"]);
});

test("mergeTags: drops blank entries", () => {
  assert.deepEqual(mergeTags(["  ", "keep", ""]), ["rss", "keep"]);
});
