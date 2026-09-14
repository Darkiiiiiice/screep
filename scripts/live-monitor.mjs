import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { connect } from './lib/client.mjs';
import { record } from './lib/quota-ledger.mjs';

const dir = process.argv[2];
const backup = JSON.parse(readFileSync(`${dir}/backup.json`, 'utf8'));
const expected = readFileSync('dist/main.js', 'utf8');
const { api, shard } = await connect('deploy');
if (shard !== backup.shard) throw new Error('shard mismatch');
const summary = { status: 'observing', startTick: null, endTick: null, samples: 0, codeHash: createHash('sha256').update(expected).digest('hex') };
let bad = 0, transportFailures = 0;
const save = () => writeFileSync(`${dir}/monitor-summary.json`, JSON.stringify(summary, null, 2));
save();
for (let attempt = 0; attempt < 180; attempt++) {
  try {
    const [time, room, response] = await Promise.all([api.gameTime(shard), api.gameRoomObjects('W35S2', shard), api.userMemoryGet(undefined, shard)]);
    let memory = response.data;
    if (typeof memory === 'string') memory = JSON.parse(memory.startsWith('gz:') ? gunzipSync(Buffer.from(memory.slice(3), 'base64')).toString() : memory);
    const state = memory?.bootstrap;
    const controller = room.objects.find(o => o.type === 'controller');
    const workers = room.objects.filter(o => o.type === 'creep' && o.user === controller?.user);
    summary.startTick ??= time.time;
    summary.endTick = time.time;
    summary.samples++;
    const freshErrors = state?.errors?.filter(e => e.tick >= summary.startTick) ?? [];
    const sample = { at: new Date().toISOString(), tick: time.time, heartbeat: state?.heartbeat, errors: freshErrors, workers: workers.map(o => ({ name: o.name, x: o.x, y: o.y, energy: o.store?.energy, ageTime: o.ageTime })), level: controller?.level, progress: controller?.progress, spawn: room.objects.filter(o => o.type === 'spawn').map(o => ({ energy: o.store?.energy, spawning: o.spawning })), rooms: state?.rooms, degraded: state?.degraded };
    appendFileSync(`${dir}/samples.jsonl`, `${JSON.stringify(sample)}\n`);
    console.log(`[live] tick=${time.time} heartbeat=${state?.heartbeat} workers=${workers.length} RCL=${controller?.level} progress=${controller?.progress} errors=${freshErrors.length}`);
    const unhealthy = !state || time.time - state.heartbeat > 10 || !workers.length || freshErrors.length > 0;
    bad = unhealthy ? bad + 1 : 0;
    transportFailures = 0;
    if (bad >= 3) {
      const [current, branches] = await Promise.all([api.userCodeGet(backup.branch), api.userBranches()]);
      if (current.modules?.main !== expected || !branches.list.some(b => b.branch === backup.branch && b.activeWorld)) {
        summary.status = 'stopped-code-changed'; save(); break;
      }
      const result = await api.userCodeSet({ branch: backup.branch, modules: backup.code.modules });
      record('POST', '/api/user/code', { note: 'M1 unhealthy rollback' });
      summary.status = result.ok === 1 ? 'rolled-back-awaiting-observation' : 'rollback-failed'; save(); break;
    }
    if (time.time - summary.startTick >= 1600) { summary.status = 'observation-window-complete'; save(); break; }
    save();
  } catch (error) {
    transportFailures++;
    console.error(`[live] observation unavailable: ${error.response ? `HTTP ${error.response.status}` : error.message}`);
    if (transportFailures >= 5) { summary.status = 'monitor-unavailable'; save(); break; }
  }
  await delay(60000);
}
if (summary.status === 'observing') { summary.status = 'observation-timeout'; save(); }
