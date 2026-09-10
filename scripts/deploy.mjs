/**
 * Deploy the built bundle to the official server.
 *
 * Deploying is a metered operation: `POST /api/user/code` allows 240/day, i.e.
 * one deploy per six minutes on average. So this script refuses to spend the
 * budget on obviously-bad input (missing build, oversize module set) and caps
 * itself well below the server limit.
 *
 * Usage:
 *   node scripts/deploy.mjs [--dry-run] [--branch <name>]
 *
 *   --dry-run  build + validate + report quota, upload nothing
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from './lib/client.mjs';
import { checkQuota, record, deployBudget } from './lib/quota-ledger.mjs';
import { DEPLOY_DAILY_CAP } from './lib/quotas.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const branchFlag = args.indexOf('--branch');

const BUNDLE = resolve(process.cwd(), 'dist/main.js');

if (!existsSync(BUNDLE)) {
  console.error('[deploy] dist/main.js missing — run `npm run build` first.');
  process.exit(1);
}

const code = readFileSync(BUNDLE, 'utf8');
const bytes = statSync(BUNDLE).size;

// Screeps loads each module through a `require`-like loader. A single bundled
// module is the shape we rely on; the name must be `main` because the engine
// boots `main.loop`.
if (bytes > 5 * 1024 * 1024) {
  console.error(`[deploy] bundle is ${(bytes / 1024).toFixed(0)} KiB — too large to upload safely.`);
  process.exit(1);
}

const { api, shard, branch: envBranch, shardSource } = await connect('deploy');
const branch = branchFlag !== -1 ? args[branchFlag + 1] : envBranch;

// Refuse before spending: check both the server's daily limit and our own cap.
const quota = checkQuota('POST', '/api/user/code');
const budget = deployBudget();

console.log(`[deploy] shard      ${shard} (${shardSource})`);
console.log(`[deploy] branch     ${branch}`);
console.log(`[deploy] bundle     ${(bytes / 1024).toFixed(1)} KiB`);
console.log(
  `[deploy] quota      ${budget.used}/${budget.limit} today, self-cap ${DEPLOY_DAILY_CAP}`,
);

if (!quota.allowed) {
  console.error(`[deploy] blocked: ${quota.reason}; resets in ${Math.ceil(quota.resetsInMs / 1000)}s`);
  process.exit(1);
}

if (budget.used >= DEPLOY_DAILY_CAP) {
  console.error(
    `[deploy] blocked: self-imposed cap of ${DEPLOY_DAILY_CAP}/day reached (server allows ${budget.limit}).`,
  );
  console.error('[deploy] raise DEPLOY_DAILY_CAP only if you are sure, or use the 2h no-rate-limit token window.');
  process.exit(1);
}

if (dryRun) {
  console.log('[deploy] dry run — nothing uploaded.');
  process.exit(0);
}

const result = await api.userCodeSet({ branch, modules: { main: code } });
record('POST', '/api/user/code', { status: result?.ok ?? null, note: `branch=${branch}` });

const after = deployBudget();
console.log(`[deploy] uploaded to branch '${branch}'`);
console.log(`[deploy] quota now  ${after.used}/${after.limit} today (${after.remaining} left)`);
console.log(
  '[deploy] note: this uploads to the branch but does not activate it. If this is not the active branch, activate it in the client UI or via setActiveBranch.',
);
