import { REDIS_PREFIX } from "./config.mjs";

const memory = new Map();
const counters = new Map();
const memoryLocks = new Map();

function nowMs() {
  return Date.now();
}

function prune() {
  const now = nowMs();
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}

// Stable field ordering so a read-then-compare against a re-serialized state matches byte-for-byte.
const CHALLENGE_FIELDS = [
  "v", "glyph", "seed", "phase", "answer", "start_slots", "session_id",
  "created_at", "expires_at", "failures", "attempts", "used", "locked",
  "challenge_id"
];

export function serializeChallenge(state) {
  const ordered = {};
  for (const key of CHALLENGE_FIELDS) if (key in state) ordered[key] = state[key];
  for (const key of Object.keys(state)) if (!(key in ordered)) ordered[key] = state[key];
  return JSON.stringify(ordered);
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return { url, token, enabled: Boolean(url && token) };
}

async function redisCommand(command) {
  const { url, token, enabled } = redisConfig();
  if (!enabled) return null;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`Redis REST failed: ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

function key(challengeId) {
  return `${REDIS_PREFIX}:challenge:${challengeId}`;
}

export async function saveChallenge(challenge, ttlSeconds) {
  const payload = JSON.stringify(challenge);
  const stored = await redisCommand(["SET", key(challenge.challenge_id), payload, "EX", ttlSeconds]);
  if (stored !== null) return;
  prune();
  memory.set(key(challenge.challenge_id), {
    value: payload,
    expiresAt: nowMs() + ttlSeconds * 1000
  });
}

export async function getChallenge(challengeId) {
  const redisValue = await redisCommand(["GET", key(challengeId)]);
  if (redisValue !== null) return redisValue ? JSON.parse(redisValue) : null;
  prune();
  const entry = memory.get(key(challengeId));
  return entry ? JSON.parse(entry.value) : null;
}

export async function deleteChallenge(challengeId) {
  const deleted = await redisCommand(["DEL", key(challengeId)]);
  if (deleted !== null) return;
  memory.delete(key(challengeId));
}

export async function incrWithTtl(counterKey, ttlSeconds) {
  const redisValue = await redisCommand(["INCR", `${REDIS_PREFIX}:rate:${counterKey}`]);
  if (redisValue !== null) {
    await redisCommand(["EXPIRE", `${REDIS_PREFIX}:rate:${counterKey}`, ttlSeconds]);
    return Number(redisValue);
  }
  prune();
  const keyName = `${REDIS_PREFIX}:rate:${counterKey}`;
  const entry = counters.get(keyName);
  if (!entry || entry.expiresAt <= nowMs()) {
    counters.set(keyName, { value: 1, expiresAt: nowMs() + ttlSeconds * 1000 });
    return 1;
  }
  entry.value += 1;
  return entry.value;
}

export async function replaceChallenge(challenge, ttlSeconds) {
  await saveChallenge(challenge, ttlSeconds);
}

export async function getChallengeRaw(challengeId) {
  const redisValue = await redisCommand(["GET", key(challengeId)]);
  if (redisValue !== null) return redisValue;
  prune();
  const entry = memory.get(key(challengeId));
  return entry ? entry.value : null;
}

// Atomically consume a verify attempt under compare-and-set semantics, matching the
// patent's Redis WATCH/pipeline guarantee. Returns one of:
//   "missing"  - challenge not found
//   "conflict" - state changed between read and commit (concurrent verify)
//   "passed"   - challenge marked used/consumed atomically
//   "failed"   - updated state persisted (failures/attempts bumped, possibly locked)
// On Redis the CAS is a single EVAL; on memory it is serialized via a per-key mutex
// (Node is single-threaded but await boundaries yield, so the mutex is still required).
export async function commitVerify({ challengeId, prevRaw, newState, passed, ttlSeconds }) {
  const k = key(challengeId);
  const { enabled } = redisConfig();

  if (enabled) {
    const payload = serializeChallenge(newState);
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    // KEYS[1]=challenge key  ARGV: prevRaw, passedFlag(1/0), ttl, payload
    const script = [
      "local cur = redis.call('GET', KEYS[1])",
      "if cur == false then return 'missing' end",
      "if cur ~= ARGV[1] then return 'conflict' end",
      "if ARGV[2] == '1' then",
      "  redis.call('DEL', KEYS[1])",
      "  return 'passed'",
      "end",
      "redis.call('SET', KEYS[1], ARGV[4], 'EX', tonumber(ARGV[3]))",
      "return 'failed'"
    ].join("\n");
    return redisCommand(["EVAL", script, 1, k, prevRaw, passed ? "1" : "0", String(ttl), payload]);
  }

  // Memory mode: serialize concurrent commits on the same key.
  let promise = memoryLocks.get(k);
  while (promise) {
    await promise;
    promise = memoryLocks.get(k);
  }
  let resolveLock;
  memoryLocks.set(k, new Promise((resolve) => { resolveLock = resolve; }));
  try {
    prune();
    const entry = memory.get(k);
    if (!entry) return "missing";
    if (entry.value !== prevRaw) return "conflict";
    if (passed) {
      memory.delete(k);
      return "passed";
    }
    entry.value = serializeChallenge(newState);
    entry.expiresAt = nowMs() + Math.max(1, Math.floor(ttlSeconds)) * 1000;
    return "failed";
  } finally {
    memoryLocks.delete(k);
    resolveLock();
  }
}

export function storageMode() {
  return redisConfig().enabled ? "redis-rest" : "memory";
}

export function clearMemoryStoreForTests() {
  memory.clear();
  counters.clear();
  memoryLocks.clear();
}
