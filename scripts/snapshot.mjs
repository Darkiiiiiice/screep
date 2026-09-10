/**
 * Record a live room snapshot to a fixture.
 *
 * Why: there is no local engine, so the only real data is production data. A
 * recorded snapshot lets the pure domain be driven offline against the actual
 * layout of a real room — its real terrain gaps, real source positions, real
 * spawn placement — and the resulting intent sequence asserted. That is
 * verification track B, and it costs 2 API requests per snapshot.
 *
 * Snapshots land in test/fixtures/rooms/<room>-<tick>.json and are committed:
 * they are small, they are the only non-synthetic data in the repo, and a
 * regression in the planner should fail against them.
 *
 * Usage:
 *   node scripts/snapshot.mjs [--room W34S1] [--out dir]
 */
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from './lib/client.mjs';

const args = process.argv.slice(2);
const roomFlag = args.indexOf('--room');
const outFlag = args.indexOf('--out');

const { api, shard } = await connect('deploy');

// Which rooms to record: an explicit --room, else every room the account owns.
let rooms;
if (roomFlag !== -1) {
  rooms = [args[roomFlag + 1]];
} else {
  const overview = await api.userOverview();
  rooms = overview?.shards?.[shard]?.rooms ?? [];
}

if (rooms.length === 0) {
  console.error('[snapshot] no rooms to record — the account owns none on this shard.');
  process.exit(1);
}

const outDir = resolve(process.cwd(), outFlag !== -1 ? args[outFlag + 1] : 'test/fixtures/rooms');
mkdirSync(outDir, { recursive: true });

// Game time is needed because the raw object fields are absolute (a controller
// carries `downgradeTime`, not the `ticksToDowngrade` the in-game API exposes).
const time = await api.gameTime(shard);
const gameTime = time?.time ?? null;

for (const room of rooms) {
  const res = await api.gameRoomObjects(room, shard);
  const objects = res?.objects ?? [];

  const snapshot = {
    room,
    shard,
    gameTime,
    recordedAt: new Date().toISOString(),
    objectCount: objects.length,
    objects,
  };

  const file = resolve(outDir, `${room}-${String(gameTime ?? 'unknown')}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`[snapshot] ${room}  ${String(objects.length)} objects  gameTime=${String(gameTime)}`);
  console.log(`[snapshot]   -> ${file}`);
}

const saved = readdirSync(outDir).filter((f) => f.endsWith('.json'));
console.log(`[snapshot] ${String(saved.length)} fixture(s) in ${outDir}`);
