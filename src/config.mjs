export const N = 3;
export const M = N * N;
export const TILE = 128;
export const GAP = 10;
export const BOARD = N * TILE;
export const W = 440;
export const START = Math.floor((W - (N * TILE + (N - 1) * GAP)) / 2);
export const TTL_SECONDS = 180;
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMITS = { challenge: 30, verify: 90 };
export const MAX_EVENTS = 1200;
export const MAX_VERIFY_ATTEMPTS_PER_CHALLENGE = 1;
export const MAX_FAILURES_PER_CHALLENGE = 3;
export const BEHAVIOR_PASS_THRESHOLD = 0.42;
export const SOFT_BEHAVIOR_PASS_THRESHOLD = 0.34;
export const REDIS_PREFIX = "fluxwebdemo";
export const GLYPHS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const DEFAULT_SECRET =
  process.env.FLUX_SECRET || "dev-only-change-me-before-production";

export function apiUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
}

export function apiToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
}
