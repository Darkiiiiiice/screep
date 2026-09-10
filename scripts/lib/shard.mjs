/**
 * Shard detection.
 *
 * Never assume `shard0`. A new account is assigned to a specific shard (shard3
 * for this one), and the seasonal/novice shards move. Every shard-scoped API
 * call needs the right value or it silently queries the wrong world.
 *
 * Two independent server signals identify the account's shard, and they agree:
 *
 *   1. `gameShardsInfo()` — the shard the account is on reports its real CPU
 *      limit (`cpuLimit: 20`, the un-unlocked default); shards the account is
 *      not on report `cpuLimit: 0`. One request, so this is the primary probe.
 *
 *   2. `userWorldStartRoom(shard)` — returns candidate spawn rooms only for the
 *      assigned shard (`["W55S5","W15N45","W35S5"]`), and an empty array
 *      elsewhere. Used as a cross-check / fallback.
 *
 * NOT usable: `userOverview()`. It lists every shard with `rooms: []` even for
 * an account that has never spawned, so it cannot distinguish assigned from
 * unassigned.
 */

/** Shard names to probe when the server does not enumerate them. */
const FALLBACK_SHARDS = ['shard0', 'shard1', 'shard2', 'shard3'];

/**
 * Shards where the account has a non-zero CPU limit, i.e. shards it is on.
 *
 * @returns {Promise<string[]>} shard names, possibly empty
 */
export async function shardsWithCpu(api) {
  const info = await api.gameShardsInfo();
  const shards = info?.shards;
  if (!Array.isArray(shards)) return [];

  return shards
    .filter((s) => typeof s?.name === 'string' && (s.cpuLimit ?? 0) > 0)
    .map((s) => s.name);
}

/**
 * Shards offering this account a start room, i.e. shards it may spawn into.
 *
 * @returns {Promise<string[]>} shard names, possibly empty
 */
export async function shardsWithStartRoom(api) {
  const found = [];
  for (const name of FALLBACK_SHARDS) {
    try {
      const res = await api.userWorldStartRoom(name);
      if (Array.isArray(res?.room) && res.room.length > 0) found.push(name);
    } catch {
      // A shard that rejects the query is simply not ours; keep probing.
    }
  }
  return found;
}

/**
 * Candidate shards for this account, most trustworthy source first.
 *
 * @returns {Promise<{candidates: string[], source: string}>}
 */
export async function detectShardCandidates(api) {
  const byCpu = await shardsWithCpu(api);
  if (byCpu.length > 0) return { candidates: byCpu, source: 'cpuLimit' };

  const byRoom = await shardsWithStartRoom(api);
  return { candidates: byRoom, source: 'worldStartRoom' };
}

/**
 * Resolve the shard to operate on.
 *
 * An explicit `SCREEPS_SHARD` wins, but a disagreement is reported rather than
 * silently honoured — a stale value in .env is exactly the failure this guards.
 *
 * @param {object} api authenticated client
 * @param {string|undefined} override value from the environment
 * @returns {Promise<{shard: string, source: string, warning?: string}>}
 */
export async function resolveShard(api, override) {
  const explicit = override && override !== 'auto' ? override : undefined;
  const { candidates, source } = await detectShardCandidates(api);

  if (candidates.length === 0) {
    if (explicit) return { shard: explicit, source: 'env (unverified)' };
    throw new Error(
      'Could not determine the account shard: no shard reports a CPU limit or a start room. Set SCREEPS_SHARD explicitly.',
    );
  }

  if (explicit) {
    if (!candidates.includes(explicit)) {
      return {
        shard: explicit,
        source: 'env',
        warning: `SCREEPS_SHARD=${explicit} but the account is on ${candidates.join('/')} (per ${source})`,
      };
    }
    return { shard: explicit, source: 'env' };
  }

  return { shard: candidates[0], source };
}
