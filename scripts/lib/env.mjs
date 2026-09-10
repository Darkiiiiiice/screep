/**
 * Credential loading for scripts/.
 *
 * Uses Node's built-in env-file loader (available since 20.12) rather than a
 * dotenv dependency.
 *
 * Two tokens are used, deliberately split by privilege:
 *   SCREEPS_TOKEN_DEPLOY  — needs the `user/code` endpoint to push code.
 *   SCREEPS_TOKEN_WATCH   — needs websocket console events; used for streaming.
 *
 * Splitting them narrows the blast radius of a leak and makes it obvious which
 * workload is consuming which rate limit.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve(process.cwd(), '.env');

export function loadEnv() {
  if (existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
  }
}

/**
 * Resolve connection settings.
 *
 * @param {'deploy'|'watch'} role which token to use
 */
export function connection(role) {
  loadEnv();

  const token =
    role === 'deploy'
      ? process.env.SCREEPS_TOKEN_DEPLOY
      : process.env.SCREEPS_TOKEN_WATCH;

  const missing =
    role === 'deploy' ? 'SCREEPS_TOKEN_DEPLOY' : 'SCREEPS_TOKEN_WATCH';
  if (!token) {
    throw new Error(
      `${missing} is not set. Add it to .env (see .env.example) — generate one at https://screeps.com/a/#!/account/auth-tokens`,
    );
  }

  return {
    server: process.env.SCREEPS_SERVER ?? 'main',
    // Left undefined when unset so shard detection runs; a hardcoded 'shard0'
    // default would masquerade as an explicit choice and never self-correct.
    shard: process.env.SCREEPS_SHARD,
    branch: process.env.SCREEPS_BRANCH ?? 'default',
    token,
  };
}
