import { REDIS_PREFIX } from "./config.mjs";

const memory = new Map();
const counters = new Map();

function nowMs() {
  return Date.now();
}

function prune() {
  const now = nowMs();
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
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

export function storageMode() {
  return redisConfig().enabled ? "redis-rest" : "memory";
}

export function clearMemoryStoreForTests() {
  memory.clear();
  counters.clear();
}
