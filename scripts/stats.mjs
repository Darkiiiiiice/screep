/**
 * Pull the stats segment and append a row to docs/live-metrics.md.
 *
 * Stats live in a RawMemory segment rather than in `Memory` for a rate-limit
 * reason: `GET /api/user/memory-segment` allows 360/hour, while
 * `GET /api/user/memory` allows only 1440/day (1/minute). Same information,
 * 6x the observation bandwidth.
 *
 * The segment id must match the in-game writer (src/kernel/stats.ts).
 *
 * Usage:
 *   node scripts/stats.mjs [--segment N] [--once]
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from './lib/client.mjs';
import { checkQuota, record } from './lib/quota-ledger.mjs';

/** Must match STATS_SEGMENT in src/kernel/stats.ts. */
const DEFAULT_SEGMENT = 90;

const args = process.argv.slice(2);
const segFlag = args.indexOf('--segment');
const segment = segFlag !== -1 ? Number(args[segFlag + 1]) : DEFAULT_SEGMENT;

const { api, shard, shardSource } = await connect('deploy');

const quota = checkQuota('GET', '/api/user/memory-segment');
if (!quota.allowed) {
  console.error(`[stats] blocked: ${quota.reason}; resets in ${Math.ceil(quota.resetsInMs / 1000)}s`);
  process.exit(1);
}

const res = await api.userMemorySegmentGet(segment, shard);
record('GET', '/api/user/memory-segment', { note: `segment=${segment}` });

const raw = res?.data;
if (!raw) {
  console.log(`[stats] segment ${segment} on ${shard} (${shardSource}) is empty.`);
  console.log('[stats] expected until the AI is deployed and its first tick writes stats.');
  process.exit(0);
}

let stats;
try {
  stats = JSON.parse(raw);
} catch {
  console.log(`[stats] segment ${segment} is not JSON (${raw.length} bytes):`);
  console.log(raw.slice(0, 500));
  process.exit(0);
}

console.log(`[stats] shard ${shard} (${shardSource}), segment ${segment}`);
console.log(JSON.stringify(stats, null, 2));

// Append a trend row so the metric history survives outside the game.
const docsDir = resolve(process.cwd(), 'docs');
mkdirSync(docsDir, { recursive: true });
const metricsFile = resolve(docsDir, 'live-metrics.md');

if (!existsSync(metricsFile)) {
  writeFileSync(
    metricsFile,
    '# 线上指标曲线\n\n由 `npm run stats` 追加。每行一次采样。\n\n| 时间 | shard | gameTime | CPU 已用 | CPU 上限 | creep | RCL | Memory 字节 |\n|---|---|---|---|---|---|---|---|\n',
  );
}

const row = [
  new Date().toISOString(),
  shard,
  stats.gameTime ?? '?',
  stats.cpu?.used ?? '?',
  stats.cpu?.limit ?? '?',
  stats.creeps ?? '?',
  stats.rcl ?? '?',
  stats.memoryBytes ?? '?',
]
  .map((v) => String(v))
  .join(' | ');

appendFileSync(metricsFile, `| ${row} |\n`);
console.log(`[stats] appended to ${metricsFile}`);
