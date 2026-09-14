import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from './lib/client.mjs';
import { candidateRooms, evaluateRoom } from './lib/room-selector.mjs';

const { values } = parseArgs({ options: { execute: { type: 'boolean' }, room: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('npm run select-room [-- --room W12N45] [-- --execute]\nDefault: read-only ranking. --execute rechecks and places Spawn1; no code is uploaded.');
  process.exit(0);
}
try {
  const { api, shard, warning } = await connect('deploy');
  if (warning) throw new Error(warning);
  const world = await api.userWorldStatus();
  if (world?.status !== 'empty') throw new Error(`world status is ${world?.status}; refusing first-spawn operation`);
  const start = await api.userWorldStartRoom(shard);
  if (!Array.isArray(start.room) || !start.room.length) throw new Error('no recommended start regions');
  const rooms = values.room ? [values.room] : candidateRooms(start.room);
  if (rooms.some(room => !/^[WE]\d+[NS]\d+$/.test(room))) throw new Error('invalid room name');
  const report = { generatedAt: new Date().toISOString(), shard, centers: start.room, mode: values.execute ? 'execute' : 'dry-run', candidates: [] };
  async function inspect(room) {
    const terrain = await api.gameRoomTerrain(room, shard);
    const objects = await api.gameRoomObjects(room, shard);
    const status = await api.gameRoomStatus(room, shard);
    return evaluateRoom(room, terrain.terrain?.[0]?.terrain, objects.objects, status.room ?? status);
  }
  for (const room of rooms) {
    try { report.candidates.push(await inspect(room)); }
    catch { report.candidates.push({ room, eligible: false, reason: 'API inspection failed; retry this room explicitly' }); }
    const row = report.candidates.at(-1);
    console.log(`[select-room] ${room}: ${row.eligible ? `score=${row.score} spawn=(${row.x},${row.y}) sources=${row.sources}` : row.reason}`);
  }
  const selected = report.candidates.filter(r => r.eligible).sort((a, b) => b.score - a.score || a.room.localeCompare(b.room))[0];
  report.selected = selected ?? null;
  mkdirSync('artifacts/bootstrap', { recursive: true });
  const file = resolve('artifacts/bootstrap', `selection-${Date.now()}.json`);
  const save = () => writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  save();
  console.log(`[select-room] report: ${file}`);
  if (!selected) throw new Error('no eligible room found; inspect another room using --room');
  console.log(`[select-room] selected ${shard}/${selected.room} (${selected.x},${selected.y})`);
  if (values.execute) {
    const latest = await inspect(selected.room);
    if ((await api.userWorldStatus()).status !== 'empty' || !latest.eligible || latest.x !== selected.x || latest.y !== selected.y) throw new Error('world or site changed; rerun selection');
    // This mutation is never automatically retried: a lost response may still mean success.
    const result = await api.gamePlaceSpawn(selected.room, selected.x, selected.y, 'Spawn1', shard);
    report.placement = result?.ok === 1 ? 'accepted' : 'rejected';
    save();
    if (result?.ok !== 1) throw new Error('spawn placement rejected; check report and token game/place-spawn permission');
    const observed = await api.gameRoomObjects(selected.room, shard);
    report.verified = observed.objects?.some(o => o.type === 'spawn' && o.name === 'Spawn1' && o.x === selected.x && o.y === selected.y) ?? false;
    save();
    console.log(`[select-room] placement accepted; verified=${report.verified}`);
  } else console.log(`[select-room] read-only; start with: npm run select-room -- --room ${selected.room} --execute`);
} catch (error) {
  // Never print HTTP client objects, which may include authentication headers.
  console.error(`[select-room] ${error?.response ? `HTTP ${error.response.status}; check permissions/quota and inspect world before retrying placement` : error.message}`);
  process.exitCode = 1;
}
