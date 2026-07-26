import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configure env BEFORE importing modules that read it.
const TOKEN = "test-token";
const tmp = mkdtempSync(join(tmpdir(), "later-test-"));
process.env.LATER_TOKEN = TOKEN;
process.env.DB_PATH = join(tmp, "test.db");
process.env.LATER_AUTH_READ = "false";

const { requestListener } = await import("../src/server.ts");
const { getDb, closeDb } = await import("../src/db.ts");

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    void requestListener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const AUTH = (m: string, p: string, b?: unknown) => req(m, p, b, TOKEN);

test("1. POST creates item with tags, domain; duplicates allowed", async () => {
  const r1 = await AUTH("POST", "/api/items", {
    url: "https://example.com/a",
    tags: ["Foo", "bar", "foo"], // dedupe + lowercase
    title: "Hello",
  });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.domain, "example.com");
  assert.deepEqual(r1.json.tags.sort(), ["bar", "foo"]);
  assert.equal(r1.json.is_read, false);
  assert.equal(r1.json.summary, null);
  assert.equal(typeof r1.json.added_at, "number");

  const r2 = await AUTH("POST", "/api/items", { url: "https://example.com/a" });
  assert.equal(r2.status, 201);
  assert.notEqual(r1.json.id, r2.json.id); // not deduped
});

test("2. POST missing url => 400; is_read/summary ignored", async () => {
  const bad = await AUTH("POST", "/api/items", { url: "" });
  assert.equal(bad.status, 400);

  const r = await AUTH("POST", "/api/items", {
    url: "https://ignore.test",
    is_read: true,
    summary: "should be ignored",
    archived: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.is_read, false);
  assert.equal(r.json.summary, null);
  assert.equal(r.json.archived_at, null);
});

test("3. URL parse: unparseable => domain ''", async () => {
  const r = await AUTH("POST", "/api/items", { url: "not a url" });
  assert.equal(r.status, 201);
  assert.equal(r.json.domain, "");
  const list = await req("GET", "/api/items?domain=");
  assert.ok(list.json.items.some((i: any) => i.id === r.json.id));
});

test("4. write without/with wrong token => 401; GET works", async () => {
  const noTok = await req("POST", "/api/items", { url: "https://x.test" });
  assert.equal(noTok.status, 401);
  const wrong = await req("POST", "/api/items", { url: "https://x.test" }, "nope");
  assert.equal(wrong.status, 401);
  const get = await req("GET", "/api/items");
  assert.equal(get.status, 200);
});

test("5. filters: tags and/or, untagged, domain, read, has_summary", async () => {
  // seed fresh-ish
  const a = await AUTH("POST", "/api/items", { url: "https://t.test/1", tags: ["x", "y"] });
  const b = await AUTH("POST", "/api/items", { url: "https://t.test/2", tags: ["x"] });
  const c = await AUTH("POST", "/api/items", { url: "https://t.test/3", tags: [] });

  const or = await req("GET", "/api/items?tags=x,y&tag_mode=or&domain=t.test");
  assert.equal(or.json.items.length, 2);

  const and = await req("GET", "/api/items?tags=x,y&tag_mode=and&domain=t.test");
  assert.equal(and.json.items.length, 1);
  assert.equal(and.json.items[0].id, a.json.id);

  const untagged = await req("GET", "/api/items?untagged=true&domain=t.test");
  assert.equal(untagged.json.items.length, 1);
  assert.equal(untagged.json.items[0].id, c.json.id);

  // tags + untagged mutually exclusive
  const conflict = await req("GET", "/api/items?tags=x&untagged=true");
  assert.equal(conflict.status, 400);

  // has_summary
  await AUTH("PATCH", `/api/items/${b.json.id}`, { summary: "done" });
  const withSum = await req("GET", "/api/items?has_summary=true&domain=t.test");
  assert.ok(withSum.json.items.some((i: any) => i.id === b.json.id));
  const noSum = await req("GET", "/api/items?has_summary=false&domain=t.test");
  assert.ok(!noSum.json.items.some((i: any) => i.id === b.json.id));
});

test("6. summary normalized to null (whitespace)", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://sum.test" });
  await AUTH("PATCH", `/api/items/${r.json.id}`, { summary: "hi" });
  const patched = await AUTH("PATCH", `/api/items/${r.json.id}`, { summary: "   " });
  assert.equal(patched.json.summary, null);
  const q = await req("GET", `/api/items?has_summary=false&domain=sum.test`);
  assert.ok(q.json.items.some((i: any) => i.id === r.json.id));
});

test("7. is_read toggles read_at; PATCH summary needs token", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://read.test" });
  const on = await AUTH("PATCH", `/api/items/${r.json.id}`, { is_read: true });
  assert.equal(on.json.is_read, true);
  assert.equal(typeof on.json.read_at, "number");
  const off = await AUTH("PATCH", `/api/items/${r.json.id}`, { is_read: false });
  assert.equal(off.json.read_at, null);

  const noTok = await req("PATCH", `/api/items/${r.json.id}`, { summary: "x" });
  assert.equal(noTok.status, 401);
});

test("8. tags replaced wholesale; tag counts active only; soft delete", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://tagc.test", tags: ["one", "two"] });
  const replaced = await AUTH("PATCH", `/api/items/${r.json.id}`, { tags: ["three"] });
  assert.deepEqual(replaced.json.tags, ["three"]);

  const tags = await req("GET", "/api/tags");
  const three = tags.json.find((t: any) => t.name === "three");
  assert.equal(three.count, 1);

  // soft delete removes from default list, count drops
  await AUTH("DELETE", `/api/items/${r.json.id}`);
  const def = await req("GET", "/api/items?domain=tagc.test");
  assert.ok(!def.json.items.some((i: any) => i.id === r.json.id));
  const arch = await req("GET", "/api/items?domain=tagc.test&archived=true");
  assert.ok(arch.json.items.some((i: any) => i.id === r.json.id));

  const tags2 = await req("GET", "/api/tags");
  const three2 = tags2.json.find((t: any) => t.name === "three");
  assert.equal(three2.count, 0);
  const tagsAll = await req("GET", "/api/tags?archived=all");
  const three3 = tagsAll.json.find((t: any) => t.name === "three");
  assert.equal(three3.count, 1);
});

test("9. archive/restore via PATCH", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://arch.test" });
  const arch = await AUTH("PATCH", `/api/items/${r.json.id}`, { archived: true });
  assert.equal(typeof arch.json.archived_at, "number");
  const restored = await AUTH("PATCH", `/api/items/${r.json.id}`, { archived: false });
  assert.equal(restored.json.archived_at, null);
});

test("10. hard delete removes permanently + cascade", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://hard.test", tags: ["hd"] });
  const del = await AUTH("DELETE", `/api/items/${r.json.id}?hard=true`);
  assert.equal(del.status, 200);
  const get = await req("GET", `/api/items/${r.json.id}`);
  assert.equal(get.status, 404);
  const all = await req("GET", `/api/items?domain=hard.test&archived=all`);
  assert.ok(!all.json.items.some((i: any) => i.id === r.json.id));
});

test("11. sort asc/desc with id tiebreak; random shape", async () => {
  const asc = await req("GET", "/api/items?sort=added_asc&limit=5");
  const times = asc.json.items.map((i: any) => i.added_at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);

  const rand = await req("GET", "/api/items?sort=random&limit=3");
  assert.ok(rand.json.items.length <= 3);
  assert.equal(rand.json.total, undefined);
  assert.equal(rand.json.limit, undefined);
});

test("12. response contract shape", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://shape.test", tags: ["s"] });
  const it = r.json;
  assert.equal(typeof it.is_read, "boolean");
  assert.equal(typeof it.added_at, "number");
  assert.equal(it.read_at, null);
  assert.equal(it.title, null);
  assert.ok(Array.isArray(it.tags));
});

test("13. param parsing: invalid values => 400; limit capped", async () => {
  assert.equal((await req("GET", "/api/items?sort=bogus")).status, 400);
  assert.equal((await req("GET", "/api/items?tag_mode=nope")).status, 400);
  assert.equal((await req("GET", "/api/items?archived=maybe")).status, 400);
  assert.equal((await req("GET", "/api/items?read=1")).status, 400);
  assert.equal((await req("GET", "/api/items?limit=-1")).status, 400);
  // limit above hard cap is clamped, not an error
  const capped = await req("GET", "/api/items?limit=99999");
  assert.equal(capped.status, 200);
  assert.ok(capped.json.limit <= 200);
});

test("14. journal_mode is wal", async () => {
  const db = getDb();
  const row = db.prepare("PRAGMA journal_mode").get() as unknown as { journal_mode: string };
  assert.equal(row.journal_mode.toLowerCase(), "wal");
});

test("pagination consistency", async () => {
  // create a clean domain of 5 items
  for (let i = 0; i < 5; i++) {
    await AUTH("POST", "/api/items", { url: `https://page.test/${i}` });
  }
  const p0 = await req("GET", "/api/items?domain=page.test&limit=2&offset=0&sort=added_asc");
  const p1 = await req("GET", "/api/items?domain=page.test&limit=2&offset=2&sort=added_asc");
  assert.equal(p0.json.total, 5);
  assert.equal(p0.json.items.length, 2);
  const ids0 = new Set(p0.json.items.map((i: any) => i.id));
  const overlap = p1.json.items.filter((i: any) => ids0.has(i.id));
  assert.equal(overlap.length, 0);
});

test("15. exact url filter matches only exact url (not substring)", async () => {
  const short = await AUTH("POST", "/api/items", {
    url: "https://news.ycombinator.com/item?id=419",
  });
  const long = await AUTH("POST", "/api/items", {
    url: "https://news.ycombinator.com/item?id=41972880",
  });

  // exact url= returns only the exact match
  const exact = await req(
    "GET",
    "/api/items?url=" + encodeURIComponent("https://news.ycombinator.com/item?id=419"),
  );
  assert.equal(exact.json.items.length, 1);
  assert.equal(exact.json.items[0].id, short.json.id);
  assert.ok(!exact.json.items.some((i: any) => i.id === long.json.id));

  // the long url is only reachable via its own exact value
  const exactLong = await req(
    "GET",
    "/api/items?url=" + encodeURIComponent("https://news.ycombinator.com/item?id=41972880"),
  );
  assert.equal(exactLong.json.items.length, 1);
  assert.equal(exactLong.json.items[0].id, long.json.id);

  // contrast: q= is a substring match, so the short id matches both
  const like = await req(
    "GET",
    "/api/items?q=" + encodeURIComponent("item?id=419"),
  );
  const likeIds = new Set(like.json.items.map((i: any) => i.id));
  assert.ok(likeIds.has(short.json.id));
  assert.ok(likeIds.has(long.json.id));
});

test("16. exact url filter combined with archived=all catches archived dupes", async () => {
  const u = "https://dup.test/exact-url";
  const created = await AUTH("POST", "/api/items", { url: u });
  await AUTH("PATCH", `/api/items/${created.json.id}`, { archived: true });

  // default (archived hidden) => not found
  const def = await req("GET", "/api/items?url=" + encodeURIComponent(u));
  assert.equal(def.json.items.length, 0);

  // archived=all => the archived duplicate is visible
  const all = await req("GET", "/api/items?url=" + encodeURIComponent(u) + "&archived=all&limit=1");
  assert.equal(all.json.items.length, 1);
  assert.equal(all.json.items[0].id, created.json.id);
});

test("17. POST canonicalizes readhacker /s/ -> /c/ (stored url + domain)", async () => {
  const r = await AUTH("POST", "/api/items", { url: "https://readhacker.news/s/CANON1" });
  assert.equal(r.status, 201);
  assert.equal(r.json.url, "https://readhacker.news/c/CANON1");
  assert.equal(r.json.domain, "readhacker.news");

  // The canonical /c/ URL is what is stored, so exact-url lookup uses /c/.
  const byC = await req(
    "GET",
    "/api/items?url=" + encodeURIComponent("https://readhacker.news/c/CANON1"),
  );
  assert.ok(byC.json.items.some((i: any) => i.id === r.json.id));

  // Looking up the original /s/ form does NOT match (it was rewritten on store).
  const byS = await req(
    "GET",
    "/api/items?url=" + encodeURIComponent("https://readhacker.news/s/CANON1"),
  );
  assert.ok(!byS.json.items.some((i: any) => i.id === r.json.id));
});

test("17b. /s/ and /c/ of same id collapse to one stored url (dedup key)", async () => {
  const s = await AUTH("POST", "/api/items", { url: "https://readhacker.news/s/CANON2" });
  const c = await AUTH("POST", "/api/items", { url: "https://readhacker.news/c/CANON2" });
  // No dedup by design, but both store the same canonical URL, so a script's
  // existsByUrl(/c/) check would find the /s/-added item.
  assert.equal(s.json.url, "https://readhacker.news/c/CANON2");
  assert.equal(c.json.url, "https://readhacker.news/c/CANON2");
  const both = await req(
    "GET",
    "/api/items?url=" + encodeURIComponent("https://readhacker.news/c/CANON2") + "&limit=10",
  );
  const ids = new Set(both.json.items.map((i: any) => i.id));
  assert.ok(ids.has(s.json.id));
  assert.ok(ids.has(c.json.id));
});

test("404 for unknown item and endpoint", async () => {
  assert.equal((await req("GET", "/api/items/999999")).status, 404);
  assert.equal((await req("GET", "/api/nope")).status, 404);
});
