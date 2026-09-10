/**
 * Screeps official-server API quota table.
 *
 * Source: https://docs.screeps.com/auth-tokens.html#Rate-Limiting
 *
 * Requests authenticated with an auth token are rate limited; the browser and
 * Steam clients are not. Every outbound HTTP call in scripts/ must go through
 * the accounting wrapper in ./quota.mjs so we never discover a limit by
 * spending it.
 */

/** @typedef {{ limit: number, windowMs: number }} QuotaRule */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Global limit applied to every request. */
export const GLOBAL = { limit: 120, windowMs: MINUTE };

/**
 * Per-endpoint limits, keyed by `METHOD /api/path`.
 *
 * Note the two entries that actually govern iteration speed:
 *   - `user/code`         240/day -> the deploy budget (avg 1 per 6 minutes)
 *   - `memory-segment GET` 360/hour -> 6x more headroom than `memory GET`
 *     (1440/day = 1/min), which is why stats ship in a segment, not in Memory.
 */
export const ENDPOINT = {
  'GET /api/game/room-terrain': { limit: 360, windowMs: HOUR },
  'POST /api/game/map-stats': { limit: 60, windowMs: HOUR },
  'GET /api/user/code': { limit: 60, windowMs: HOUR },
  'POST /api/user/code': { limit: 240, windowMs: DAY },
  'POST /api/user/set-active-branch': { limit: 240, windowMs: DAY },
  'GET /api/user/memory': { limit: 1440, windowMs: DAY },
  'POST /api/user/memory': { limit: 240, windowMs: DAY },
  'GET /api/user/memory-segment': { limit: 360, windowMs: HOUR },
  'POST /api/user/memory-segment': { limit: 60, windowMs: HOUR },
  'POST /api/user/console': { limit: 360, windowMs: HOUR },
  'GET /api/game/market/orders-index': { limit: 60, windowMs: HOUR },
  'GET /api/game/market/orders': { limit: 60, windowMs: HOUR },
  'GET /api/game/market/my-orders': { limit: 60, windowMs: HOUR },
  'GET /api/game/market/stats': { limit: 60, windowMs: HOUR },
  'GET /api/game/user/money-history': { limit: 60, windowMs: HOUR },
};

/**
 * Local self-imposed ceiling for deploys.
 *
 * The server allows 240 code POSTs/day. We deliberately cap far below that so a
 * bad afternoon cannot exhaust the budget needed to fix a live incident.
 */
export const DEPLOY_DAILY_CAP = 60;

/** Cost of a full "deploy -> activate -> roll back" cycle, in requests. */
export const FULL_CYCLE_COST = 4;

/**
 * WebSocket events are not covered by the HTTP rate limit table above, but the
 * token must be granted the corresponding events when it is created. Console
 * streaming is therefore our default observation channel.
 */
export const WEBSOCKET_EVENTS = ['console', 'memory/stats'];

/** Resolve the quota rule for a request, or null when the endpoint is unlimited. */
export function ruleFor(method, path) {
  const key = `${method.toUpperCase()} ${path}`;
  return ENDPOINT[key] ?? null;
}

export const WINDOWS = { MINUTE, HOUR, DAY };
