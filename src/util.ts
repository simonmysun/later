import type { IncomingMessage, ServerResponse } from "node:http";

/** Error carrying an HTTP status code; thrown by handlers, caught by the server. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}
export function unauthorized(message = "unauthorized"): HttpError {
  return new HttpError(401, message);
}
export function notFound(message = "not found"): HttpError {
  return new HttpError(404, message);
}

/**
 * Parse the registrable host from a URL. Lowercased, leading `www.` stripped.
 * Returns '' when the URL cannot be parsed (tolerant policy).
 */
export function parseDomain(url: string): string {
  try {
    let host = new URL(url).hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
}

/** Normalize a single tag name: trim + lowercase. Empty => null. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/** Normalize a list of tag names, dropping empties and de-duplicating. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = normalizeTag(item);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Normalize optional text: undefined stays undefined; empty/whitespace => null. */
export function normalizeOptionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw badRequest("expected string");
  const t = v.trim();
  return t.length > 0 ? v : null;
}

/** Read and JSON-parse a request body. Empty body => {}. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX = 5 * 1024 * 1024; // 5 MiB guard
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX) throw badRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid JSON body");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("Unhandled error:", err);
  sendJson(res, 500, { error: "internal server error" });
}

// ---- query param parsing helpers ----

/** Strictly parse "true"/"false"; undefined => undefined; else 400. */
export function parseBool(v: string | null | undefined, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw badRequest(`invalid value for ${name}: expected "true" or "false"`);
}

/** Parse a non-negative integer string; undefined => fallback. */
export function parseNonNegInt(
  v: string | null | undefined,
  name: string,
  fallback: number,
): number {
  if (v === undefined || v === null || v === "") return fallback;
  if (!/^\d+$/.test(v)) throw badRequest(`invalid value for ${name}: expected non-negative integer`);
  return Number(v);
}

/** Parse an optional non-negative integer; undefined => undefined. */
export function parseOptionalNonNegInt(
  v: string | null | undefined,
  name: string,
): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw badRequest(`invalid value for ${name}: expected non-negative integer`);
  return Number(v);
}

/** Parse an enum-constrained string param with a default. */
export function parseEnum<T extends string>(
  v: string | null | undefined,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (v === undefined || v === null || v === "") return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw badRequest(`invalid value for ${name}: expected one of ${allowed.join(", ")}`);
}

/** Coerce a DB integer (0/1) to a JS boolean. */
export function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}
