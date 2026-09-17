import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { build } from 'esbuild';

const requireEngine = createRequire(resolve('.engine/package.json'));
const { ScreepsServer, TerrainMatrix } = requireEngine('screeps-server-mockup');
const fixture = JSON.parse(readFileSync('test/scenarios/fixtures.json', 'utf8'));
const args = process.argv.slice(2);
const lifecycle = args.includes('--lifecycle');
const recovery = args.includes('--recovery');
const logistics = args.includes('--logistics');
const construction = args.includes('--construction');
const logisticsRecovery = args.includes('--logistics-recovery');
const persistentFailure = args.includes('--persistent-failure');
const trafficProbe = args.includes('--traffic-probe');
const trafficRecovery = args.includes('--traffic-recovery');
const fairnessProbe = args.includes('--fairness-probe');
const economyProbe = args.includes('--economy-probe');
const populationPressure = args.includes('--population-pressure');
const cpuStress = args.includes('--cpu-stress');
const multiRoom = args.includes('--multi-room');
const maintenanceProbe = args.includes('--maintenance-probe');
const defenseProbe = args.includes('--defense-probe');
const progressionProbe = args.includes('--progression-probe');
const intelProbe = args.includes('--intel-probe');
const minersProbe = args.includes('--miners-probe');
const claimProbe = args.includes('--claim-probe');
const pioneerProbe = args.includes('--pioneer-probe');
assert(!persistentFailure || lifecycle && logistics && logisticsRecovery, '--persistent-failure requires --lifecycle --logistics --logistics-recovery');
assert(!economyProbe || lifecycle && logistics, '--economy-probe requires --lifecycle --logistics');
assert(!cpuStress || fairnessProbe, '--cpu-stress requires --fairness-probe');
assert(!trafficRecovery || !lifecycle && !fairnessProbe && !logistics, '--traffic-recovery runs standalone');
assert(!multiRoom || lifecycle && logistics && fairnessProbe, '--multi-room requires --lifecycle --logistics --fairness-probe');
assert(!maintenanceProbe || lifecycle && logistics && !construction && !fairnessProbe, '--maintenance-probe requires --lifecycle --logistics');
assert(!defenseProbe || lifecycle && logistics && !construction && !fairnessProbe, '--defense-probe requires --lifecycle --logistics');
assert(!progressionProbe || lifecycle && logistics && !construction && !fairnessProbe, '--progression-probe requires --lifecycle --logistics');
assert(!intelProbe || lifecycle && logistics && !construction && !fairnessProbe && !multiRoom, '--intel-probe requires --lifecycle --logistics');
assert(!minersProbe || lifecycle && logistics && !construction && !fairnessProbe && !progressionProbe && !intelProbe, '--miners-probe requires --lifecycle --logistics');
assert(!claimProbe || lifecycle && logistics && !construction && !fairnessProbe && !progressionProbe && !intelProbe && !minersProbe, '--claim-probe requires --lifecycle --logistics');
assert(!pioneerProbe || lifecycle && logistics && !construction && !fairnessProbe && !progressionProbe && !intelProbe && !minersProbe && !claimProbe, '--pioneer-probe requires --lifecycle --logistics');
const tickCount = trafficRecovery ? 120 : fairnessProbe ? 600 : lifecycle ? (construction ? 3100 : progressionProbe ? 5500 : minersProbe ? 300 : claimProbe ? 600 : pioneerProbe ? 1000 : intelProbe ? 1500 : recovery || logistics ? 600 : 3100) : 6;
const variant = args.find((arg) => !arg.startsWith('--')) ?? 'fresh';
assert(fixture.variants[variant], `unknown variant: ${variant}`);
const injectFailure = args.includes('--inject-failure');
const output = resolve('artifacts/scenarios', `${variant}-${Date.now()}-${process.pid}`);
mkdirSync(output, { recursive: true });
const bundle = readFileSync('dist/main.js', 'utf8');
const report = {
  variant, fixture, bundleHash: createHash('sha256').update(bundle).digest('hex'),
    logistics, construction, logisticsRecovery, persistentFailure, trafficProbe, trafficRecovery, fairnessProbe, economyProbe, populationPressure, cpuStress, multiRoom, maintenanceProbe, defenseProbe, tickCount,
  node: process.version,
    logistics, construction, logisticsRecovery, persistentFailure, trafficProbe, trafficRecovery, fairnessProbe, economyProbe, populationPressure, cpuStress, multiRoom, maintenanceProbe, defenseProbe, progressionProbe, intelProbe, tickCount,
  checks: [], ticks: [], logs: [], status: 'running',
};
const save = () => writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
save();
const freePort = await new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolvePort(port)); });
});
const server = new ScreepsServer({ path: resolve(output, 'server'), logdir: resolve(output, 'logs'), port: Number(process.env.SCREEPS_TEST_PORT ?? freePort) });
server.on('error', (error) => { report.logs.push(String(error)); save(); });
let bot;
const check = (name, condition) => {
  report.checks.push({ name, passed: Boolean(condition) });
  assert(condition, name);
};
try {
  await server.world.reset();
  const terrain = new TerrainMatrix();
  for (const [x, y] of fixture.terrain.walls) terrain.set(x, y, 'wall');
  for (const [x, y] of fixture.terrain.swamps) terrain.set(x, y, 'swamp');
  if (trafficRecovery) for (const [x, y] of [[30, 18], [32, 18], [30, 19], [32, 19], [30, 20], [32, 20], [30, 21], [31, 21], [32, 21], [39, 24], [40, 24], [41, 24], [39, 25], [41, 25], [39, 26], [40, 26], [41, 26]]) terrain.set(x, y, 'wall');
  await server.world.addRoom(fixture.room);
  await server.world.setTerrain(fixture.room, terrain);
  await server.world.addRoomObject(fixture.room, 'controller', ...fixture.controller, { level: 0 });
  for (const [x, y] of fixture.sources) {
    await server.world.addRoomObject(fixture.room, 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
  }
  // Rule probes are independent of AI strategy; lifecycle mode runs the bundle.
  const probe = `
    module.exports.loop = function () {
      require('app').loop();
      const c = Game.creeps.Probe;
      Memory.probe = Memory.probe || [];
      const row = {tick: Game.time, x: c.pos.x, energy: c.store.energy, fatigue: c.fatigue};
      if (Game.time === 1) {
        row.harvest = c.harvest(c.pos.findClosestByRange(FIND_SOURCES));
        row.immediateEnergy = c.store.energy;
        row.limit = Game.rooms.W0N1.createConstructionSite(30, 30, STRUCTURE_EXTENSION);
        row.containers = CONTROLLER_STRUCTURES.container;
      }
      if (Game.time === 2) row.move = c.move(RIGHT);
      if (Game.time === 3) row.move = c.move(RIGHT);
      if (Game.time === 4) row.siteMove = c.move(RIGHT);
      if (Game.time === 5) row.roadMove = c.move(RIGHT);
      Memory.probe.push(row);
    };`;
  const trafficBundle = trafficProbe || trafficRecovery ? (await build({ entryPoints: ['src/game/traffic.ts'], bundle: true, write: false, format: 'cjs', platform: 'neutral', target: 'node24' })).outputFiles[0].text : '';
  const trafficRecoveryMain = `module.exports.loop = function () {
    const traffic = require('traffic');
    const mem = Memory.trafficRecovery ??= { positions: [], states: [] };
    const worker = Game.creeps.CorridorWorker, blocker = Game.creeps.Blocker, sealed = Game.creeps.Sealed;
    const row = { t: Game.time,
      w: worker ? [worker.pos.x, worker.pos.y] : null,
      b: blocker ? [blocker.pos.x, blocker.pos.y] : null,
      s: sealed ? [sealed.pos.x, sealed.pos.y] : null };
    const trafficState = (creep) => creep?.memory.traffic ? { stuck: creep.memory.traffic.stuck, failures: creep.memory.traffic.failures, wait: (creep.memory.traffic.retryAt ?? Game.time) - Game.time } : null;
    const state = { t: Game.time, w: trafficState(worker), b: trafficState(blocker), s: trafficState(sealed) };
    if (worker) traffic.requestMove(worker, new RoomPosition(31, 20, worker.room.name), 0);
    if (blocker && Game.time >= 40 && (blocker.pos.x !== 31 || blocker.pos.y !== 16)) traffic.requestMove(blocker, new RoomPosition(31, 16, blocker.room.name), 0);
    if (sealed) traffic.requestMove(sealed, new RoomPosition(40, 25, sealed.room.name), 0);
    traffic.flushTraffic(worker.room);
    mem.positions.push(row);
    mem.states.push(state);
  };`;
  const trafficMain = `module.exports.loop = function () {
    const traffic = require('traffic');
    const a = Game.creeps.SwapA, b = Game.creeps.SwapB;
    if (Game.time === 1) {
      traffic.requestMove(a, b.pos, 0);
      traffic.requestMove(b, a.pos, 0);
    }
    const c = Game.creeps.ChainA, d = Game.creeps.ChainB, e = Game.creeps.Blocker;
    if (Game.time === 1 || Game.time === 4) {
      traffic.requestMove(c, d.pos, 0);
      traffic.requestMove(d, e.pos, 0);
      if (Game.time === 4) traffic.requestMove(e, new RoomPosition(23, 30, e.room.name), 0);
    }
    traffic.flushTraffic(a.room);
  };`;
  bot = await server.world.addBot({ username: 'M0', room: fixture.room, x: fixture.spawn[0], y: fixture.spawn[1], modules: trafficRecovery ? { main: trafficRecoveryMain, traffic: trafficBundle } : trafficProbe ? { main: trafficMain, traffic: trafficBundle } : fairnessProbe ? { main: bundle } : lifecycle ? { main: bundle } : { main: probe, app: 'module.exports.loop = function() {}' } });
  if (trafficProbe || trafficRecovery) report.trafficBundleHash = createHash('sha256').update(trafficBundle).digest('hex');
  bot.on('console', (logs) => report.logs.push(...logs));
  const { db, env } = server.common.storage;
  await env.set(env.keys.MEMORY + bot.id, JSON.stringify(fixture.variants[variant].memory));
  if (intelProbe) {
    // v1 遗产:线上实证旧代码遗留 schema-less 的 intel: {}(2026-09-17),
    // 情报层必须重置恢复而非逐 tick 抛错死锁——探针端到端覆盖该迁移路径。
    const legacy = { ...fixture.variants[variant].memory, intel: {} };
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify(legacy));
  }
  const addCreep = (name, x, y) => server.world.addRoomObject(fixture.room, 'creep', x, y, {
    user: bot.id, name, body: ['work', 'carry', 'move'].map((type) => ({ type, hits: 100 })),
    hits: 300, hitsMax: 300, store: { energy: 0 }, storeCapacity: 50,
    fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
  });
  if (!lifecycle) await addCreep('Probe', 14, 15);
  if (cpuStress) await db.users.update({ _id: bot.id }, { $set: { cpu: 10 } });
  if (trafficProbe) {
    await addCreep('SwapA', 20, 25);
    await addCreep('SwapB', 21, 25);
    await addCreep('ChainA', 20, 30);
    await addCreep('ChainB', 21, 30);
    await addCreep('Blocker', 22, 30);
  }
  if (trafficRecovery) {
    await addCreep('CorridorWorker', 31, 16);
    await addCreep('Blocker', 31, 19);
    await addCreep('Sealed', 37, 25);
  }
  if (fairnessProbe) {
    for (const [x, y] of fixture.sources) await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
      store: { energy: 500 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 500,
    });
    for (const [index, [x, y]] of [[23, 24], [27, 24], [23, 26], [27, 26]].entries()) await addCreep(`FairWorker${index}`, x, y);
    if (populationPressure) for (let index = 0; index < 20; index++) await addCreep(`PressureWorker${index}`, 20 + index % 8, 20 + Math.floor(index / 8));
    if (cpuStress) for (let index = 0; index < 60; index++) await addCreep(`StressWorker${index}`, 18 + index % 14, 30 + Math.floor(index / 14));
  }
  // Compare a blocking construction site with a traversable road site.
  await server.world.addRoomObject(fixture.room, 'constructionSite', 15, 16, {
    user: bot.id, structureType: 'extension', progress: 0, progressTotal: 3000,
  });
  if (fixture.variants[variant].legacyAssets) {
    await addCreep('LegacyWorker', 24, 24);
    await server.world.addRoomObject(fixture.room, 'container', 16, 15, {
      store: { energy: 500 }, storeCapacity: 2000, hits: 100000, hitsMax: 250000, nextDecayTime: 100,
    });
  }
  if (logistics) {
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true }));
    if (!construction) for (const [x, y] of fixture.sources) await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
      store: { energy: 0 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 500,
    });
  }
  if (maintenanceProbe) {
    // Start at RCL2 so the extension planner is unlocked from tick one, and run
    // the repair loop and the extension builders in the same 600-tick window.
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 2, progress: 0 } });
    // Damage the FIRST source's miner container (40% hits: repairable, below the
    // urgent line): it is income-critical by source adjacency, so the repair loop
    // prefers it over dead weight and funds itself from miner throughput.
    await db['rooms.objects'].update({ type: 'container', room: fixture.room, x: fixture.sources[0][0] + 1, y: fixture.sources[0][1] }, { $set: { hits: 100000 } });
    // A decayed EMPTY legacy container far from any source (the live W35S2
    // deadlock shape): at 20% hits it sits below the urgent line, but with no
    // income it must never pause construction — the build checks below become
    // the regression gate for the income-scoped urgent repair rule.
    await server.world.addRoomObject(fixture.room, 'container', 20, 44, {
      store: { energy: 0 }, storeCapacity: 2000, hits: 50000, hitsMax: 250000, nextDecayTime: 500,
    });
    report.maintenance = { damagedContainer: [fixture.sources[0][0] + 1, fixture.sources[0][1]], seededHits: 100000, legacyContainer: [20, 44], legacySeededHits: 50000 };
  }
  if (defenseProbe) {
    // RCL3 (tower cap 1) + a stocked tower + an armed Invader raider: the tower
    // must focus-fire it down, then heal the seeded wounded worker. Tower user =
    // bot so FIND_MY_* works; the raider belongs to Invader (user 2) → hostile.
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 3, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'tower', 24, 24, {
      user: bot.id, store: { energy: 1000 }, energy: 1000, energyCapacity: 1000, hits: 3000, hitsMax: 3000,
    });
    await server.world.addRoomObject(fixture.room, 'creep', 34, 34, {
      user: '2', name: 'Raider', body: [
        ...Array.from({ length: 10 }, () => ({ type: 'attack', hits: 100 })),
        ...Array.from({ length: 10 }, () => ({ type: 'move', hits: 100 })),
      ],
      hits: 1000, hitsMax: 1000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
    });
    await server.world.addRoomObject(fixture.room, 'creep', 25, 24, {
      user: bot.id, name: 'Wounded', body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
      hits: 150, hitsMax: 300, store: { energy: 20 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
    });
    report.defense = { tower: [24, 24], raiderHits: 1000, woundedHits: 150 };
  }
  if (progressionProbe) {
    // RCL2 stage seeds three built extensions so spawn capacity reaches 450 and
    // builders get 2-WORK bodies; the AI must place and finish the remaining two.
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 2, progress: 0 } });
    for (const [x, y] of [[24, 23], [26, 23], [23, 26]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, { user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    }
  }
  if (minersProbe) {
    // RCL3 满配经济:8 座满能 extension(容量 700≥650)、双源容器就位(空)、
    // 6 只工人在编(目标人口已满)→ 矿工门全开,第一 tick 就该孵 5-WORK 矿工。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 3, progress: 0 } });
    for (const [x, y] of [[24, 23], [26, 23], [23, 26], [27, 24], [24, 27], [22, 25], [26, 22], [23, 24]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, { user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    }
    for (const [sx, sy] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', sx + 1, sy, { store: { energy: 0 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 100000 });
    }
    for (const [i, [x, y]] of [[20, 20], [22, 22], [28, 28], [24, 20], [20, 24], [28, 24]].entries()) {
      await server.world.addRoomObject(fixture.room, 'creep', x, y, {
        user: bot.id, name: `worker-seeded-${i}`, body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
        hits: 300, hitsMax: 300, store: { energy: 0 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
      });
    }
    report.miners = { containers: fixture.sources.map(([x, y]) => [x + 1, y]) };
  }
  if (claimProbe) {
    // 预定者切片:RCL3 满配经济(8 满能 ext=容量 800/能量 700)+6 工人满编,
    // 无容器(矿工需求落空,预定者顺位上场);W0N2 中立房带控制器双源,
    // 情报/跳数预种子 → 首评估即锁定 W0N2,第一 tick 就该孵预定者。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 3, progress: 0 } });
    for (const [x, y] of [[24, 23], [26, 23], [23, 26], [27, 24], [24, 27], [22, 25], [26, 22], [23, 24]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, { user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    }
    for (const [i, [x, y]] of [[20, 20], [22, 22], [28, 28], [24, 20], [20, 24], [28, 24]].entries()) {
      await server.world.addRoomObject(fixture.room, 'creep', x, y, {
        user: bot.id, name: `worker-seeded-${i}`, body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
        hits: 300, hitsMax: 300, store: { energy: 0 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
      });
    }
    const ring = ['W1N1', 'W1N0', 'W1N2', 'W0N0', 'W0N2', 'E0N1', 'E0N0', 'E0N2'];
    for (const name of ring) {
      await server.world.addRoom(name);
      await server.world.setTerrain(name, new TerrainMatrix());
    }
    await server.world.addRoomObject('W0N2', 'controller', 10, 12, { level: 0 });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true, intel: { schema: 1, rooms: { W0N2: { observedAt: 1, sources: [{ id: 'seeded-1', x: 1, y: 1 }, { id: 'seeded-2', x: 2, y: 2 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0 } } }, distances: { W0N2: 1 } } }));
    report.claim = { room: 'W0N2' };
  }
  if (pioneerProbe) {
    // 远矿工人切片:claim 同款经济底座;W0N2 预置我方有效预定(引擎对象 +
    // 情报双写)→ 预定者需求落空,远矿工人第一 tick 上场,跑采矿-回运闭环。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 3, progress: 0 } });
    for (const [x, y] of [[24, 23], [26, 23], [23, 26], [27, 24], [24, 27], [22, 25], [26, 22], [23, 24]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, { user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    }
    for (const [i, [x, y]] of [[20, 20], [22, 22], [28, 28], [24, 20], [20, 24], [28, 24]].entries()) {
      await server.world.addRoomObject(fixture.room, 'creep', x, y, {
        user: bot.id, name: `worker-seeded-${i}`, body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
        hits: 300, hitsMax: 300, store: { energy: 0 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 1501, actionLog: {},
      });
    }
    const ring = ['W1N1', 'W1N0', 'W1N2', 'W0N0', 'W0N2', 'E0N1', 'E0N0', 'E0N2'];
    for (const name of ring) {
      await server.world.addRoom(name);
      await server.world.setTerrain(name, new TerrainMatrix());
    }
    // 封死施工排水口:双容器+塔预置(RCL3 塔上限 1)→ 无工地,盈余才轮到
    // 远矿工人;否则塔工地 5000 进度把能量钉死在低位(与线上同现象)。
    for (const [sx, sy] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', sx + 1, sy, { store: { energy: 0 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 100000 });
    }
    await server.world.addRoomObject(fixture.room, 'tower', 24, 25, { user: bot.id, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 }, hits: 3000, hitsMax: 3000 });
    await server.world.addRoomObject('W0N2', 'controller', 10, 12, { level: 0, reservation: { user: bot.id, endTime: 100000 } });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true, intel: { schema: 1, rooms: { W0N2: { observedAt: 1, sources: [{ id: 'seeded-1', x: 1, y: 1 }, { id: 'seeded-2', x: 2, y: 2 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'M0', reservationTicks: 4000 } } }, distances: { W0N2: 1 } } }));
    report.pioneer = { room: 'W0N2' };
  }
  if (fairnessProbe) {
    await server.world.addRoomObject(fixture.room, 'extension', 26, 25, { user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    await server.world.addRoomObject(fixture.room, 'extension', 24, 25, { user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000 });
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true, fairnessProbe: { last: {}, maxWait: {}, delivered: {} } }));
  }
  report.initialObjects = await server.world.roomObjects(fixture.room);
  report.constants = { containers: server.constants.CONTROLLER_STRUCTURES.container, creepSpawnTime: server.constants.CREEP_SPAWN_TIME };
  if (multiRoom) {
    const roomB = 'W0N2';
    await server.world.addRoom(roomB);
    await server.world.setTerrain(roomB, new TerrainMatrix());
    await server.world.addRoomObject(roomB, 'controller', 10, 12, { level: 1, user: bot.id, progress: 0 });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject(roomB, 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    await server.world.addRoomObject(roomB, 'spawn', 25, 25, { user: bot.id, name: 'Spawn2', store: { energy: 300 }, storeCapacityResource: { energy: 300 }, hits: 5000, hitsMax: 5000, spawning: null, notifyWhenAttacked: true });
    report.multiRoom = { room: roomB, controller: [10, 12], sources: fixture.sources, spawn: [25, 25] };
  }
  if (intelProbe) {
    // 中立邻房:无归属控制器 + 双 source,专供 scout 跨房观测。
    // 必须铺满 3×3 邻域:mock 引擎只给已注册房间加载寻路地形,
    // 洪泛边界踏入未注册房间会让 native pathfinder 抛错(线上官方服无此问题)。
    const ring = ['W1N1', 'W1N0', 'W1N2', 'W0N0', 'W0N2', 'E0N1', 'E0N0', 'E0N2'];
    for (const name of ring) {
      await server.world.addRoom(name);
      await server.world.setTerrain(name, new TerrainMatrix());
    }
    await server.world.addRoomObject('W0N2', 'controller', 10, 12, { level: 0 });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    report.intelProbe = { room: 'W0N2', sources: fixture.sources };
  }
  await server.start();
  let births = 0, delivered = 0, emptyRun = 0, maxEmptyRun = 0;
  let lastControllerProgress = 0, controllerIdle = 0, maxControllerIdle = 0;
  if (fairnessProbe) report.fairness = { delivered: {}, last: {}, maxWait: {} };
  const names = new Set();
  for (let i = 0; i < tickCount; i++) {
    if (progressionProbe && (i === 3000 || i === 4300)) {
      const level = i === 3000 ? 3 : 4;
      const { db } = server.common.storage;
      await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level, progress: 0 } });
      console.log(`[progression] stage bump to RCL${level} at tick ${i}`);
    }

    if (persistentFailure && [450, 451, 452].includes(i)) {
      const current = JSON.parse(await bot.memory || '{}');
      if (i === 450) {
        const live = (await server.world.roomObjects(fixture.room)).filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning).sort((a, b) => a.name.localeCompare(b.name));
        const selected = live.find(o => !current.creeps[o.name]?.delivery && !current.creeps[o.name]?.logisticsRecovery);
        assert(selected, 'persistent fault requires a worker without an unsettled delivery or recovery');
        report.persistentFault = { name: selected.name, actions: 0 };
      }
      const name = report.persistentFault.name;
      current.creeps[name].shipment = { from: 'fault-source', to: 'fault-target', expires: 900, dependsOn: [name], waitingSince: i };
      await env.set(env.keys.MEMORY + bot.id, JSON.stringify(current));
    }
    if (logisticsRecovery && i === 400) {
      const current = JSON.parse(await bot.memory || '{}');
      const live = (await server.world.roomObjects(fixture.room)).filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning).map(o => o.name).sort();
      assert(live.length >= 3, 'cycle injection requires three active workers');
      const members = live.slice(0, 3);
      for (const [index, name] of members.entries()) {
        const creep = current.creeps[name] ??= {};
        creep.shipment = { from: 'cycle-source', to: 'cycle-target', expires: 900, dependsOn: [members[(index + 1) % members.length]], waitingSince: 400 };
      }
      report.cycleInjection = { members, deliveredBefore: current.logisticsDelivered ?? 0 };
      await env.set(env.keys.MEMORY + bot.id, JSON.stringify(current));
    }
    if (economyProbe && i === 300) {
      const site = report.initialObjects.find(o => o.type === 'constructionSite' && o.x === 15 && o.y === 16);
      const spawnObject = report.initialObjects.find(o => o.type === 'spawn' && o.user === bot.id);
      assert(site && spawnObject, 'economy probe requires the fixture site and spawn');
      const current = JSON.parse(await bot.memory || '{}');
      const previous = report.ticks.at(-1);
      const serviceWorker = previous.memory.controllerService?.W0N1?.worker;
      const live = previous.objects.filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning).map(o => o.name).sort();
      const selected = live.find(name => name !== serviceWorker && !current.creeps[name]?.shipment && !current.creeps[name]?.containerBuilder);
      assert(selected, 'economy probe requires an idle worker');
      current.creeps[selected].shipment = { from: spawnObject._id, to: spawnObject._id, expires: 900, dependsOn: [`build:${site._id}`], waitingSince: 300 };
      delete current.creeps[selected].minerSource;
      await env.set(env.keys.MEMORY + bot.id, JSON.stringify(current));
      report.economyProbe = { worker: selected, site: site._id };
    }
    if (logisticsRecovery && i === 350) {
      const current = JSON.parse(await bot.memory || '{}');
      for (const creep of Object.values(current.creeps ?? {})) {
        creep.shipment = { from: 'destroyed-source', to: 'destroyed-target', expires: 500 };
      }
      await env.set(env.keys.MEMORY + bot.id, JSON.stringify(current));
      report.logisticsRecoveryInjectedAt = i;
    }
    if (lifecycle && recovery && i === 200) {
      await db['rooms.objects'].removeWhere({ type: 'creep', user: bot.id });
      await db['rooms.objects'].update({ type: 'spawn', user: bot.id }, { $set: { store: { energy: 0 }, spawning: null } });
      await addCreep('RescueWorker', 14, 15);
      await env.set(env.keys.MEMORY + bot.id, '{}');
      report.recoveryInjectedAt = i;
    }
    if (!lifecycle && i === 1) {
      // Reposition between independent probes, retaining the harvested load.
      await db['rooms.objects'].update({ name: 'Probe', user: bot.id }, { $set: { x: 20, y: 20, fatigue: 0 } });
    }
    if (!lifecycle && i === 3) {
      await db['rooms.objects'].update({ name: 'Probe', user: bot.id }, { $set: { x: 14, y: 16, fatigue: 0 } });
    }
    if (!lifecycle && i === 4) {
      await db['rooms.objects'].update({ type: 'constructionSite', x: 15, y: 16 }, { $set: { structureType: 'road' } });
    }
    await server.tick();
    const snapshot = { time: await server.world.gameTime, objects: await server.world.roomObjects(fixture.room), memory: JSON.parse(await bot.memory || '{}'), ...(multiRoom || intelProbe ? { roomB: await server.world.roomObjects('W0N2') } : {}) };
    if (progressionProbe && snapshot && (i === 4299 || i === tickCount - 1)) {
      const objects = snapshot.objects;
      if (i === 4299) {
        check('RCL3 stage: tower is placed and under construction', objects.some(o => o.type === 'tower') || objects.some(o => o.type === 'constructionSite' && o.structureType === 'tower' && (o.progress ?? 0) > 0));
      } else {
        check('RCL4 stage: storage is placed and under construction', objects.some(o => o.type === 'storage') || objects.some(o => o.type === 'constructionSite' && o.structureType === 'storage' && (o.progress ?? 0) > 0));
        const storageObject = objects.find(o => o.type === 'storage');
        if (storageObject) check('storage accumulates energy from the board', (storageObject.store?.energy ?? 0) > 0);
        check('progression heartbeat completed', snapshot.memory.bootstrap?.heartbeat >= tickCount);
        check('progression has no isolated runtime errors', snapshot.memory.bootstrap?.errors.length === 0);
      }
    }
    if (progressionProbe && i === tickCount - 1) {
      // RCL2 扩展能力按时间窗判定(台账 2026-09-17 三度校准):mock 引擎对
      // CPU 时间扰动混沌——同代码两跑出生时刻差 1 tick,工地能量差值放大到
      // 千分位,完工时点 2802~3350 漂移;能力证据是窗口内达到 RCL2 上限(5),
      // 单帧点读等价掷硬币。规划器坏死(恒 3)在该窗口内同样必挂,不弱化门。
      const reached = report.ticks.some(t => t.time >= 2800 && t.time <= 3899
        && t.objects.filter(o => o.type === 'extension').length >= 5);
      check('RCL2 stage: extensions reach the controller cap (5)', reached);
    }
    if (fairnessProbe) {
      const fairness = report.fairness;
      for (const object of snapshot.objects.filter(o => o.type === 'extension' && o.user === bot.id)) {
        fairness.last[object._id ?? object.id] ??= i;
        fairness.maxWait[object._id ?? object.id] = Math.max(fairness.maxWait[object._id ?? object.id] ?? 0, i - fairness.last[object._id ?? object.id]);
        if ((object.store?.energy ?? 0) > 0) {
          fairness.delivered[object._id ?? object.id] = (fairness.delivered[object._id ?? object.id] ?? 0) + object.store.energy;
          fairness.last[object._id ?? object.id] = i;
          await db['rooms.objects'].update({ _id: object._id }, { $set: { store: { energy: 0 } } });
        }
      }
    }
    if (economyProbe) {
      const namespaces = Object.values(snapshot.memory.logisticsTasks ?? {});
      const tasks = Object.assign({}, ...namespaces);
      report.economy ??= { spawnSeen: false, buildSeen: false, crossKind: false, released: false };
      if (Object.keys(tasks).some(id => id.startsWith('spawn:'))) report.economy.spawnSeen = true;
      if (Object.keys(tasks).some(id => id.startsWith('build:'))) report.economy.buildSeen = true;
      const worker = snapshot.memory.creeps?.[report.economyProbe?.worker ?? ''];
      if (worker?.shipment?.dependsOn?.some(id => id.startsWith('build:'))) report.economy.crossKind = true;
      if (worker && !worker.shipment && worker.logisticsRecovery?.reason === 'dependency-timeout') report.economy.released = true;
    }
    if (cpuStress && snapshot.memory.bootstrap?.degraded) (report.stress ??= { degradedSeen: false }).degradedSeen = true;
    if (intelProbe) {
      report.intel ??= {};
      if (report.intel.scoutSpawned === undefined && snapshot.objects.some(o => o.type === 'creep' && o.user === bot.id && o.name?.startsWith('scout-'))) report.intel.scoutSpawned = i;
      if (report.intel.entered === undefined && (snapshot.roomB ?? []).some(o => o.type === 'creep' && o.user === bot.id)) report.intel.entered = i;
    }
    if (minersProbe) {
      const miner = snapshot.objects.find(o => o.type === 'creep' && o.user === bot.id && o.name?.startsWith('miner-'));
      if (miner && report.miners.spawned === undefined) report.miners.spawned = i;
      if (miner?.actionLog?.harvest && report.miners.harvested === undefined) report.miners.harvested = i;
      if (miner && report.miners.parked === undefined && report.miners.containers.some(([x, y]) => miner.x === x && miner.y === y)) report.miners.parked = i;
    }
    if (persistentFailure && i >= 452) {
      const name = report.persistentFault.name;
      const state = snapshot.memory.creeps[name];
      assert(state?.logisticsRecovery?.stopped && state.logisticsRecovery.attempts === 3, 'third dependency failure must remain stopped');
      assert(!state.shipment, 'stopped worker must not acquire a new shipment');
      const worker = snapshot.objects.find(o => o.name === name && o.type === 'creep');
      assert(worker, 'faulted worker must remain alive');
      if (report.persistentFault.energy !== undefined && worker.store.energy !== report.persistentFault.energy) report.persistentFault.actions++;
      report.persistentFault.energy = worker.store.energy;
    }
    if (logisticsRecovery && i === 351) {
      check('invalid orders released within two ticks', Object.values(snapshot.memory.creeps ?? {}).every(c => c.shipment?.to !== 'destroyed-target'));
    }
    if (logisticsRecovery && i === 401) {
      check('dependency cycle detected and leases released within two ticks', snapshot.memory.logisticsCycles > 0 && report.cycleInjection.members.every(name => !snapshot.memory.creeps[name]?.shipment?.dependsOn?.length));
      check('cycle recovery preserves a diagnostic and bounded retry', report.cycleInjection.members.every(name => snapshot.memory.creeps[name]?.logisticsRecovery?.reason === 'dependency-cycle' && snapshot.memory.creeps[name].logisticsRecovery.retryAt <= 420));
    }
    if (lifecycle) {
      const workers = snapshot.objects.filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning);
      if (multiRoom) for (const worker of (snapshot.roomB ?? []).filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning)) if (!names.has(worker.name)) { names.add(worker.name); (report.multiRoomBirths ??= { W0N1: 0, W0N2: 0 }).W0N2++; }
      for (const worker of workers) if (!names.has(worker.name)) { names.add(worker.name); births++; if (multiRoom) (report.multiRoomBirths ??= { W0N1: 0, W0N2: 0 }).W0N1++; }
      if (i > 100) { emptyRun = workers.length ? 0 : emptyRun + 1; maxEmptyRun = Math.max(maxEmptyRun, emptyRun); }
      const controller = snapshot.objects.find(o => o.type === 'controller');
      delivered = (controller.level > 1 ? 200 : 0) + (controller.progress ?? 0);
      controllerIdle = workers.length >= 3 && delivered === lastControllerProgress ? controllerIdle + 1 : 0;
      maxControllerIdle = Math.max(maxControllerIdle, controllerIdle);
      lastControllerProgress = delivered;
      if (i % 100 === 0) console.log(`[lifecycle] tick=${i} workers=${workers.length} progress=${delivered}`);
      if (i % 100 === 0 || i === tickCount - 1 || economyProbe && i % 10 === 0) { report.ticks.push(snapshot); save(); }
    } else if (!fairnessProbe) { report.ticks.push(snapshot); save(); }
    else if (i % 100 === 0 || i === tickCount - 1) { report.ticks.push({ time: snapshot.time, objects: snapshot.objects.filter(o => o.type === 'extension' || o.type === 'creep' || o.type === 'spawn'), ...(multiRoom ? { roomB: snapshot.roomB } : {}), memory: snapshot.memory }); save(); }
  }
  if (fairnessProbe) {
    const delivered = Object.values(report.fairness.delivered);
    check('all extension consumers receive energy in the engine', delivered.length === 2 && delivered.every(amount => amount > 0));
    check('engine consumer wait remains bounded', Object.values(report.fairness.maxWait).every(wait => wait <= 200));
    if (cpuStress) check('cpu pressure reaches the degraded threshold', report.stress?.degradedSeen === true);
    if (multiRoom) {
      const first = report.ticks[0], last = report.ticks.at(-1);
      const mine = (objects) => objects.filter(o => o.type === 'creep' && o.user === bot.id && !o.spawning);
      const controllerOf = (objects, room) => objects.find(o => o.type === 'controller' && o.room === room);
      const namespaces = last.memory.logisticsTasks ?? {};
      check('multi-room sees both controllers as owned', last.memory.bootstrap?.capabilities?.rooms?.W0N1?.owned === true && last.memory.bootstrap?.capabilities?.rooms?.W0N2?.owned === true);
      check('multi-room keeps both populations alive', mine(last.objects).length >= 2 && mine(last.roomB ?? []).length >= 2);
      check('multi-room advances both controllers', (controllerOf(last.objects, 'W0N1')?.progress ?? 0) > (controllerOf(first.objects, 'W0N1')?.progress ?? 0) && (controllerOf(last.roomB ?? [], 'W0N2')?.progress ?? 0) > (controllerOf(first.roomB ?? [], 'W0N2')?.progress ?? 0));
      check('multi-room spawns creeps in both rooms', (report.multiRoomBirths?.W0N1 ?? 0) >= 1 && (report.multiRoomBirths?.W0N2 ?? 0) >= 1);
      check('multi-room keeps logistics task memory isolated per room', ['W0N1', 'W0N2'].every(room => Object.keys(namespaces[room] ?? {}).some(id => id.startsWith('haul:'))));
    }
    report.status = 'passed';
  } else if (trafficProbe) {
    const first = report.ticks[0].objects;
    check('opposing moves swap in the real engine', first.find(o => o.name === 'SwapA').x === 21 && first.find(o => o.name === 'SwapB').x === 20);
    check('no repeated move after intent flush', report.ticks.at(-1).objects.find(o => o.name === 'SwapA').x === 21);
    check('stationary occupant blocks the whole dependency chain', first.find(o => o.name === 'ChainA').x === 20 && first.find(o => o.name === 'ChainB').x === 21);
    const cleared = report.ticks[3].objects;
    check('chain resumes when the blocking occupant departs', cleared.find(o => o.name === 'ChainA').x === 21 && cleared.find(o => o.name === 'ChainB').x === 22 && cleared.find(o => o.name === 'Blocker').x === 23);
    report.status = 'passed';
  } else if (trafficRecovery) {
    const memory = report.ticks.at(-1).memory.trafficRecovery;
    const last = memory.positions.at(-1);
    const exit = memory.positions.findIndex(row => row.t >= 40 && row.b[1] === 18);
    check('blocker departs through the pocket mouth after release', exit >= 0 && last.b[0] === 31 && last.b[1] === 16);
    const passed = memory.positions.findIndex((row, index) => index >= exit && row.w[0] === 31 && row.w[1] === 19);
    check('corridor worker follows the blocker through the pocket', passed >= exit && last.w[0] === 31 && last.w[1] === 20);
    const bounded = memory.states.flatMap(row => [row.w, row.b, row.s].filter(Boolean)).every(state => state.stuck <= 20 && state.failures <= 6 && state.wait <= 100);
    check('traffic backoff waits and failures stay bounded', bounded);
    check('sealed target never moves the creep into the enclosure', memory.positions.every(row => !(row.s[0] === 40 && row.s[1] === 25)));
    const sealedStates = memory.states.filter(row => row.s);
    check('sealed target retries after bounded backoffs', sealedStates.length > 0 && Math.max(...sealedStates.map(row => row.s.failures)) >= 2);
    report.status = 'passed';
  } else if (economyProbe) {
    check('economy graph records spawn and build tasks alongside hauls', report.economy.spawnSeen && report.economy.buildSeen);
    check('cross-kind dependency is recorded and blocks the haul', report.economy.crossKind);
    check('cross-kind dependency releases within the wait limit', report.economy.released);
    report.status = 'passed';
  } else if (lifecycle) {
    if (persistentFailure) {
      check('third dependency failure stops new logistics leases through scenario end', report.persistentFault && report.ticks.at(-1).memory.creeps[report.persistentFault.name].logisticsRecovery.reason === 'dependency-cycle');
      check('stopped logistics worker continues settled resource actions', report.persistentFault.actions >= 2);
    }
    if (maintenanceProbe) {
      const lastObjects = report.ticks.at(-1).objects;
      const [dcX, dcY] = report.maintenance.damagedContainer;
      const hitsSeries = report.ticks.map(t => t.objects.find(o => o.type === 'container' && o.x === dcX && o.y === dcY)?.hits).filter(h => h !== undefined);
      // Decay can only subtract; exceeding the seeded hits is direct evidence of repair.
      check('repair restores the damaged income container above its seeded hits', hitsSeries.some(h => h > report.maintenance.seededHits));
      check('damaged container survives the full window', lastObjects.some(o => o.type === 'container' && o.x === dcX && o.y === dcY && o.hits > 0));
      // Slot isolation: with 4 workers, repair(1) + build(1) leaves the 2-worker
      // economy floor; miners are out of scope here, so only assert the fixtures
      // this probe owns — container-energy assertions belong to test:logistics.
      const fixtureSite = lastObjects.find(o => o.type === 'constructionSite' && o.x === 15 && o.y === 16);
      const builtExtension = lastObjects.some(o => o.type === 'extension' && o.x === 15 && o.y === 16);
      check('generalized builders make progress on the legacy extension site', (fixtureSite?.progress ?? 0) > 0 || builtExtension);
      const ringPlacements = lastObjects.filter(o => o.structureType === 'extension' && (o.type === 'constructionSite' || o.type === 'extension') && !(o.x === 15 && o.y === 16));
      check('planner places extension sites around the spawn at RCL2', ringPlacements.length >= 1);
      // The empty legacy container sits below the urgent line from seed to end;
      // any extension progress during the window proves it never preempted.
      const legacySeries = report.ticks.map(t => t.objects.find(o => o.type === 'container' && o.x === 20 && o.y === 44)?.hits).filter(h => h !== undefined);
      const legacyBelowUrgent = legacySeries.some(h => h < report.maintenance.legacySeededHits * 1.25);
      check('construction advances while an empty legacy container sits below the urgent line',
        legacyBelowUrgent && ((fixtureSite?.progress ?? 0) > 0 || builtExtension));

    }
    if (defenseProbe) {
      const series = (type, name) => report.ticks
        .map(t => t.objects.find(o => o.type === type && o.name === name))
        .filter(o => o !== undefined)
        .map(o => o.hits);
      // Tower volleys subtract hits; decay never adds. Rising above the seed is
      // impossible for the raider, so any drop below it proves the tower fired.
      check('tower attacks the armed raider', series('creep', 'Raider').some(h => h < report.defense.raiderHits));
      const towerSeries = report.ticks
        .map(t => t.objects.find(o => o.type === 'tower')?.store?.energy)
        .filter(h => h !== undefined);
      check('tower spends energy on defense', towerSeries.some(h => h < 1000));
      check('tower heal lifts the wounded worker', series('creep', 'Wounded').some(h => h > report.defense.woundedHits));
      check('no friendly fire from the tower', Math.min(...series('creep', 'Wounded')) >= report.defense.woundedHits);
    }
    if (minersProbe) {
      const last = report.ticks.at(-1);
      const miner = last.objects.find(o => o.type === 'creep' && o.user === bot.id && o.name?.startsWith('miner-'));
      check('dedicated 5-WORK miner spawns from surplus at RCL3 capacity',
        report.miners.spawned !== undefined && miner !== undefined && (miner.body ?? []).filter(p => p.type === 'work').length === 5);
      check('miner parks on the source container', report.miners.parked !== undefined);
      check('miner harvests into the container economy', report.miners.harvested !== undefined);
      const minerSource = miner ? last.memory.creeps?.[miner.name]?.minerSource : undefined;
      check('generic miner claim yields dedicated sources',
        minerSource !== undefined && !Object.entries(last.memory.creeps ?? {}).some(([n, m]) => n.startsWith('worker-') && m.minerSource === minerSource));
      check('worker floor holds beside the dedicated miner',
        last.objects.filter(o => o.type === 'creep' && o.name?.startsWith('worker-')).length >= 4);
    }
    if (claimProbe) {
      // 出生证据走 memory:预定者离房快,200 tick 快照点读等价掷硬币
      // (台账同款教训:容器存量/RCL2 检查点均已改窗口/记忆证据)。
      check('claimer spawned for the evaluated target',
        Object.keys(report.ticks.at(-1).memory.creeps ?? {}).some(n => n.startsWith('claimer-')));
      // 快照只含母房对象;跨房证据走 memory:预定者必须身在 W0N2 才能
      // 重观测并下预定,reserver 记录同时覆盖"进房"与"预定成功"。
      const claimIntel = report.ticks.at(-1).memory.intel?.rooms ?? {};
      check('claimer entered the neutral target room and refreshed intel',
        (claimIntel.W0N2?.observedAt ?? 1) > 1);
      check('neutral controller reservation established and observed',
        claimIntel.W0N2?.controller?.reserver === 'M0' && (claimIntel.W0N2?.controller?.reservationTicks ?? 0) > 0);
    }
    if (pioneerProbe) {
      check('pioneer spawned for the reserved target',
        report.ticks.some(t => t.objects.some(o => o.type === 'creep' && o.name?.startsWith('pioneer-'))));
      // 母房无第二个能量来源:远矿工人在母房带货即完成跨房采矿-回运闭环。
      check('pioneer returned home carrying remote energy',
        report.ticks.some(t => t.objects.some(o => o.type === 'creep' && o.name?.startsWith('pioneer-') && (o.store?.energy ?? 0) > 0)));
      check('pioneer delivered remote energy into the home economy',
        (report.ticks.at(-1).memory.intel?.pioneerDelivered ?? 0) > 0);
    }
    if (intelProbe) {
      const rooms = report.ticks.at(-1).memory.intel?.rooms ?? {};
      check('scout spawned for neighbor recon', report.intel?.scoutSpawned !== undefined);
      check('scout entered the neutral neighbor room', report.intel?.entered !== undefined);
      check('neutral room intel records both sources with an observation tick',
        rooms.W0N2?.sources?.length === 2 && typeof rooms.W0N2.observedAt === 'number');
      check('neutral room intel records no false ownership', rooms.W0N2?.controller?.owner === undefined && (rooms.W0N2?.threat?.hostiles ?? -1) === 0);
      const evaluation = report.ticks.at(-1).memory.intel?.evaluation;
      check('evaluation selects the sourced neutral room as the remote target',
        evaluation?.targets?.[0]?.name === 'W0N2' && evaluation.targets[0].sources === 2 && evaluation.targets[0].distance === 1);
      check('evaluation board carries no barren rooms',
        (evaluation?.targets ?? []).every(t => (rooms[t.name]?.sources ?? []).length > 0));
    }
    report.lifecycle = { births, delivered, maxEmptyRun, maxControllerIdle };
    if (logistics) check('controller service resumes within 400 ticks with three workers', maxControllerIdle <= 400);
    check('population established or replaced', recovery || logistics ? births >= 4 : births >= 8);
    check('controller makes sustained progress', delivered > (recovery || logistics ? 100 : 1000));
    // The two-worker economy floor cannot also cover repair + build slots; the
    // maintenance probe owns its own fixture assertions instead.
    // The progression probe drains containers into tower/storage construction;
    // container stock is asserted by the plain logistics run instead.
    // 容器库存按时间窗判定:供应容器会被搬运链路持续抽空(oscillate 0~N),
    // 末帧点读等价于掷硬币(台账 2026-09-17:同行为两跑 2 vs 0 能量)。改为
    // 后半程任一快照各源容器曾有能量——对"矿工从未交付"是更严格的真实证据。
    if (logistics && !maintenanceProbe && !progressionProbe) {
      const late = report.ticks.slice(Math.floor(report.ticks.length / 2));
      const containers = report.ticks.at(-1).objects.filter(o => o.type === 'container');
      const delivered = (x, y) => late.some(t => t.objects.some(o => o.type === 'container' && o.x === x && o.y === y && (o.store?.energy ?? 0) > 0));
      check('both source containers receive harvested energy', containers.length >= 2 && containers.every(c => delivered(c.x, c.y)));
    }
    if (logisticsRecovery) check('actual deliveries resume after dependency recovery', report.ticks.at(-1).memory.logisticsDelivered > report.cycleInjection.deliveredBefore);
    check('production population remains present', maxEmptyRun <= 60);
    check('heartbeat completed', report.ticks.at(-1).memory.bootstrap?.heartbeat >= tickCount);
    check('no isolated runtime errors', report.ticks.at(-1).memory.bootstrap?.errors.length === 0);
    report.status = 'passed';
  } else {
  const rows = report.ticks.map((tick) => tick.objects.find((object) => object.name === 'Probe'));
  const memory = report.ticks.at(-1).memory;
  check('physics probe executed every tick', memory.probe?.length === 6);
  check('harvest accepted but not applied synchronously', memory.probe[0].harvest === 0 && memory.probe[0].immediateEnergy === 0);
  check('harvest settled in engine', rows[0].store.energy === 2);
  check('RCL1 rejects extension construction', memory.probe[0].limit === -14);
  check('container limit is 5 at RCL2', memory.probe[0].containers[2] === 5);
  check('loaded creep enters swamp and gains fatigue', rows[1].x === 21 && rows[1].fatigue > 0);
  check('fatigue prevents next movement', rows[2].x === 21);
  check('owned extension site blocks accepted move intent', memory.probe[3].siteMove === 0 && rows[3].x === 14);
  check('owned road site allows movement', rows[4].x === 15 && rows[4].y === 16);
  if (fixture.variants[variant].legacyAssets) {
    check('legacy assets remain present', report.ticks.at(-1).objects.some((object) => object.name === 'LegacyWorker'));
    check('fixture memory preserved', variant === 'no-memory' ? !memory.creeps?.LegacyWorker?.role : memory.creeps.LegacyWorker.role === 'old-builder');
  }
  check('injected assertion validates failure reporting', !injectFailure);
  report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  if (bot) report.notifications = await bot.notifications.catch(() => []);
  process.exitCode = 1;
} finally {
  save();
  server.stop();
  console.log(`[scenario] ${report.status}: ${report.checks.filter((item) => item.passed).length} checks; ${output}/report.json`);
  if (report.error) console.error(report.error);
  // Mockup storage has no complete shutdown API.
  process.exit(process.exitCode ?? 0);
}
