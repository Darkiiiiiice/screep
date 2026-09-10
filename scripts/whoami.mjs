/**
 * Probe the live server: identity, assigned shard, and CPU headroom.
 *
 * This is the P0 connectivity check. It answers the questions the rest of the
 * tooling depends on:
 *   - is the token valid, and which account does it belong to?
 *   - which shard is this account actually on? (never assume shard0)
 *   - is the account's CPU unlocked? (decides how much room the AI has)
 *
 * Usage: npm run whoami
 */
import { connect } from './lib/client.mjs';
import { detectShardCandidates } from './lib/shard.mjs';

const { api, shard, shardSource, branch, warning } = await connect('deploy');

const me = await api.authMe();
console.log(`${'account'.padEnd(18)} ${me.username} <${me.email ?? 'n/a'}>`);
console.log(`${'user id'.padEnd(18)} ${me._id}`);

const { candidates, source } = await detectShardCandidates(api);
console.log(`${'shard'.padEnd(18)} ${shard}  (via ${shardSource})`);
console.log(`${'candidates'.padEnd(18)} ${candidates.join(', ') || '(none)'}  [${source}]`);
console.log(`${'branch'.padEnd(18)} ${branch}`);

// CPU limit is the binding constraint on everything the AI can do per tick. An
// un-unlocked account is fixed at 20 ms no matter how high GCL climbs.
const info = await api.gameShardsInfo();
const mine = (info?.shards ?? []).find((s) => s.name === shard);
const cpuLimit = mine?.cpuLimit ?? 0;
console.log(
  `${'cpu limit'.padEnd(18)} ${cpuLimit || 'unknown'}${cpuLimit === 20 ? '  (un-unlocked default — CPU Unlock raises it by +10/GCL, max 300)' : cpuLimit > 20 ? '  (CPU unlocked)' : ''}`,
);

const world = await api.userWorldStatus();
console.log(`${'world status'.padEnd(18)} ${world?.status ?? JSON.stringify(world)}`);

const overview = await api.userOverview();
const rooms = overview?.shards?.[shard]?.rooms ?? [];
console.log(`${'rooms on shard'.padEnd(18)} ${rooms.length}`);

if (warning) {
  console.log('');
  console.log(`WARNING: ${warning}`);
}

if (world?.status === 'empty') {
  console.log('');
  console.log('NOTE: world status is "empty" — no spawn placed on this shard yet.');
  console.log('      Place your first spawn in-game before expecting the AI to do anything:');
  const start = await api.userWorldStartRoom(shard).catch(() => null);
  if (Array.isArray(start?.room) && start.room.length > 0) {
    console.log(`      candidate start rooms: ${start.room.join(', ')}`);
  }
}
