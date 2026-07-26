import { test } from "node:test";
import assert from "node:assert/strict";

import { htmlToText, extractTitle, decodeEntities } from "../lib/html2md.ts";

test("extractTitle: reads <title>", () => {
  assert.equal(extractTitle("<html><head><title>Hello &amp; Bye</title></head></html>"), "Hello & Bye");
  assert.equal(extractTitle("<title>  spaced  </title>"), "spaced");
  assert.equal(extractTitle("<html>no title</html>"), undefined);
});

test("htmlToText: drops script/style/head content", () => {
  const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
    <body><script>var x=1;</script><p>Real text</p></body></html>`;
  const out = htmlToText(html);
  assert.match(out, /Real text/);
  assert.doesNotMatch(out, /color:red/);
  assert.doesNotMatch(out, /var x/);
});

test("htmlToText: block tags become newlines", () => {
  const out = htmlToText("<p>one</p><p>two</p>");
  assert.equal(out, "one\ntwo");
});

test("htmlToText: list items get bullets", () => {
  const out = htmlToText("<ul><li>a</li><li>b</li></ul>");
  assert.match(out, /- a/);
  assert.match(out, /- b/);
});

test("htmlToText: img replaced by alt text", () => {
  const out = htmlToText('<p>see <img src="x.png" alt="a cat"> here</p>');
  assert.match(out, /a cat/);
  assert.doesNotMatch(out, /x\.png/);
});

test("htmlToText: strips tags and decodes entities", () => {
  const out = htmlToText("<p>Tom &amp; Jerry &#8212; &lt;fun&gt;</p>");
  assert.equal(out, "Tom & Jerry \u2014 <fun>");
});

test("htmlToText: collapses excess whitespace/newlines to at most one blank line", () => {
  const out = htmlToText("<div>a</div>\n\n\n\n<div>b</div>");
  assert.equal(out, "a\n\nb");
  // adjacent blocks with no blank line collapse to a single newline
  assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\nb");
});

test("htmlToText: empty/whitespace html yields empty string", () => {
  assert.equal(htmlToText("<html><body>   </body></html>"), "");
  assert.equal(htmlToText(""), "");
});

test("decodeEntities: numeric hex + decimal + named", () => {
  assert.equal(decodeEntities("&#x41;&#66;&amp;"), "AB&");
  assert.equal(decodeEntities("&nbsp;"), " ");
  assert.equal(decodeEntities("&unknownentity;"), "&unknownentity;");
});
