import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './lib/client.mjs';

try {
  const { api, shard } = await connect('deploy');
  const branches = await api.userBranches();
  const branch = branches.list.find(b => b.activeWorld)?.branch;
  if (!branch) throw new Error('No active World branch');
  const code = await api.userCodeGet(branch);
  if (!code.modules?.main) throw new Error('Missing rollback main module');
  const memory = await api.userMemoryGet(undefined, shard);
  const room = await api.gameRoomObjects('W35S2', shard);
  const dir = `artifacts/live/baseline-${Date.now()}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/backup.json`, JSON.stringify({ recordedAt: new Date().toISOString(), shard, branch, code, memory, room }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ dir, shard, branch, objects: room.objects.length }));
} catch (error) {
  console.error(error.response ? `HTTP ${error.response.status}` : error.message);
  process.exitCode = 1;
}
