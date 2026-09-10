/**
 * Shared live-server connection for scripts/.
 *
 * Centralises the three things every script needs: credentials, a configured
 * HTTP client, and the resolved shard. Keeping it in one place means the
 * shard-detection rule and the `server.url` contract are stated once.
 */
import { ScreepsHttpClient } from 'screeps-api';
import { connection } from './env.mjs';
import { resolveShard } from './shard.mjs';

const SCREEPS_URL = 'https://screeps.com';

/**
 * Connect to the official server.
 *
 * @param {'deploy'|'watch'} role which token to use
 * @returns {Promise<{api: ScreepsHttpClient, shard: string, shardSource: string, branch: string, warning?: string}>}
 */
export async function connect(role) {
  const { server, shard, branch, token } = connection(role);

  // Built by hand rather than via `fromConfig`, which requires a screeps config
  // file on disk. The client keys off `server.url`, so it must be a full URL.
  const api = new ScreepsHttpClient({
    server: { url: SCREEPS_URL, token },
    // `defaultShard` is intentionally left unset: v2 throws when a shard is
    // required but absent, which is what we want — every shard-scoped call
    // below passes the resolved shard explicitly.
    app: {},
  });

  const resolved = await resolveShard(api, shard);

  return {
    api,
    shard: resolved.shard,
    shardSource: resolved.source,
    branch,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    server,
  };
}

export { SCREEPS_URL };
