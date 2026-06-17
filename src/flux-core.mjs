import crypto from "node:crypto";
import {
  BEHAVIOR_PASS_THRESHOLD,
  BOARD,
  DEFAULT_SECRET,
  GAP,
  GLYPHS,
  M,
  MAX_EVENTS,
  MAX_FAILURES_PER_CHALLENGE,
  MAX_VERIFY_ATTEMPTS_PER_CHALLENGE,
  N,
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_SECONDS,
  SOFT_BEHAVIOR_PASS_THRESHOLD,
  START,
  TILE,
  TTL_SECONDS
} from "./config.mjs";
import { commitVerify, getChallenge, getChallengeRaw, incrWithTtl, saveChallenge, serializeChallenge } from "./store.mjs";

function nowSeconds() {
  return Date.now() / 1000;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function secretKey() {
  return crypto.createHash("sha256").update(DEFAULT_SECRET).digest();
}

function encryptState(state) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return base64url(Buffer.concat([iv, tag, ciphertext]));
}

function decryptState(token) {
  const raw = fromBase64url(token);
  if (raw.length < 29) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function randInt(max) {
  return crypto.randomInt(max);
}

function shuffle(values) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shuffledDerangement(size) {
  let out = shuffle([...Array(size).keys()]);
  while (out.some((value, index) => value === index)) {
    out = shuffle([...Array(size).keys()]);
  }
  return out;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function slotXY(slot) {
  return { x: (slot % N) * TILE, y: Math.floor(slot / N) * TILE };
}

// Screen-space top-left of a board slot, matching the client's slotPos and the patent's slot_position.
export function slotPosition(slot) {
  const col = slot % N;
  const row = Math.floor(slot / N);
  return { x: START + col * (TILE + GAP), y: START + row * (TILE + GAP) };
}

function makeTileSvg(glyph, sourceSlot, seed, phase) {
  const { x, y } = slotXY(sourceSlot);
  const fontSize = 330;
  const cx = BOARD / 2 + Math.sin(phase) * 5;
  const cy = BOARD / 2 + 112 + Math.cos(phase) * 4;
  const escaped = escapeXml(glyph);
  return svgDataUrl(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="${x} ${y} ${TILE} ${TILE}">
  <defs>
    <clipPath id="clip"><rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" rx="10"/></clipPath>
    <filter id="warp" x="-20" y="-20" width="${BOARD + 40}" height="${BOARD + 40}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse">
      <feTurbulence type="fractalNoise" baseFrequency="0.008 0.015" numOctaves="2" seed="${seed}" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <linearGradient id="grid" x1="0" x2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dcecff"/>
    </linearGradient>
  </defs>
  <rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" fill="url(#grid)"/>
  <g clip-path="url(#clip)">
    <rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" fill="#f4fbff"/>
    <g opacity="0.28">
      ${Array.from({ length: 9 }, (_, i) => `<path d="M ${-30 + i * 58} ${BOARD + 20} C ${90 + i * 8} ${180 - i * 9}, ${260 - i * 7} ${210 + i * 5}, ${BOARD + 40} ${-20 + i * 46}" fill="none" stroke="${i % 2 ? "#26d9ff" : "#ff4de3"}" stroke-width="7" stroke-linecap="round"><animate attributeName="stroke-dashoffset" values="0;80;0" dur="${3.2 + i * 0.13}s" repeatCount="indefinite"/></path>`).join("")}
    </g>
    <g filter="url(#warp)">
      <text x="${cx}" y="${cy}" text-anchor="middle" font-family="Arial Black, Impact, system-ui, sans-serif" font-size="${fontSize}" font-weight="900" fill="#05070d" stroke="#ffffff" stroke-width="30" stroke-linejoin="round" paint-order="stroke fill" transform="rotate(${Math.sin(phase) * 2.4} ${BOARD / 2} ${BOARD / 2}) scale(1.08 0.98)">
        <animateTransform attributeName="transform" type="translate" values="0 0; 2 -1; -1 2; 0 0" dur="3.8s" repeatCount="indefinite" additive="sum"/>
        ${escaped}
      </text>
    </g>
    <rect x="${x + 1}" y="${y + 1}" width="${TILE - 2}" height="${TILE - 2}" rx="10" fill="none" stroke="rgba(5,7,13,.2)" stroke-width="2"/>
  </g>
</svg>`);
}

function makeHintSvg(glyph, seed) {
  const escaped = escapeXml(glyph);
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
    <defs><filter id="blur"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
    <rect width="72" height="72" rx="10" fill="#f6fbff"/>
    <text x="36" y="53" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="52" font-weight="900" fill="#05070d" stroke="#fff" stroke-width="8" paint-order="stroke fill" filter="url(#blur)" transform="rotate(${(seed % 7) - 3} 36 36)">${escaped}</text>
    <path d="M6 60 C24 10, 44 66, 68 12" fill="none" stroke="#28e6ff" stroke-width="4" opacity=".32"/>
  </svg>`);
}

function neighborHints(glyph) {
  const code = glyph.charCodeAt(0);
  const prev = String.fromCharCode(Math.max(33, code - 1));
  const next = String.fromCharCode(Math.min(126, code + 1));
  return [
    { label: "ASCII -1", image: makeHintSvg(prev, code - 1) },
    { label: "ASCII +1", image: makeHintSvg(next, code + 1) }
  ];
}

function parseCookie(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getOrCreateSession(req, res) {
  const cookies = parseCookie(req.headers.cookie || "");
  let session = cookies.flux_session;
  const headers = {};
  if (!session || !/^[A-Za-z0-9_-]{24,}$/.test(session)) {
    session = base64url(crypto.randomBytes(18));
    headers["Set-Cookie"] = `flux_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
  }
  if (res && headers["Set-Cookie"]) res.setHeader("Set-Cookie", headers["Set-Cookie"]);
  return session;
}

export function currentSession(req) {
  return parseCookie(req.headers.cookie || "").flux_session || "";
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw ? raw.split(",")[0].trim() : req.socket?.remoteAddress || "local").replace(/^::ffff:/, "");
}

export async function enforceRate(req, res, bucket) {
  const ip = clientIp(req);
  const sessionId = currentSession(req);
  const windowSeconds = RATE_LIMIT_WINDOW_SECONDS;
  const limit = RATE_LIMITS[bucket] || 60;
  // Patent: rate-limit on both IP and session so a single IP cannot rotate sessions to bypass.
  const buckets = [["ip", ip]];
  if (sessionId) buckets.push(["session", sessionId]);
  let retryAfter = 0;
  let limited = false;
  for (const [scope, value] of buckets) {
    const count = await incrWithTtl(`${bucket}:${scope}:${value}`, windowSeconds);
    if (count > limit) {
      limited = true;
      retryAfter = Math.max(retryAfter, windowSeconds);
    }
  }
  if (limited) return { limited: true, status: 429, retryAfter };
  return { limited: false };
}

export async function issueChallenge(req, res, payload = {}) {
  const session_id = getOrCreateSession(req, res);
  // Patent anti-replay: if the client passes a previous challenge_id, avoid repeating its glyph.
  let avoidGlyph = null;
  const avoidId = String(payload?.avoid_challenge_id || "");
  if (avoidId) {
    const previous = await getChallenge(avoidId);
    if (previous?.glyph) avoidGlyph = previous.glyph;
  }
  const pool = GLYPHS;
  let glyph;
  if (avoidGlyph && pool.length > 1) {
    do {
      glyph = pool[randInt(pool.length)];
    } while (glyph === avoidGlyph);
  } else {
    glyph = pool[randInt(pool.length)];
  }
  const seed = randInt(9999) + 1;
  const phase = crypto.randomBytes(4).readUInt32BE(0) / 0xffffffff * Math.PI * 2;
  // Patent: start slots must be a derangement so no tile is already in its answer slot.
  const startSlots = shuffledDerangement(M);
  const now = nowSeconds();
  const state = {
    v: 1,
    glyph,
    seed,
    phase,
    answer: [...Array(M).keys()],
    start_slots: startSlots,
    session_id,
    created_at: now,
    expires_at: now + TTL_SECONDS,
    failures: 0,
    attempts: 0,
    used: false,
    locked: false
  };
  const challenge_id = encryptState(state);
  state.challenge_id = challenge_id;
  await saveChallenge(state, TTL_SECONDS);
  return {
    challenge_id,
    expires_in: TTL_SECONDS,
    n: N,
    tile: TILE,
    gap: GAP,
    hint_images: neighborHints(glyph),
    tiles: [...Array(M).keys()].map((id) => ({
      id,
      start_slot: startSlots[id],
      image: makeTileSvg(glyph, id, seed, phase)
    }))
  };
}

function publicFailure(reason = "verification_failed") {
  return { pass: false, reason };
}

function validMapping(mapping) {
  return Array.isArray(mapping) && mapping.length === M && new Set(mapping).size === M && mapping.every((v) => Number.isInteger(v) && v >= 0 && v < M);
}

function eventNumber(item, key) {
  const value = Number(item?.[key]);
  return Number.isFinite(value) ? value : null;
}

function eventInt(item, key) {
  const value = item?.[key];
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function coreInteractionEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return null;
  const core = [];
  for (const item of events) {
    if (!item || typeof item !== "object") return null;
    if (item.type === "verify_click") continue;
    core.push(item);
  }
  return core;
}

export function hasManualVerifyIntent(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return false;
  let lastCoreT = null;
  let lastUpT = null;
  let clickT = null;
  for (const item of events) {
    if (!item || typeof item !== "object") return false;
    const t = eventNumber(item, "t");
    if (["down", "move", "swap", "up"].includes(item.type)) {
      if (t === null) return false;
      lastCoreT = lastCoreT === null ? t : Math.max(lastCoreT, t);
      if (item.type === "up") lastUpT = lastUpT === null ? t : Math.max(lastUpT, t);
    } else if (item.type === "verify_click") {
      if (t === null || item.target !== "check") return false;
      clickT = clickT === null ? t : Math.max(clickT, t);
    } else {
      return false;
    }
  }
  if (clickT === null) return false;
  if (lastUpT !== null && clickT < lastUpT) return false;
  if (lastCoreT !== null && clickT < lastCoreT) return false;
  return true;
}

export function scoreBehavior(events) {
  if (!Array.isArray(events) || events.length < 4 || events.length > MAX_EVENTS) return { score: 0, straight_robotic: 0 };
  const clean = [];
  for (const item of events) {
    if (!["down", "move", "up"].includes(item?.type)) continue;
    const x = eventNumber(item, "x");
    const y = eventNumber(item, "y");
    const t = eventNumber(item, "t");
    if (x !== null && y !== null && t !== null) clean.push([item.type, x, y, t]);
  }
  if (clean.length < 4) return { score: 0, straight_robotic: 0 };
  clean.sort((a, b) => a[3] - b[3]);
  let drags = 0;
  let pauses = 0;
  let reversals = 0;
  const moves = [];
  let current = [];
  for (const event of clean) {
    const [type, x, y, t] = event;
    if (type === "down") {
      if (current.length) moves.push(current);
      current = [[x, y, t]];
      drags += 1;
    } else if (type === "move" && current.length) {
      const last = current[current.length - 1];
      const dx = x - last[0];
      const dy = y - last[1];
      if (dx * dx + dy * dy >= 1) {
        if (t - last[2] > 120) pauses += 1;
        if (current.length >= 2) {
          const prev = current[current.length - 2];
          if ((last[0] - prev[0]) * dx + (last[1] - prev[1]) * dy < 0) reversals += 1;
        }
        current.push([x, y, t]);
      }
    } else if (type === "up" && current.length) {
      current.push([x, y, t]);
      moves.push(current);
      current = [];
    }
  }
  if (current.length) moves.push(current);
  if (drags === 0 || !moves.length) return { score: 0, straight_robotic: 0 };
  const speeds = [];
  const nonlinearities = [];
  for (const samples of moves) {
    if (samples.length < 2) continue;
    let length = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const dx = samples[i][0] - samples[i - 1][0];
      const dy = samples[i][1] - samples[i - 1][1];
      const dt = Math.max(1, samples[i][2] - samples[i - 1][2]);
      const dist = Math.hypot(dx, dy);
      length += dist;
      speeds.push(dist / dt);
    }
    const straight = Math.max(1, Math.hypot(samples.at(-1)[0] - samples[0][0], samples.at(-1)[1] - samples[0][1]));
    nonlinearities.push(length / straight);
  }
  if (!speeds.length) return { score: 0, straight_robotic: 0 };
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const variance = speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const nl = nonlinearities.length ? nonlinearities.reduce((a, b) => a + b, 0) / nonlinearities.length : 1;
  const span = Math.max(0, clean.at(-1)[3] - clean[0][3]) / 1000;
  const f1 = Math.min(1, Math.max(0, (nl - 1) / 0.25));
  const f2 = Math.min(1, cv / 0.55);
  const f3 = Math.min(1, pauses / 2);
  const f4 = Math.min(1, reversals / 3);
  const f5 = 0.45 <= span && span <= 90 ? 1 : 0;
  const f6 = Math.min(1, drags / 2);
  const f7 = Math.min(1, clean.length / 28);
  const straightRobot = nl < 1.25 && pauses === 0 && reversals === 0;
  let score = Math.max(0, Math.min(1, 0.2 * f1 + 0.2 * f2 + 0.1 * f3 + 0.1 * f4 + 0.2 * f5 + 0.1 * f6 + 0.1 * f7));
  // Near-linear trajectories (even with small wobble that flips straight_robotic off via the
  // old nl<1.01 test) must stay below the soft-human threshold so they cannot pair with a
  // valid interaction to bypass. Cap below SOFT_BEHAVIOR_PASS_THRESHOLD.
  if (straightRobot) score = Math.min(score, 0.24);
  return { score, straight_robotic: straightRobot ? 1 : 0 };
}

function interactionMatchesMapping(challenge, mapping, events) {
  const core = coreInteractionEvents(events);
  if (!validMapping(mapping) || core === null) return false;
  const tileToSlot = new Map();
  const slotToTile = new Map();
  const issued = new Set();
  for (let id = 0; id < M; id += 1) {
    issued.add(id);
    const slot = challenge.start_slots[id];
    tileToSlot.set(id, slot);
    slotToTile.set(slot, id);
  }
  let active = null;
  let swaps = 0;
  const ordered = core.map((item, index) => [eventNumber(item, "t"), index, item]);
  if (ordered.some((row) => row[0] === null)) return false;
  ordered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, , item] of ordered) {
    if (item.type === "down") {
      if (active) return false;
      const tile_id = eventInt(item, "tile_id");
      const from_slot = eventInt(item, "from_slot");
      const dx = eventNumber(item, "x");
      const dy = eventNumber(item, "y");
      if (tile_id === null || !issued.has(tile_id) || from_slot === null || tileToSlot.get(tile_id) !== from_slot) return false;
      if (dx === null || dy === null) return false;
      // Patent: the grab point must land inside (or within a 4px slack of) the source slot rectangle.
      const pos = slotPosition(from_slot);
      if (!(pos.x - 4 <= dx && dx <= pos.x + TILE + 4 && pos.y - 4 <= dy && dy <= pos.y + TILE + 4)) return false;
      active = { tile_id, moves: 0, grab_x: dx - pos.x, grab_y: dy - pos.y };
    } else if (item.type === "move") {
      if (active) active.moves += 1;
    } else if (item.type === "swap") {
      if (!active || active.moves < 1) return false;
      const tile_id = eventInt(item, "tile_id");
      const from_slot = eventInt(item, "from_slot");
      const to_slot = eventInt(item, "to_slot");
      const sx = eventNumber(item, "x");
      const sy = eventNumber(item, "y");
      if (tile_id !== active.tile_id || from_slot === null || to_slot === null || tileToSlot.get(tile_id) !== from_slot) return false;
      if (sx === null || sy === null) return false;
      // Patent: drag center must be within TILE*0.82 of the target slot center.
      const center_x = sx - active.grab_x + TILE / 2;
      const center_y = sy - active.grab_y + TILE / 2;
      const target = slotPosition(to_slot);
      const targetCx = target.x + TILE / 2;
      const targetCy = target.y + TILE / 2;
      if (Math.hypot(center_x - targetCx, center_y - targetCy) > TILE * 0.82) return false;
      const other = slotToTile.get(to_slot);
      if (other === undefined || other === tile_id) return false;
      tileToSlot.set(tile_id, to_slot);
      tileToSlot.set(other, from_slot);
      slotToTile.set(to_slot, tile_id);
      slotToTile.set(from_slot, other);
      swaps += 1;
    } else if (item.type === "up") {
      if (!active || eventInt(item, "tile_id") !== active.tile_id) return false;
      active = null;
    } else {
      return false;
    }
  }
  if (active || swaps === 0) return false;
  return [...Array(M).keys()].every((id) => tileToSlot.get(id) === mapping[id]);
}

function hasBoundInteractionEvents(challenge, events) {
  const core = coreInteractionEvents(events);
  if (core === null) return false;
  let sawDown = false;
  let sawSwap = false;
  let sawUp = false;
  for (const item of core) {
    if (!["down", "move", "swap", "up"].includes(item.type) || eventNumber(item, "t") === null) return false;
    if (item.type === "move") continue;
    const tileId = eventInt(item, "tile_id");
    if (tileId === null || tileId >= M) return false;
    if (item.type === "down") sawDown = true;
    if (item.type === "swap") {
      const fromSlot = eventInt(item, "from_slot");
      const toSlot = eventInt(item, "to_slot");
      if (fromSlot === null || toSlot === null || fromSlot === toSlot || toSlot >= M) return false;
      sawSwap = true;
    }
    if (item.type === "up") sawUp = true;
  }
  return sawDown && sawSwap && sawUp;
}

export async function verifyChallenge(req, payload) {
  const challengeId = String(payload?.challenge_id || "");
  const mapping = payload?.mapping;
  const events = payload?.events;

  let challenge = await getChallenge(challengeId);
  if (!challenge) challenge = decryptState(challengeId);
  if (!challenge || challenge.used || challenge.locked || nowSeconds() > challenge.expires_at) {
    return { status: challenge ? 400 : 404, body: publicFailure("challenge_unavailable") };
  }
  if (!validMapping(mapping)) return { status: 400, body: publicFailure("verification_failed") };

  // Read the canonical stored blob to use as the CAS guard. Prefer Redis raw; fall back
  // to a deterministic serialization of the in-memory/decrypted state.
  const prevRaw = (await getChallengeRaw(challengeId)) || serializeChallenge(challenge);

  // Pure evaluation against a snapshot — no store writes happen here.
  const behavior = scoreBehavior(events);
  const exact = mapping.every((slot, id) => slot === challenge.answer[id]);
  const interaction = interactionMatchesMapping(challenge, mapping, events);
  const boundInteraction = interaction || hasBoundInteractionEvents(challenge, events);
  const manualVerify = hasManualVerifyIntent(events);
  const sessionOk = Boolean(challenge.session_id) && challenge.session_id === currentSession(req);
  const strongHuman = behavior.score >= BEHAVIOR_PASS_THRESHOLD;
  const softHuman = behavior.score >= SOFT_BEHAVIOR_PASS_THRESHOLD && !behavior.straight_robotic;
  const human = Boolean(manualVerify && sessionOk && boundInteraction && (strongHuman || (interaction && softHuman)));
  const passed = Boolean(exact && human);

  challenge.attempts = (challenge.attempts || 0) + 1;
  // Preserve the original demo semantics: a locked challenge returns 429 only on the
  // attempt AFTER the limit is hit (attempts > limit), so the first failed attempt on
  // a fresh challenge still returns 200. Locking still happens at attempts >= limit.
  const wasLocked = Boolean(challenge.locked);
  if (!passed) {
    challenge.failures = (challenge.failures || 0) + 1;
    if (challenge.failures >= MAX_FAILURES_PER_CHALLENGE || challenge.attempts >= MAX_VERIFY_ATTEMPTS_PER_CHALLENGE) {
      challenge.locked = true;
    }
  } else {
    challenge.used = true;
  }
  const ttlSeconds = Math.max(1, Math.floor(challenge.expires_at - nowSeconds()));

  const outcome = await commitVerify({
    challengeId,
    prevRaw,
    newState: challenge,
    passed,
    ttlSeconds
  });

  if (outcome === "missing") return { status: 404, body: publicFailure("challenge_unavailable") };
  // Concurrent verify raced us: surface a neutral failure without revealing internal state.
  if (outcome === "conflict") return { status: 200, body: publicFailure("verification_failed") };
  if (outcome === "passed") return { status: 200, body: { pass: true } };
  // outcome === "failed"
  if (wasLocked && challenge.attempts > MAX_VERIFY_ATTEMPTS_PER_CHALLENGE) {
    return { status: 429, body: publicFailure("too_many_attempts") };
  }
  return { status: 200, body: publicFailure("verification_failed") };
}

// Lightweight audit log: one JSON line per event on stdout, which Vercel ingests.
// Never includes mapping/events payloads or internal scores — only categorical facts.
export function auditEvent(req, event, fields = {}) {
  try {
    const record = {
      ts: Number(nowSeconds().toFixed(3)),
      event,
      ip: clientIp(req),
      path: req.url ? new URL(req.url, "http://localhost").pathname : "",
      ...fields
    };
    console.info(JSON.stringify(record));
  } catch {
    // Audit must never break a request.
  }
}

// Exposed for tests only — not part of the public API.
export const __test__ = { interactionMatchesMapping };

export function buildSecurityHeaders() {
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'"
  };
}
