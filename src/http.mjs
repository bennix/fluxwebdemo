import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSecurityHeaders, enforceRate, issueChallenge, verifyChallenge } from "./flux-core.mjs";
import { storageMode } from "./store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function sendJson(res, status, body, extraHeaders = {}) {
  const headers = {
    ...buildSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export async function handleChallenge(req, res) {
  const limited = await enforceRate(req, "challenge");
  if (limited.limited) return sendJson(res, 429, { pass: false, reason: "rate_limited" }, { "Retry-After": String(limited.retryAfter) });
  const challenge = await issueChallenge(req, res);
  return sendJson(res, 200, challenge);
}

export async function handleVerify(req, res) {
  const limited = await enforceRate(req, "verify");
  if (limited.limited) return sendJson(res, 429, { pass: false, reason: "rate_limited" }, { "Retry-After": String(limited.retryAfter) });
  const payload = await readJson(req);
  const result = await verifyChallenge(req, payload);
  return sendJson(res, result.status, result.body);
}

export function handleHealth(_req, res) {
  return sendJson(res, 200, { ok: true, runtime: "node", storage: storageMode() });
}

export async function serveStatic(req, res) {
  let pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/verified") pathname = "/verified.html";
  if (pathname === "/failed") pathname = "/failed.html";
  const target = path.normalize(path.join(PUBLIC, pathname));
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403, buildSecurityHeaders());
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(target);
    const type = TYPES[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, { ...buildSecurityHeaders(), "Content-Type": type });
    res.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(PUBLIC, "index.html"));
    res.writeHead(404, { ...buildSecurityHeaders(), "Content-Type": TYPES[".html"] });
    res.end(fallback);
  }
}
