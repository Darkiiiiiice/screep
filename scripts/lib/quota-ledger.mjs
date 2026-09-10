/**
 * Persistent quota ledger for token-authenticated Screeps API calls.
 *
 * The server returns X-RateLimit-Limit / -Remaining / -Reset headers, but only
 * once you are close to (or over) a limit. We keep our own append-only ledger so
 * `npm run deploy` can refuse *before* spending the last of a daily budget, and
 * so a session can report how many deploys it has left.
 *
 * Ledger lives at .screeps-quota.jsonl (gitignored) — one JSON object per line.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GLOBAL, WINDOWS, ruleFor } from './quotas.mjs';

const LEDGER_PATH = resolve(process.cwd(), '.screeps-quota.jsonl');

function readEntries() {
  if (!existsSync(LEDGER_PATH)) return [];
  const lines = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line (killed mid-write) should not poison the ledger.
    }
  }
  return entries;
}

/** Count ledger entries matching `method path` within the trailing window. */
export function usedInWindow(method, path, windowMs, now = Date.now()) {
  const since = now - windowMs;
  const key = `${method.toUpperCase()} ${path}`;
  return readEntries().filter((e) => e.key === key && e.at >= since).length;
}

/**
 * Dry-run a request against every applicable limit.
 *
 * @returns {{ allowed: boolean, reason?: string, used: number, limit: number, resetsInMs: number }}
 */
export function checkQuota(method, path, now = Date.now()) {
  const globalUsed = readEntries().filter((e) => e.at >= now - GLOBAL.windowMs).length;
  if (globalUsed >= GLOBAL.limit) {
    return {
      allowed: false,
      reason: 'global rate limit (120/min) reached',
      used: globalUsed,
      limit: GLOBAL.limit,
      resetsInMs: GLOBAL.windowMs,
    };
  }

  const rule = ruleFor(method, path);
  if (!rule) {
    return { allowed: true, used: globalUsed, limit: GLOBAL.limit, resetsInMs: 0 };
  }

  const used = usedInWindow(method, path, rule.windowMs, now);
  if (used >= rule.limit) {
    const oldest = readEntries()
      .filter((e) => e.key === `${method.toUpperCase()} ${path}`)
      .sort((a, b) => a.at - b.at)[0];
    const resetsInMs = oldest ? oldest.at + rule.windowMs - now : rule.windowMs;
    return {
      allowed: false,
      reason: `${method.toUpperCase()} ${path} limit ${rule.limit}/${formatWindow(rule.windowMs)} reached`,
      used,
      limit: rule.limit,
      resetsInMs,
    };
  }

  return {
    allowed: true,
    used,
    limit: rule.limit,
    resetsInMs: 0,
  };
}

/** Record a request that was actually sent (or is about to be). */
export function record(method, path, { status = null, note = null } = {}) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const entry = {
    at: Date.now(),
    key: `${method.toUpperCase()} ${path}`,
    status,
    note,
  };
  appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Human-readable remaining budget for a method+path. */
export function remaining(method, path, now = Date.now()) {
  const rule = ruleFor(method, path);
  if (!rule) return null;
  return rule.limit - usedInWindow(method, path, rule.windowMs, now);
}

/** Summarise today's deploys, for the M0 acceptance check. */
export function deployBudget(now = Date.now()) {
  const used = usedInWindow('POST', '/api/user/code', WINDOWS.DAY, now);
  return { used, limit: 240, remaining: 240 - used };
}

export function formatWindow(ms) {
  if (ms >= WINDOWS.DAY) return 'day';
  if (ms >= WINDOWS.HOUR) return 'hour';
  return `${ms / WINDOWS.MINUTE}min`;
}

export { LEDGER_PATH };
