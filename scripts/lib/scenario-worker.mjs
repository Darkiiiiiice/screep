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
const remoteProbe = args.includes('--remote-probe');
const colonizeProbe = args.includes('--colonize-probe');
const combatProbe = args.includes('--combat-probe');
assert(!combatProbe || lifecycle && logistics && !construction && !fairnessProbe, '--combat-probe requires --lifecycle --logistics');
const storageProbe = args.includes('--storage-probe');
assert(!storageProbe || lifecycle && logistics && !construction && !fairnessProbe, '--storage-probe requires --lifecycle --logistics');
const linksProbe = args.includes('--links-probe');
assert(!linksProbe || lifecycle && logistics && !construction && !fairnessProbe, '--links-probe requires --lifecycle --logistics');
const labsProbe = args.includes('--labs-probe');
const marketProbe = args.includes('--market-probe');
const factoryProbe = args.includes('--factory-probe');
const squadProbe = args.includes('--squad-probe');
const raidProbe = args.includes('--raid-probe');
const assaultProbe = args.includes('--assault-probe');
const siegeProbe = args.includes('--siege-probe');
const kiteProbe = args.includes('--kite-probe');
const stalemateProbe = args.includes('--stalemate-probe');
const mineralProbe = args.includes('--mineral-probe');
const linkplaceProbe = args.includes('--linkplace-probe');
assert(!linkplaceProbe || lifecycle && logistics && !construction && !fairnessProbe, '--linkplace-probe requires --lifecycle --logistics');
assert(!mineralProbe || lifecycle && logistics && !construction && !fairnessProbe, '--mineral-probe requires --lifecycle --logistics');
assert(!labsProbe || lifecycle && logistics && !construction && !fairnessProbe, '--labs-probe requires --lifecycle --logistics');
assert(!marketProbe || labsProbe, '--market-probe requires --labs-probe (market rides the labs fixture)');
assert(!factoryProbe || labsProbe, '--factory-probe requires --labs-probe (factory rides the labs fixture)');
assert(!squadProbe || combatProbe, '--squad-probe requires --combat-probe (squad rides the combat fixture)');
assert(!raidProbe || marketProbe, '--raid-probe requires --market-probe (raid rides the market fixture with its W0N2 + npc user)');
assert(!assaultProbe || lifecycle && logistics, '--assault-probe requires --lifecycle --logistics');
assert(!siegeProbe || assaultProbe, '--siege-probe requires --assault-probe (siege rides the assault fixture)');
assert(!kiteProbe || assaultProbe, '--kite-probe requires --assault-probe (kite rides the assault fixture)');
assert(!stalemateProbe || assaultProbe, '--stalemate-probe requires --assault-probe');
assert(!(stalemateProbe && siegeProbe), '--stalemate-probe and --siege-probe are mutually exclusive (both seed W0N2 structures)');
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
assert(!remoteProbe || lifecycle && logistics && !construction && !fairnessProbe && !progressionProbe && !intelProbe && !minersProbe && !claimProbe, '--remote-probe requires --lifecycle --logistics');
assert(!colonizeProbe || lifecycle && logistics && !construction && !fairnessProbe && !progressionProbe && !intelProbe && !minersProbe && !claimProbe && !remoteProbe, '--colonize-probe requires --lifecycle --logistics');
const tickCount = trafficRecovery ? 120 : fairnessProbe ? 600 : lifecycle ? (construction ? 3100 : progressionProbe ? 5500 : minersProbe ? 300 : claimProbe ? 600 : colonizeProbe ? 2400 : combatProbe ? 1200 : storageProbe ? 1200 : linksProbe ? 600 : linkplaceProbe ? 1500 : mineralProbe ? 2400 : assaultProbe ? 3000 : raidProbe ? 3000 : labsProbe ? 2400 : remoteProbe ? 1500 : intelProbe ? 1500 : recovery || logistics ? 600 : 3100) : 6;
const variant = args.find((arg) => !arg.startsWith('--')) ?? 'fresh';
assert(fixture.variants[variant], `unknown variant: ${variant}`);
const injectFailure = args.includes('--inject-failure');
const output = resolve('artifacts/scenarios', `${variant}-${Date.now()}-${process.pid}`);
mkdirSync(output, { recursive: true });
const bundle = readFileSync('dist/main.js', 'utf8');
const report = {
  variant, fixture, bundleHash: createHash('sha256').update(bundle).digest('hex'),
    logistics, construction, logisticsRecovery, persistentFailure, trafficProbe, trafficRecovery, fairnessProbe, economyProbe, populationPressure, cpuStress, multiRoom, maintenanceProbe, defenseProbe, combatProbe, storageProbe, linksProbe, linkplaceProbe, mineralProbe, labsProbe, marketProbe, factoryProbe, squadProbe, raidProbe, assaultProbe, siegeProbe, kiteProbe, stalemateProbe, tickCount,
  node: process.version,
    logistics, construction, logisticsRecovery, persistentFailure, trafficProbe, trafficRecovery, fairnessProbe, economyProbe, populationPressure, cpuStress, multiRoom, maintenanceProbe, defenseProbe, progressionProbe, intelProbe, combatProbe, storageProbe, linksProbe, linkplaceProbe, mineralProbe, labsProbe, marketProbe, factoryProbe, squadProbe, raidProbe, assaultProbe, siegeProbe, kiteProbe, stalemateProbe, tickCount,
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
  // colonize-probe 需要 GCL2(1e6 分起)才有第二房占领名额;gcl 字段是点数不是等级。
  bot = await server.world.addBot({ username: 'M0', room: fixture.room, x: fixture.spawn[0], y: fixture.spawn[1], ...(colonizeProbe ? { gcl: 2e6 } : {}), modules: trafficRecovery ? { main: trafficRecoveryMain, traffic: trafficBundle } : trafficProbe ? { main: trafficMain, traffic: trafficBundle } : fairnessProbe ? { main: bundle } : lifecycle ? { main: bundle } : { main: probe, app: 'module.exports.loop = function() {}' } });
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
  if (combatProbe) {
    // RCL3 + 低能塔:守卫孵化门与驱动的引擎级回归。塔只有 200 能量(约
    // 3000 伤害),单塔杀不死 5000 HP 的重装 raider——耗尽后守卫门开票接管,
    // 断言:守卫自动出生→歼敌→清场后不无限增员。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 3, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'tower', 24, 24, {
      user: bot.id, store: { energy: 200 }, energy: 200, energyCapacity: 1000, hits: 3000, hitsMax: 3000,
    });
    report.combat = { tower: [24, 24], wave1At: 600, wave2At: 850, towerCap: 200 };
  }
  if (storageProbe) {
    // RCL4 + 预置 storage(M6-1 storage 调度与保底):两阶段——①t500 断矿
    // (杀矿工+拆容器+杀 3 工人逼出孵化缺口):搬运链必须从 storage 补货喂
    // spawn,补员不中断;②t900 冻结全场(spawn/扩展/塔满、无工地、storage
    // 恰好压在保底线上):产业取能(升级/建造/维修)不得击穿保底。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 4, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 5000 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
        store: { energy: 0 }, storeCapacity: 2000, hits: 50000, hitsMax: 250000, nextDecayTime: 500,
      });
    }
    report.storage = { storageAt: [24, 22], seed: 5000, floor: 1000, cutAt: 500, freezeAt: 900 };
  }
  if (linksProbe) {
    // RCL5 + 预置 link 对(M6-2 调拨;布局放置属 M6-3):源 link(源旁 2 环内,
    // 满仓 800)必须被 driveLinks 半仓阈值一发打到中枢,扣除 3% 引擎损耗后
    // 中枢入仓 776;搬运链随后把中枢能量喂进基地。断言单向性:源 link 清零
    // 后绝不回流,中枢峰值被损耗上界封顶。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 5, progress: 0 } });
    const [sx, sy] = fixture.sources[0];
    await server.world.addRoomObject(fixture.room, 'link', sx + 2, sy, {
      user: bot.id, store: { energy: 800 }, storeCapacityResource: { energy: 800 }, cooldown: 0, hits: 1000, hitsMax: 1000,
    });
    await server.world.addRoomObject(fixture.room, 'link', 26, 22, {
      user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 800 }, cooldown: 0, hits: 1000, hitsMax: 1000,
    });
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    report.links = { sourceAt: [sx + 2, sy], hubAt: [26, 22], seed: 800, expectedArrival: 776 };
  }
  if (linkplaceProbe) {
    // RCL5 + storage 预置(无 link):规划器必须自主走完 源链→中枢 布局——
    // 源链贴源(2 环内)贴容器(1 环内,接矿工外溢),中枢贴 storage(2 环内,
    // 接搬运取能),并建成为 owned(M6-3 全链:放置→施工→调拨就绪)。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 5, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 2000, U: 600, H: 600 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
        store: { energy: 0 }, storeCapacity: 2000, hits: 50000, hitsMax: 250000, nextDecayTime: 500,
      });
    }
    report.linkplace = { storageAt: [24, 22], cap: 2 };
    // 预置 5 扩展(RCL5 首批线外,喂孵化容量与建造产能,避开源/中枢选点 box)。
    for (const [x, y] of [[20, 25], [30, 25], [25, 19], [19, 25], [31, 25]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, {
        user: bot.id, store: { energy: 0 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000,
      });
    }
  }
  if (mineralProbe) {
    // RCL6 + storage 预置(无 terminal/extractor/link):产业线必须自主走完
    // 链尾三站——link(RCL6 cap 3)→terminal(贴 storage 2 环)→extractor
    // (落矿体本身);随后 mharvester 自孵(第六顺位盈余),挖矿直送 terminal。
    // 孵化容量靠预置 10 扩展(300+10×50=800≥650)。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 6, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 2000, U: 600, H: 600 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
        store: { energy: 0 }, storeCapacity: 2000, hits: 50000, hitsMax: 250000, nextDecayTime: 500,
      });
    }
    for (const [x, y] of [[20, 25], [30, 25], [25, 19], [19, 25], [31, 25], [20, 20], [28, 28], [21, 27], [27, 20], [29, 24]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, {
        user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000,
      });
    }
    await server.world.addRoomObject(fixture.room, 'mineral', 30, 20, {
      mineralType: 'U', mineralAmount: 50000, density: 4,
    });
    report.mineral = { mineralAt: [30, 20], storageAt: [24, 22] };
  }
  if (labsProbe) {
    // RCL6 全产业起步(无 terminal/extractor/link/lab):产业线自主走完
    // 链尾四站 link(3)→terminal→extractor→lab(3),mharvester 自孵后
    // 兼任实验室取送;terminal 预置 U+H 双输入(单矿房间第二输入等市场),
    // 反应链在输出 lab 产出 UH。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 6, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 2000, U: 600, H: 600 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', x + 1, y, {
        store: { energy: 0 }, storeCapacity: 2000, hits: 50000, hitsMax: 250000, nextDecayTime: 500,
      });
    }
    for (const [x, y] of [[20, 25], [30, 25], [25, 19], [19, 25], [31, 25], [20, 20], [28, 28], [21, 27], [27, 20], [29, 24]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, {
        user: bot.id, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000,
      });
    }
    await server.world.addRoomObject(fixture.room, 'mineral', 30, 20, {
      mineralType: 'U', mineralAmount: 50000, density: 4,
    });
    await server.world.addRoomObject(fixture.room, 'terminal', 23, 23, {
      user: bot.id, store: { energy: 3000, U: 600, H: 600 }, storeCapacityResource: { energy: 30000 }, hits: 3000, hitsMax: 3000, cooldown: 0,
    });
    report.labsProbeState = { mineralAt: [30, 20], terminalAt: [23, 23] };
  }
  if (factoryProbe) {
    // RCL7 压条站:labs(6)+tower(6) 直接预置满 cap(本刀聚焦压条本体,
    // 不让 12 站施工吃掉窗口),chain 只剩 factory 段可走——factory 由
    // growth 链自主落位(terminal 4 环),courier 喂矿,driveFactory 压条。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 7, progress: 0 } });
    await db['rooms.objects'].update({ type: 'terminal', room: fixture.room }, { $set: { store: { energy: 6000, U: 2000, H: 600 } } });
    for (const [x, y] of [[22, 22], [22, 23], [22, 24], [23, 22], [24, 23], [24, 24]]) {
      await server.world.addRoomObject(fixture.room, 'lab', x, y, { user: bot.id, store: {}, storeCapacityResource: { energy: 2000 }, hits: 3000, hitsMax: 3000, cooldown: 0 });
    }
    for (const [x, y] of [[19, 19], [27, 27], [27, 19], [19, 27], [15, 23], [31, 23]]) {
      // 塔预置满(storage-probe t900 冻结判例):空塔的一次性 6000 灌填会把
      // 冷启动经济的补员窗口(补员优先闸)整个吃掉,miner/mharv 永不开票。
      await server.world.addRoomObject(fixture.room, 'tower', x, y, { user: bot.id, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 }, hits: 3000, hitsMax: 3000 });
    }
  }
  if (marketProbe) {
    // 造市:邻室 W0N2 放 NPC terminal(持 H、有能量、容量留白),db['market.orders']
    // 挂两单——买 UH(1.5 credits)与卖 H(0.5 credits;库价 ×1000 存放,读回 /1000)。
    // home terminal 预置 UH 600(> 400 卖出门槛)与 H 30(< 60 买入触发);
    // lab→terminal 搬运腿受 mockup withdraw 怪癖所限,留真机验证。
    await server.world.addRoom('W0N2');
    await server.world.setTerrain('W0N2', new TerrainMatrix());
    await db.users.insert({ _id: 'npc-market', username: 'npc-market', money: 2000000 });
    await server.world.addRoomObject('W0N2', 'terminal', 25, 25, {
      user: 'npc-market', store: { energy: 20000, H: 2000 }, storeCapacity: 30000, hits: 3000, hitsMax: 3000,
    });
    await db['market.orders'].insert([
      { _id: 'order-buy-uh', created: 0, user: 'npc-market', active: true, type: 'buy', resourceType: 'UH', price: 1500, amount: 5000, remainingAmount: 5000, totalAmount: 5000, roomName: 'W0N2' },
      { _id: 'order-sell-h', created: 0, user: 'npc-market', active: true, type: 'sell', resourceType: 'H', price: 500, amount: 2000, remainingAmount: 2000, totalAmount: 2000, roomName: 'W0N2' },
    ]);
    await db['rooms.objects'].update({ type: 'terminal', room: fixture.room }, { $set: { store: { energy: 3000, U: 600, H: 30, UH: 600 }, storeCapacity: 30000 } });
    await db.users.update({ _id: bot.id }, { $set: { money: 0 } });
  }
  if (raidProbe) {
    // 拆预留远征:W0N2 控制器挂 npc 预定(CLAIM 寿命 600 => 接力拆)。
    // 邻环全量落位:mock 原生寻路对"无地形条目"的邻房直接抛错
    // (claim 夹具判例,scout 会把缺地形的房标记不可达)——W0N2 本体由
    // market 夹具已建,这里补齐其余七邻。
    for (const name of ['W1N1', 'W1N0', 'W1N2', 'W0N0', 'E0N1', 'E0N0', 'E0N2']) {
      await server.world.addRoom(name);
      await server.world.setTerrain(name, new TerrainMatrix());
    }
    await server.world.addRoomObject('W0N2', 'controller', 25, 40, {
      user: null, level: 0, reservation: { user: 'npc-market', endTime: 5000 }, ticksToEnd: 5000,
    });
    // 榜单硬过滤 sources>=1(远矿/殖民同一条候选管线):W0N2 需要真矿体。
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    // intel 直种(scout 在重载探针经济里不可靠):W0N2 被占、余量 5000。
    // 自然衰减到 t3000 剩 2000——终帧余量 < 2000 即为剥离证据(剥 1 tick/次)。
    const env = server.common.storage.env;
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({
      logisticsEnabled: true,
      intel: { schema: 1,
        rooms: { W0N2: { observedAt: 0, sources: [{ id: 's1', x: 20, y: 20 }, { id: 's2', x: 30, y: 30 }], threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'npc-market', reservationTicks: 5000 } } },
        distances: { W0N2: 1 },
      },
    }));
  }
  if (assaultProbe) {
    // M7-6 突袭小队:W0N2 被武装外人蹲守(无塔/无主/有源),暖启动母房。
    // 编成 3 攻击手+2 医疗;母房只把门不对抗(守家夹具不叠加,威胁全在邻房)。
    // M7-7 强化链:boostCreep 有 RCL<6 实验室不可用门槛(ERR_RCL_NOT_ENOUGH),
    // 母房升 RCL6+terminal(掐掉 growth 链的 terminal 工地)+三 lab 簇——
    // 双输入 H/U 直种、输出 lab 持能,三件 id 序分配(引擎"id 序前两输入末输出"
    // 约定,任一件排第三都几何合法:三角两两距离 ≤2)。
    await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 6, progress: 0 } });
    await server.world.addRoomObject(fixture.room, 'terminal', 23, 23, {
      user: bot.id, store: { energy: 3000, U: 600, H: 600 }, storeCapacityResource: { energy: 30000 }, hits: 3000, hitsMax: 3000, cooldown: 0,
    });
    for (const [x, y] of [[24, 15], [26, 15], [25, 16]]) {
      await server.world.addRoomObject(fixture.room, 'lab', x, y, { user: bot.id, store: {}, hits: 3000, hitsMax: 3000, cooldown: 0 });
    }
    // storage+link 直种(RCL6 段位即满):掐掉 growth 链的工地源——否则 11+ 工地
    // 让 builder(先于战争顺位)反复开票,集结期医疗 600 等不齐(红跑实证抖动源)。
    await server.world.addRoomObject(fixture.room, 'storage', 24, 22, {
      user: bot.id, store: { energy: 5000 }, storeCapacityResource: { energy: 30000 }, hits: 10000, hitsMax: 10000,
    });
    for (const [x, y] of [[12, 12], [38, 12], [25, 33]]) {
      await server.world.addRoomObject(fixture.room, 'link', x, y, { user: bot.id, store: {}, storeCapacityResource: { energy: 800 }, hits: 1000, hitsMax: 1000, cooldown: 0 });
    }
    const boostLabs = (await db['rooms.objects'].find({ type: 'lab', room: fixture.room })).sort((a, b) => String(a._id).localeCompare(String(b._id)));
    await db['rooms.objects'].update({ _id: boostLabs[0]._id }, { $set: { store: { H: 1000 }, storeCapacityResource: { energy: 2000, H: 3000 } } });
    await db['rooms.objects'].update({ _id: boostLabs[1]._id }, { $set: { store: { U: 1000 }, storeCapacityResource: { energy: 2000, U: 3000 } } });
    // 输出 lab 不预置能量:强化供能全靠 M7-7 sink 腿(muster 期 lab 入能量
    // sink)现送——预置满能会把"有料无电"缺口整个掩盖(评审实证)。
    await db['rooms.objects'].update({ _id: boostLabs[2]._id }, { $set: { storeCapacityResource: { energy: 2000, UH: 3000 } } });
    var assaultInputLabIds = [String(boostLabs[0]._id), String(boostLabs[1]._id)];
    // RCL6 满编 20 扩展满能(缓冲 2300):小队 390/600 串行孵化跨 ~1500t,
    // 缓冲不足会让第 2 医疗 600 永远等不齐(集结超时假撤)。
    for (const [x, y] of [[20, 25], [30, 25], [25, 19], [19, 25], [31, 25], [20, 20], [28, 28], [21, 27], [27, 20], [29, 24], [18, 18], [22, 17], [28, 17], [32, 18], [17, 22], [33, 22], [17, 28], [33, 28], [22, 32], [28, 32]]) {
      await server.world.addRoomObject(fixture.room, 'extension', x, y, { user: bot.id, store: { energy: 100 }, storeCapacityResource: { energy: 100 }, hits: 1000, hitsMax: 1000 });
    }
    await db['rooms.objects'].update({ type: 'spawn', room: fixture.room }, { $set: { store: { energy: 300 }, energy: 300 } });
    for (const [i, [x, y]] of [[20, 20], [22, 22], [28, 28], [24, 20], [20, 24], [28, 24]].entries()) {
      await server.world.addRoomObject(fixture.room, 'creep', x, y, {
        user: bot.id, name: `worker-seeded-${i}`, body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
        hits: 300, hitsMax: 300, store: { energy: 0 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 4000, actionLog: {},
      });
    }
    await server.world.addRoom('W0N2');
    await server.world.setTerrain('W0N2', new TerrainMatrix());
    // 邻环全量落位(raid/claim 夹具判例):mock 原生寻路对无地形条目的邻房
    // 直接抛 Could not load terrain data——行军/撤退路径缓冲触邻即炸。
    for (const name of ['W1N1', 'W1N0', 'W1N2', 'W0N0', 'E0N1', 'E0N0', 'E0N2']) {
      await server.world.addRoom(name);
      await server.world.setTerrain(name, new TerrainMatrix());
    }
    await server.world.addRoomObject('W0N2', 'controller', 25, 40, { user: null, level: 0 });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    // intel 直种(W0N2 武装 2,新鲜)+ assault 开关。logisticsEnabled/schema 两个
    // 隐藏闸照抄 raid 夹具判例。
    const env = server.common.storage.env;
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({
      logisticsEnabled: true,
      assaultEnabled: true,
      intel: { schema: 1,
        rooms: { W0N2: { observedAt: 0, sources: fixture.sources.map(([x, y], i) => ({ id: `s${i}`, x, y })), threat: { hostiles: 2, armed: 2, towers: 0, keeperLairs: 0, structures: (siegeProbe || stalemateProbe) ? 3 : 0 }, controller: { level: 0 } } },
        distances: { W0N2: 1 },
      },
    }));
    const siegeSpawnHits = stalemateProbe ? 300000000 : 5000;
    if (siegeProbe || stalemateProbe) {
      // M7-8 围攻:W0N2 摆敌建筑群——spawn(5000)+压顶 rampart(9000)+extension
      // (1000),共 15000 hits ≈ 200/tick 裸拆 75t。rampart 种子给足:自然衰减
      // 3/tick(RAMPART_DECAY 300/100t)到窗口末(3000)恰归零——断言"早于 2500
      // 消失"即可排除自然衰减假绿。敌属主与蹲守者同('2')。
      await server.world.addRoomObject('W0N2', 'spawn', 30, 30, {
        user: '2', name: 'SiegeSpawn', store: { energy: 300 }, storeCapacityResource: { energy: 300 }, hits: siegeSpawnHits, hitsMax: siegeSpawnHits,
      });
      await server.world.addRoomObject('W0N2', 'rampart', 30, 30, { user: '2', hits: 9000, hitsMax: 9000 });
      await server.world.addRoomObject('W0N2', 'extension', 28, 32, {
        user: '2', store: {}, storeCapacityResource: { energy: 50 }, hits: 1000, hitsMax: 1000,
      });
      report.siege = { spawnGoneAt: null, rampartGoneAt: null, extGoneAt: null, unrazable: stalemateProbe };
    }
    report.assault = { target: 'W0N2', squatters: ['Squatter-1', 'Squatter-2'], minHits: 2000, clearedAt: null, phases: {}, uhPeak: 0, uhBoosted: 0, inputLabEnergyPeak: 0, inputLabIds: assaultInputLabIds };
    if (kiteProbe) report.kite = { rangerSpawned: false, rangerMinHits: null, contactAt: null, bandMin: null, bandDone: false };
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
  if (remoteProbe) {
    // 远程机组切片:claim 同款经济底座;W0N2 预置我方有效预定(引擎对象 +
    // 情报双写)→ 预定者需求落空,矿工+搬运工依次上场,跑蹲采-掉落-回运闭环。
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
    // 情报里的源坐标写真实坐标:矿工按 sources[0] 直奔源点。
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true, intel: { schema: 1, rooms: { W0N2: { observedAt: 1, sources: fixture.sources.map(([x, y], i) => ({ id: `seeded-${i}`, x, y })), threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'M0', reservationTicks: 4000 } } }, distances: { W0N2: 1 } } }));
    report.remote = { room: 'W0N2' };
  }
  if (colonizeProbe) {
    // 殖民者切片:claim 同款经济底座(RCL3+8 满能 ext+6 工人);W0N2 预置
    // 我方富预定(引擎对象+情报双写,4000≥刷新线)→ 预定者让位;自留预定
    // 不挡殖民榜,M5 门禁锁定榜首。GCL2 由 addBot 注入(2e6 分)。
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
    await server.world.addRoomObject('W0N2', 'controller', 10, 12, { level: 0, reservation: { user: bot.id, endTime: 100000 } });
    for (const [x, y] of fixture.sources) {
      await server.world.addRoomObject('W0N2', 'source', x, y, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 301 });
    }
    // 封死施工排水口(remote 探针同款教训):双容器+塔预置(RCL3 塔上限 1)→
    // 无工地,盈余才攒得到 650;否则工地把能量钉死在低位,colonizer 永不上场。
    for (const [sx, sy] of fixture.sources) {
      await server.world.addRoomObject(fixture.room, 'container', sx + 1, sy, { store: { energy: 1500 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 100000 });
    }
    await server.world.addRoomObject(fixture.room, 'tower', 24, 25, { user: bot.id, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 }, hits: 3000, hitsMax: 3000 });
    // 预置满编远程机组(矿工蹲 W0N2 源点+3 搬运工)→ 机组门禁全满,colonizer
    // 是 650 的唯一竞争者。否则第四顺位排在机组(550+400×3)之后,孵化时刻
    // 被 mock CPU 混沌放大漂移(矩阵负载下实测认领落点 805→870),窗口变剃刀。
    await server.world.addRoomObject('W0N2', 'creep', fixture.sources[0][0] + 1, fixture.sources[0][1], {
      user: bot.id, name: 'rminer-seeded', body: [...Array(5).fill({ type: 'work', hits: 100 }), { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
      hits: 700, hitsMax: 700, store: { energy: 0 }, storeCapacity: 50, fatigue: 0, spawning: false, ageTime: 1500, actionLog: {},
    });
    for (const [i, [x, y]] of [[22, 22], [28, 28], [24, 20]].entries()) {
      await server.world.addRoomObject(fixture.room, 'creep', x, y, {
        user: bot.id, name: `rhauler-seeded-${i}`, body: [...Array(4).fill({ type: 'carry', hits: 100 }), ...Array(4).fill({ type: 'move', hits: 100 })],
        hits: 800, hitsMax: 800, store: { energy: 0 }, storeCapacity: 200, fatigue: 0, spawning: false, ageTime: 1500, actionLog: {},
      });
    }
    // 情报/跳数预种子:殖民榜首评估即锁定 W0N2(自留预定 4000 让预定者让位);
    // 机组 creep 须有 memory 登记——门禁按 Game.creeps 的 memory.role 计数。
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify({ logisticsEnabled: true, creeps: { 'rminer-seeded': { role: 'remoteMiner', remoteTarget: 'W0N2', home: fixture.room }, 'rhauler-seeded-0': { role: 'remoteHauler', remoteTarget: 'W0N2', home: fixture.room }, 'rhauler-seeded-1': { role: 'remoteHauler', remoteTarget: 'W0N2', home: fixture.room }, 'rhauler-seeded-2': { role: 'remoteHauler', remoteTarget: 'W0N2', home: fixture.room } }, intel: { schema: 1, rooms: { W0N2: { observedAt: 1, sources: fixture.sources.map(([x, y], i) => ({ id: `seeded-${i}`, x, y })), threat: { hostiles: 0, armed: 0, towers: 0, keeperLairs: 0 }, controller: { level: 0, reserver: 'M0', reservationTicks: 4000 } } }, distances: { W0N2: 1 } } }));
    report.colonize = { room: 'W0N2' };
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
    if (colonizeProbe && i % 25 === 0 && !report.colonize?.sitePlacedAt) {
      const site = (await server.world.roomObjects('W0N2')).find(o => o.type === 'constructionSite' && o.structureType === 'spawn');
      if (site) {
        // 放置行为已发生(这才是断言点);建造 15000 能量是时长问题不是行为
        // 问题——中途提能到 14900 把"建成"折进窗口(与 RCL bump 同式注入)。
        report.colonize.sitePlacedAt = i;
        const { db } = server.common.storage;
        await db['rooms.objects'].update({ _id: site._id }, { $set: { progress: 14900 } });
        console.log(`[colonize] spawn site placed at tick ${i}, boosted to 14900`);
      }
    }

    // 注入窗口:引擎首启 tick(t1-2)的处理回冲会吞中途插入的对象(实证
    // 2026-09-20:insert 读回 1、单 tick 后归零;t600 注入稳定存活),故两波
    // 都放在工人地板达成(≥4 人,t~500)之后,守卫孵化门与驱动全链照常覆盖。
    if (combatProbe && i === 600 && !squadProbe) {
      await server.world.addRoomObject(fixture.room, 'creep', 34, 34, {
        user: '2', name: 'Raider-1', body: [
          ...Array.from({ length: 40 }, () => ({ type: 'attack', hits: 100 })),
          ...Array.from({ length: 10 }, () => ({ type: 'move', hits: 100 })),
        ],
        hits: 5000, hitsMax: 5000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 2101, actionLog: {},
      });
      console.log('[combat] wave one: Raider-1 (5000 hp) at (34,34)');
    }
    if (squadProbe) {
      // RCL4 + 10 扩展:治疗身体 700 需要 capacity ≥ 700(RCL3 的 300 永不开票)。
      await db['rooms.objects'].update({ type: 'controller', room: fixture.room }, { $set: { level: 4, progress: 0 } });
      for (const [x, y] of [[20, 25], [30, 25], [25, 19], [19, 25], [31, 25], [20, 20], [28, 28], [21, 27], [27, 20], [29, 24]]) {
        await server.world.addRoomObject(fixture.room, 'extension', x, y, {
          user: bot.id, store: { energy: 100 }, storeCapacityResource: { energy: 100 }, hits: 1000, hitsMax: 1000,
        });
      }
      // 暖启动(storage-probe 冻结判例):spawn+扩展满能,把"防御开销不抽干
      // 主孵化"的不变量从冷启动爬坡里解耦出来——cold boot 的 0 能量来自
      // 普通孵化,与防御无关。
      await db['rooms.objects'].update({ type: 'spawn', room: fixture.room }, { $set: { store: { energy: 300 }, energy: 300 } });
    }
    if (squadProbe && i >= 600 && i <= 1100 && i % 100 === 0) {
      // 软 raider(2 attack=20dps,48 move 满血 5000):守卫 60dps 84 tick 歼敌,
      // 治疗 24hp/tick 完全覆盖 20dps——守卫应当全程无阵亡(治疗续航的验收面)。
      // 无 AI 的 raider 实测会在 ~100 tick 后消失(M7-1 同象,机制未明),持续
      // 补投保证威胁窗口覆盖小队孵化期;歼敌判定只认"曾受伤+终帧不在场"。
      const objs = await server.world.roomObjects(fixture.room);
      if (!objs.some(o => o.type === 'creep' && o.name === 'Raider-1')) {
        await server.world.addRoomObject(fixture.room, 'creep', 34, 34, {
          user: '2', name: 'Raider-1', body: [
            ...Array.from({ length: 2 }, () => ({ type: 'attack', hits: 100 })),
            ...Array.from({ length: 48 }, () => ({ type: 'move', hits: 100 })),
          ],
          hits: 5000, hitsMax: 5000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 2101, actionLog: {},
        });
      }
      if (i === 600) console.log('[squad] soft raider campaign starts (5000 hp, 20 dps)');
    }
    // 首次受击即停补投:持续再武装会造第二/三轮任务,终帧状态不可判。
    if (assaultProbe && i <= 2100 && report.assault.minHits >= 2000 && i % 25 === 0) {
      // 无 AI 的注入敌会 ~100 tick 自灭(M7-1 同象):持续补投保证威胁窗口
      // 覆盖小队孵化+行军期;歼敌判定认"终帧不在场+完成台账落地"。
      const objs = await server.world.roomObjects('W0N2');
      for (const [name, x] of [['Squatter-1', 24], ['Squatter-2', 26]]) {
        if (!objs.some(o => o.type === 'creep' && o.name === name)) {
          await server.world.addRoomObject('W0N2', 'creep', x, 34, {
            // 部件序实证(评审):引擎按尾填 hits 预算(creeps/tick.js _recalc-body),
            // attack 列首+2000<2200 容量=出生即缴械(haveAttack 恒假,追击/攻击
            // 全不触发)。attack 列尾活到 ~200 血,追击全程真实。
            user: '2', name, body: [
              ...Array.from({ length: 19 }, () => ({ type: 'move', hits: 100 })),
              { type: 'attack', hits: 100 },
            ],
            hits: 2000, hitsMax: 2000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 4000, actionLog: {},
          });
        }
      }
      if (i === 0) console.log('[assault] squatters seeded in W0N2 (2x 2000hp, 30dps each, attack tail-seeded)');
    }
    // 专职追兵(M7-9 评审修订):蹲守者 attack 部件列首,交火瞬间被剥光,
    // 原生冲锋压不出风筝窗口——补一只 attack 列尾的高血追击者,由引擎
    // invasion AI 真实驱动(findAttack 咬路径最近敌对者:生成在游骑东侧 4 格
    // 即锁定游骑),交火期逐 tick 实测与游骑的环带距离。
    // 入场时机(评审修订):改在蹲守者清场后——交战期入场会让游骑被
    // 蹲守者+追兵双向夹击,环带被口袋几何打破(实证 bandMin 摆 1/3);
    // 清场后单轴追击才是风筝机制要证的孤立法,且追兵在场 armed>0
    // 天然卡住任务完成判据(25t 窗口足够测环带)。
    if (kiteProbe && !report.kite.chaserSpawned && report.assault.clearedAt !== null && report.assault.clearedAt !== undefined) {
      const objs = await server.world.roomObjects('W0N2');
      const ranger = objs.find(o => o.type === 'creep' && String(o.name).startsWith('ranger-'));
      if (ranger) {
        // 12-tick 轻追兵:3 格处生成即入环(contact 结构性成立),环带实测
        // 靠随后几 tick 的撤退步;30dps×12t=360<400 任何人血量——测量装置
        // 不得杀伤被测小队(实证:5000hp 版把 medic 磨死触发撤退,任务红
        // 是探针自伤)。1000hp 让小队集火 ~2t 可解,兜底 +12t 移除。
        await server.world.addRoomObject('W0N2', 'creep', Math.min(47, ranger.x + 3), ranger.y, {
          user: '2', name: 'Chaser-1', body: [
            ...Array.from({ length: 9 }, () => ({ type: 'move', hits: 100 })),
            { type: 'attack', hits: 100 },
          ],
          hits: 1000, hitsMax: 1000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 4000, actionLog: {},
        });
        report.kite.chaserSpawned = i;
        console.log('[kite] chaser seeded at', Math.min(47, ranger.x + 3), ranger.y);
      }
    }
    if (kiteProbe && report.kite.chaserSpawned
      && (i >= report.kite.chaserSpawned + 12 || report.assault.phases.withdraw !== undefined)) {
      // 测量窗 12t 到点(或任务提前撤退)即移除——追兵是武装敌对者,
      // 赖着不走会卡住任务完成判据,更不能让它磨死任何人。
      await db['rooms.objects'].removeWhere({ type: 'creep', name: 'Chaser-1' });
    }
    if (kiteProbe && (report.assault.minHits < 2000 || report.kite.chaserSpawned) && !report.kite.bandDone) {
      // 风筝环带逐 tick 实测(评审:engaged+满血证不了撤退腿——追兵逼近后
      // chebyshev 从未 <2 才算风筝成立)。
      const objs = await server.world.roomObjects('W0N2');
      const rangers = objs.filter(o => o.type === 'creep' && String(o.name).startsWith('ranger-'));
      // 环带只对专职追兵计:蹲守者混战期是双向火网,不是风筝要证的
      // 单轴追击实验;清场后追兵单压,环带数据才干净。
      const meleeFoes = objs.filter(o => o.type === 'creep' && o.name === 'Chaser-1'
        && (o.body || []).some(p => p.type === 'attack' && p.hits > 0));
      for (const r of rangers) {
        for (const f of meleeFoes) {
          const d = Math.max(Math.abs(f.x - r.x), Math.abs(f.y - r.y));
          if (d <= 3) {
            report.kite.contactAt ??= i;
            report.kite.bandMin = Math.min(report.kite.bandMin ?? 99, d);
          }
        }
      }
      if (meleeFoes.length === 0 && report.kite.contactAt !== null) report.kite.bandDone = true;
    }
    if (assaultProbe && i % 5 === 0) {
      const sq = (await server.world.roomObjects('W0N2')).filter(o => o.type === 'creep' && report.assault.squatters.includes(o.name));
      if (sq.length > 0) report.assault.minHits = Math.min(report.assault.minHits, ...sq.map(o => o.hits ?? 2000));
      else if (report.assault.minHits < 2000) report.assault.clearedAt ??= i;
      // 蹲守者行踪(伤害机制取证:它们会被驱动北移冲锋,越界进 W0N1 吃塔)
      if (kiteProbe) (report.assault.sqSeries ??= []).push([i, ...sq.flatMap(o => [o.name, o.x, o.y, o.hits])]);
      // 相位 5-tick 直采:补投停止后战斗变快,engage 相位窗(~80t)短于
      // report.ticks 的 ~100t 采样间隔,快照序列会整体错过。
      try {
        const env = server.common.storage.env;
        const raw = await env.get(env.keys.MEMORY + bot.id);
        const aa = (JSON.parse(raw || '{}').intel ?? {}).assault;
        if (aa?.phase) report.assault.phases[aa.phase] ??= i;  // 首见语义(曾错记末见,把 455 的翻转显示成 1615)
        if (aa?.withdrawReason) report.assault.withdrawReason = aa.withdrawReason;
        if (aa?.lastLoss) report.assault.lastLoss = aa.lastLoss;
        // 立队计数(排除表闭环证据:烂尾收档后不得再立)+ 排除期读数
        if (aa && !report.assault._prevActive) report.assault.foundings = (report.assault.foundings ?? 0) + 1;
        report.assault._prevActive = !!aa;
        const exc = (JSON.parse(raw || '{}').intel ?? {}).assaultExcludedUntil;
        if (exc) report.assault.excludedUntil = exc;
      } catch { /* 采样失败不影响世界 */ }
      // 强化链证据(M7-7):产物峰值(反应链通)+ 曾见 UH 强化部件(boostCreep 通),
      // 成员收档即解散,终帧扫不到——按 ever-seen 记账。
      const home = await server.world.roomObjects(fixture.room);
      let boosted = 0;
      for (const o of home) {
        if (o.type === 'creep' && Array.isArray(o.body)) {
          boosted = Math.max(boosted, o.body.filter(p => p.boost === 'UH').length);
        } else if (o.type === 'lab' && o.store && (o.store.UH ?? 0) > 0) {
          report.assault.uhPeak = Math.max(report.assault.uhPeak, o.store.UH);
        } else if (o.type === 'lab' && o.store && report.assault.inputLabIds.includes(String(o._id))) {
          // sink 收窄钉(按夹具 id 认输入 lab——输出 lab 被吃到 UH=0 时不能
          // 误当输入):反应不吃能量,输入 lab 一粒能都不该收到(收窄前 910 能
          // 永久沉没实证)。
          report.assault.inputLabEnergyPeak = Math.max(report.assault.inputLabEnergyPeak, o.store.energy ?? 0);
        }
      }
      report.assault.uhBoosted = Math.max(report.assault.uhBoosted, boosted);
      if (assaultProbe) {
        // 小队行踪跟踪:两房合扫,名字首失时记最后位置(折损归因)。
        const all = [...home, ...(await server.world.roomObjects('W0N2'))];
        report.assault.lastSeen ??= {};
        const present = new Set();
        for (const o of all) {
          if (o.type !== 'creep') continue;
          const nm = String(o.name);
          if (!/^(assaulter|medic|ranger|dismantler)-/.test(nm)) continue;
          present.add(nm);
          report.assault.lastSeen[nm] = { tick: i, room: o.room ?? '?', x: o.x, y: o.y, hits: o.hits };
        }
        for (const [nm, seen] of Object.entries(report.assault.lastSeen)) {
          if (!present.has(nm) && !('goneAt' in seen)) seen.goneAt = i;
        }
      }
      if (kiteProbe) {
        const inField = await server.world.roomObjects('W0N2');
        for (const o of [...home, ...inField]) {
          if (o.type !== 'creep' || !String(o.name).startsWith('ranger-')) continue;
          report.kite.rangerSpawned = true;
          report.kite.rangerMinHits = Math.min(report.kite.rangerMinHits ?? Infinity, o.hits ?? 0);
        }
      }
      if (siegeProbe || stalemateProbe) {
        const hostileStructs = (await server.world.roomObjects('W0N2')).filter(o => o.user === '2' && o.type !== 'creep');
        const left = new Set(hostileStructs.map(o => o.type));
        if (!left.has('spawn')) report.siege.spawnGoneAt ??= i;
        if (!left.has('rampart')) report.siege.rampartGoneAt ??= i;
        if (!left.has('extension')) report.siege.extGoneAt ??= i;
      }
    }
    if (combatProbe && i === 850 && !squadProbe) {
      for (const [name, x] of [['Raider-2', 33], ['Raider-3', 35]]) {
        await server.world.addRoomObject(fixture.room, 'creep', x, 34, {
          user: '2', name, body: [
            ...Array.from({ length: 20 }, () => ({ type: 'attack', hits: 100 })),
            ...Array.from({ length: 30 }, () => ({ type: 'move', hits: 100 })),
          ],
          hits: 2000, hitsMax: 2000, store: {}, storeCapacity: 0, fatigue: 0, spawning: false, ageTime: 2351, actionLog: {},
        });
      }
      console.log('[combat] wave two: Raider-2/3 (2000 hp) at (33,34)/(35,34)');
    }

    if (storageProbe && i === 500) {
      const { db } = server.common.storage;
      const creeps = (await server.world.roomObjects(fixture.room)).filter(o => o.type === 'creep' && o.user === bot.id);
      const miners = creeps.filter(c => c.name.startsWith('miner-')).map(c => c.name);
      const workers = creeps.filter(c => c.name.startsWith('worker-')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 3).map(c => c.name);
      await db['rooms.objects'].removeWhere({ type: 'creep', name: { $in: [...miners, ...workers] } });
      await db['rooms.objects'].removeWhere({ type: 'container' });
      await db['rooms.objects'].removeWhere({ type: 'constructionSite', structureType: 'container' });
      console.log(`[storage] income cut at tick ${i}: miners=${miners.length} killed, 3 workers killed, containers removed`);
    }
    if (storageProbe && i > 500 && i < 900 && i % 25 === 0) {
      const { db } = server.common.storage;
      await db['rooms.objects'].removeWhere({ type: 'constructionSite', structureType: 'container' });
    }
    if (linkplaceProbe && i % 25 === 0) {
      // 建造时长是时长问题不是行为问题(colonize 判例):link 工地出现后
      // 中途提到 699/700,下个建造 tick 落成,把"建成"折进窗口。
      const { db } = server.common.storage;
      const objs = await server.world.roomObjects(fixture.room);
      for (const site of objs.filter(o => o.type === 'constructionSite' && o.structureType === 'link')) {
        await db['rooms.objects'].update({ _id: site._id }, { $set: { progress: (site.progressTotal ?? 700) - 1 } });
      }
      // 非 link 工地清场:link 是本探针唯一被测建造对象,扩展/塔工地会把
      // builders 队列排到窗口外(实证 2026-09-21:30 扩展在场,link 工地
      // 4999/5000 晒到终帧无人问津)。
      const rivals = objs.filter(o => o.type === 'constructionSite' && o.structureType !== 'link').map(o => o._id);
      if (rivals.length) await db['rooms.objects'].removeWhere({ _id: { $in: rivals } });
    }
    if (mineralProbe && i % 25 === 0) {
      // 同 linkplace 判例:被测设施(link/terminal/extractor)进度折入窗口,
      // 其余工地清场保 builders 队列;塔工地被反复清→重置 stage,但每窗口
      // 内 2 塔+3 链+terminal+extractor 的 7 个放置 tick 放得下。
      const { db } = server.common.storage;
      const objs = await server.world.roomObjects(fixture.room);
      for (const site of objs.filter(o => o.type === 'constructionSite' && ['link', 'terminal', 'extractor', 'lab'].includes(o.structureType))) {
        await db['rooms.objects'].update({ _id: site._id }, { $set: { progress: (site.progressTotal ?? 5000) - 1 } });
      }
      const rivals = objs.filter(o => o.type === 'constructionSite' && !['link', 'terminal', 'extractor', 'lab'].includes(o.structureType)).map(o => o._id);
      if (rivals.length) await db['rooms.objects'].removeWhere({ _id: { $in: rivals } });
    }
    if (marketProbe && i === Math.floor(tickCount / 2)) {
      // 中窗取证:买卖腿应已在 t100/t200 完成——留一份台账进 report。
      const our = await db.users.findOne({ _id: bot.id });
      const npc = await db.users.findOne({ _id: 'npc-market' });
      const orders = await db['market.orders'].find({});
      report.marketMidpoint = {
        ourMoney: our.money ?? null, npcMoney: npc.money ?? null,
        buyUH: orders.find(o => o._id === 'order-buy-uh')?.remainingAmount ?? null,
        sellH: orders.find(o => o._id === 'order-sell-h')?.remainingAmount ?? null,
      };
    }
    if (factoryProbe && i % 25 === 0) {
      // RCL7 差异:chain 在 labs(6)→factory 之间还有 tower(6)——一并 boost,
      // 其余工地照旧清场;factory 建成后预置 U+energy 启动压条(能量供料腿
      // 不在本刀,courier 矿腿已实现)。
      const { db } = server.common.storage;
      const objs = await server.world.roomObjects(fixture.room);
      for (const site of objs.filter(o => o.type === 'constructionSite' && ['link', 'terminal', 'extractor', 'lab', 'tower', 'factory'].includes(o.structureType))) {
        await db['rooms.objects'].update({ _id: site._id }, { $set: { progress: (site.progressTotal ?? 5000) - 1 } });
      }
      const rivals = objs.filter(o => o.type === 'constructionSite' && !['link', 'terminal', 'extractor', 'lab', 'tower', 'factory'].includes(o.structureType)).map(o => o._id);
      if (rivals.length) await db['rooms.objects'].removeWhere({ _id: { $in: rivals } });
      const factorySite = objs.find(o => o.type === 'constructionSite' && o.structureType === 'factory');
      if (factorySite) {
        // 工地→成品直转:引擎只在 build 意图里结算完工(progress>=total 不自动
        // 升级),而 6 塔吸干搬运工后"最后一点"的捐入被饿死——placement 的
        // 位置正确性已由断言覆盖,这里只替 builder 完成最后一击。
        await db['rooms.objects'].removeWhere({ _id: factorySite._id });
        await server.world.addRoomObject(fixture.room, 'factory', factorySite.x, factorySite.y, { user: bot.id, store: {}, storeCapacity: 50000, hits: 100000, hitsMax: 100000 });
      }
      const factoryBuilt = objs.find(o => o.type === 'factory');
      if (factoryBuilt && !(factoryBuilt.store?.U > 0)) {
        await db['rooms.objects'].update({ _id: factoryBuilt._id }, { $set: { store: { energy: 6000, U: 1200 } } });
      }
    }
    if (labsProbe && i % 25 === 0) {
      // 同 mineral-probe 判例:被测设施(link/terminal/extractor/lab)进度
      // 折入窗口,其余工地清场保 builders 队列。
      const { db } = server.common.storage;
      const objs = await server.world.roomObjects(fixture.room);
      for (const site of objs.filter(o => o.type === 'constructionSite' && ['link', 'terminal', 'extractor', 'lab'].includes(o.structureType))) {
        await db['rooms.objects'].update({ _id: site._id }, { $set: { progress: (site.progressTotal ?? 5000) - 1 } });
      }
      const rivals = objs.filter(o => o.type === 'constructionSite' && !['link', 'terminal', 'extractor', 'lab'].includes(o.structureType)).map(o => o._id);
      if (rivals.length) await db['rooms.objects'].removeWhere({ _id: { $in: rivals } });
      // H 无法经 mockup 的 withdraw 通路上料(非能量 withdraw 落库怪癖,真机
      // 无此问题):三座 lab 建成后,按 id 序给第二只预置 H——U 仍由矿工
      // 自采经 transfer 上料,withdraw 通路留待真机验证。
      const labsBuilt = objs.filter(o => o.type === 'lab');
      if (labsBuilt.length === 3) {
        const ordered = labsBuilt.slice().sort((a, b) => String(a._id).localeCompare(String(b._id)));
        if (!ordered[0].store || !ordered[0].store.U) await db['rooms.objects'].update({ _id: ordered[0]._id }, { $set: { store: { energy: 0, U: 100 } } });
        if (!ordered[1].store || !ordered[1].store.H) await db['rooms.objects'].update({ _id: ordered[1]._id }, { $set: { store: { energy: 0, H: 100 } } });
      }
    }
    if (storageProbe && i === 900) {
      const { db } = server.common.storage;
      const objs = await server.world.roomObjects(fixture.room);
      const storage = objs.find(o => o.type === 'storage');
      await db['rooms.objects'].update({ _id: storage._id }, { $set: { store: { energy: 800 } } });
      const spawn = objs.find(o => o.type === 'spawn' && o.user === bot.id);
      await db['rooms.objects'].update({ _id: spawn._id }, { $set: { store: { energy: 300 }, spawning: null } });
      for (const ext of objs.filter(o => o.type === 'extension')) {
        await db['rooms.objects'].update({ _id: ext._id }, { $set: { store: { energy: 50 } } });
      }
      for (const tower of objs.filter(o => o.type === 'tower')) {
        await db['rooms.objects'].update({ _id: tower._id }, { $set: { store: { energy: 1000 } } });
      }
      await db['rooms.objects'].removeWhere({ type: 'constructionSite' });
      await db['rooms.objects'].removeWhere({ type: 'road' });
      console.log('[storage] frozen at tick 900: storage=800, spawn/ext/tower full, no sites, no roads');
    }
    if (storageProbe && i > 900 && i % 25 === 0) {
      const { db } = server.common.storage;
      await db['rooms.objects'].removeWhere({ type: 'constructionSite' });
      await db['rooms.objects'].removeWhere({ type: 'road' });
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
        // storage 解锁按窗口判定(台账 2026-09-18):放置行为确定(六跑全在 4302
        // 落点),但末帧 progress 是 mock CPU 混沌的掷硬币——同语义六跑 0~1110
        // 漂移,含改动前旧跑;塔/扩展在窗口内持续吃建造优先级是设计行为
        // (logistics.ts 分批施工链),storage 0 进度 ≠ 回归。回归面由本放置断言
        // + planning.test.ts 的 RCL4 storage 单测 + 塔/扩展窗口覆盖。
        check('RCL4 stage: storage is placed after the unlock',
          report.ticks.some(t => t.time >= 4300 && (t.objects.some(o => o.type === 'storage')
            || t.objects.some(o => o.type === 'constructionSite' && o.structureType === 'storage'))));
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
      if (i % 100 === 0 || i === tickCount - 1 || economyProbe && i % 10 === 0 || combatProbe && i % 25 === 0 || storageProbe && i % 25 === 0 || linksProbe && i % 10 === 0) { report.ticks.push(snapshot); save(); }
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
    if (remoteProbe) {
      const lastMem = report.ticks.at(-1).memory;
      // 出生证据走 memory:机组跨房作业,200 tick 快照点读等价掷硬币(台账同款教训)。
      check('remote miner spawned for the reserved target',
        Object.keys(lastMem.creeps ?? {}).some(n => n.startsWith('rminer-')));
      check('remote hauler spawned after the miner',
        Object.keys(lastMem.creeps ?? {}).some(n => n.startsWith('rhauler-')));
      // 母房无第二个能量来源:搬运工在母房带货即完成跨房采矿-回运闭环。
      check('hauler returned home carrying remote energy',
        report.ticks.some(t => t.objects.some(o => o.type === 'creep' && o.name?.startsWith('rhauler-') && (o.store?.energy ?? 0) > 0)));
      check('remote crew delivered energy into the home economy',
        (lastMem.intel?.remoteDelivered ?? 0) > 0);
    }
    if (colonizeProbe) {
      const lastMem = report.ticks.at(-1).memory;
      // 出生证据走台账不走快照:colonizer 快认领先死,可能整个生命周期落在
      // 两个 100-tick 快照之间(实证:认领 282 < 快照 302,name 扫描漏报)。
      // claimedAt + 死亡时间戳 = 出生/认领/退役全链路的权威证据。
      check('colonizer dispatched, claimed and retired (ledger evidence)',
        typeof lastMem.intel?.colonies?.W0N2?.claimedAt === 'number'
        && typeof lastMem.intel?.lastColonizerDeathAt === 'number');
      // 占领落地以重观测回写的归属为准;台账 colonies 是 M5-3 启动队的令箭。
      const rooms = lastMem.intel?.rooms ?? {};
      check('colonizer entered the target room and refreshed intel',
        (rooms.W0N2?.observedAt ?? 1) > 1);
      check('target controller claimed and observed as owned',
        rooms.W0N2?.controller?.owner === 'M0');
      check('colony ledger recorded the claim',
        typeof lastMem.intel?.colonies?.W0N2?.claimedAt === 'number');
      // M5-3 启动队:占领后自动派队→自主落子 spawn 工地→建成→台账毕业。
      // 跨房证据一律走 memory/世界直查,不走路径快照(快照只含母房对象)。
      check('pioneer squad dispatched to the claimed colony',
        report.ticks.some(t => Object.keys(t.memory.creeps ?? {}).some(n => n.startsWith('pioneer-'))));
      check('pioneers placed the colony spawn site autonomously',
        report.colonize?.sitePlacedAt !== undefined);
      const colonyObjs = await server.world.roomObjects('W0N2');
      check('colony spawn construction completed',
        colonyObjs.some(o => o.type === 'spawn' && o.user === bot.id));
      check('colony graduated in the ledger (spawnedAt)',
        typeof lastMem.intel?.colonies?.W0N2?.spawnedAt === 'number');
      // M5-4 独立补员(窗口 2400 > pioneer 出生 ~350 + TTL 1500,启动队全部
      // 寿终后殖民房须靠自己的 spawn 维生):殖民房自孵工人存在(名字带房名
      // 后缀)且末帧仍在册;启动队毕业后门禁关闭不补员,末帧 pioneer 清零
      // 即证明供养关系纯粹。
      const colonyBorn = (mem) => Object.keys(mem.creeps ?? {}).filter(n => n.startsWith('worker-W0N2-'));
      check('colony spawned its own workers', report.ticks.some(t => colonyBorn(t.memory).length > 0));
      check('colony outlives the pioneer squad (self-sustaining population)',
        colonyBorn(lastMem).length > 0
        && !Object.keys(lastMem.creeps ?? {}).some(n => n.startsWith('pioneer-')));
      check('colony controller kept upgrading past RCL1',
        (rooms.W0N2?.controller?.level ?? 0) >= 2);
      // 评估根锚定:殖民房毕业后双榜仍以母房为根(防距离缓存污染)。
      check('evaluation stays rooted at the home room', lastMem.intel?.rootRoom === 'W0N1');
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
      // M5 殖民榜(同节奏产出):无主无预定房应登顶;榜上任何房间都不得
      // 有归属或生效中的外援预定(殖民过滤口径,比远矿更严)。
      const colonization = report.ticks.at(-1).memory.intel?.colonization;
      check('colonization board selects the claimable neutral room',
        colonization?.targets?.[0]?.name === 'W0N2' && colonization.targets[0].sources === 2);
      check('colonization board carries no owned or foreign-reserved rooms',
        (colonization?.targets ?? []).every(t => {
          const c = rooms[t.name]?.controller;
          return c && c.owner === undefined && (c.reserver === undefined || c.reserver === 'M0');
        }));
    }
    if (linkplaceProbe) {
      const links = report.ticks.at(-1).objects.filter(o => o.type === 'link');
      const cheb = (a, b) => Math.max(Math.abs(a.x - b[0]), Math.abs(a.y - b[1]));
      const srcTiles = fixture.sources;
      check('planner places the link pair within cap', links.length === report.linkplace.cap);
      const sourceLink = links.filter(l => srcTiles.some(s => cheb(l, s) <= 2));
      check('source link anchors within two of a source', sourceLink.length >= 1
        && sourceLink.some(l => srcTiles.some(s => cheb(l, s) <= 2)
          && report.ticks.at(-1).objects.some(o => o.type === 'container' && cheb(l, [o.x, o.y]) <= 1)));
      check('hub link anchors beside storage', links.some(l => cheb(l, report.linkplace.storageAt) <= 2));
      check('both links are built and owned', links.length === 2
        && links.every(l => l.store?.energy !== undefined || l.hits !== undefined));
    }
    if (labsProbe) {
      // 终帧可能撞上 worker 关停竞态(最后一 tick 的对象被吃掉)——
      // 取最后一个"三 lab 俱在"的快照作断言面。
      const good = [...report.ticks].reverse().find(t => t.objects.filter(o => o.type === 'lab').length >= 3) ?? report.ticks.at(-1);
      const last = good.objects;
      const cheb = (a, b) => Math.max(Math.abs(a.x - b[0]), Math.abs(a.y - b[1]));
      const labs = last.filter(o => o.type === 'lab');
      // RCL7 起 labCap=6——数量门槛改为下限,聚类不变量本就全组互查。
      check('three labs owned, mutually within two of each other', labs.length >= 3
        && labs.every(a => labs.every(b => a === b
          || Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 2)));
      check('labs cluster around the terminal', labs.length >= 3
        && labs.every(l => cheb(l, report.labsProbeState.terminalAt) <= 3));
      const outLab = labs.map(l => (l.store?.UH ?? 0)).reduce((s, v) => Math.max(s, v), 0);
      if (!factoryProbe) check('reaction chain produces UH into the output lab', outLab > 0);
      // 输入 lab 会被反应正常耗尽(H 100→0→补种循环)——"终帧有料"是瞬态,
      // 断言改为全程曾见(供料发生过),不被耗尽节奏背锅。
      if (!factoryProbe) {
        // factory 探针里 U 优先喂压条站(courier 供料优先级设计),labs 断言不适用。
        const everU = report.ticks.some(t => t.objects.some(o => o.type === 'lab' && (o.store?.U ?? 0) > 0));
        const everH = report.ticks.some(t => t.objects.some(o => o.type === 'lab' && (o.store?.H ?? 0) > 0));
        check('courier feeds both input labs from terminal', everU && everH);
      }
    }
    if (marketProbe) {
      const mid = report.marketMidpoint ?? {};
      const terminalEver = (pred) => report.ticks.some(t => { const term = t.objects.find(o => o.type === 'terminal' && o.user !== undefined); return term ? pred(term) : false; });
      // 卖:home 把 UH 多余额卖给 1.5 credits 的买单,credits 到账(库价 ×1000)
      check('home sells surplus UH and earns credits', (mid.ourMoney ?? 0) > 500000);
      // 买:H 低于触发线,从 0.5 credits 的卖单补进 terminal
      check('home buys missing H input, spending credits', (mid.npcMoney ?? 2000000) !== 2000000 && (mid.sellH ?? 2000) < 2000);
      // 订单簿被真实消耗
      check('market orders drain', (mid.buyUH ?? 5000) < 5000 && (mid.sellH ?? 2000) < 2000);
      // 买回的 H 真的落在 home terminal 里
      check('bought H lands in the home terminal', terminalEver(t => (t.store?.H ?? 0) >= 60));
      // 卖出后 UH 降至保留量附近(库存换钱,不留囤积)
      check('UH surplus leaves the terminal', terminalEver(t => (t.store?.UH ?? 0) <= 100));
    }
      if (raidProbe) {
        // 拆预留远征验收:接力(CLAIM 件寿命 600,长单靠继任)、榜单锁敌、
        // 剥离进度压过自然衰减线(5000-3000=2000)。
        const raiderNames = new Set(report.ticks.flatMap(t => Object.keys(t.memory.creeps ?? {}).filter(n => n.startsWith('raider-'))));
        check('raider relay deployed against the squatter', raiderNames.size >= 2);
        const boardHit = report.ticks.some(t => ((t.memory.intel?.raiding?.targets) ?? []).some(x => x.name === 'W0N2'));
        check('raid board locked the squatter', boardHit);
        const lastTicks = [...report.ticks].reverse().find(t => (t.memory.intel?.rooms?.W0N2?.controller?.reservationTicks ?? null) !== null);
        const finalTicks = lastTicks?.memory.intel.rooms.W0N2.controller.reservationTicks;
        check('foreign reservation stripped past natural decay', typeof finalTicks === 'number' && finalTicks < 2000);
      }
    if (assaultProbe) {
      const memSeries = report.ticks.map(t => t.memory.intel ?? {});
      // 榜单锁敌:突袭目标榜曾收录 W0N2
      const boardHit = memSeries.some(m => ((m.assaulting?.targets) ?? []).some(x => x.name === 'W0N2'));
      check('assault board locked the armed squatter', boardHit);
      // 阶段推进:曾抵达交战阶段(5-tick 直采,快照序列会漏短相位窗)
      check('squad reached the engage phase', report.assault.phases.engage !== undefined);
      // 完胜区分:补投已停,残余蹲守者自然自灭后 clearedAt 照落、ledger 照收档,
      // 折损撤退的任务也能静默全绿——必须断言全程未见 withdraw 相位。
      if (!stalemateProbe) {
        check('mission ended in clean victory, no withdrawal',
          report.assault.phases.engage !== undefined && report.assault.phases.withdraw === undefined);
      }
      // M7-7 强化链:UH 产物曾 ≥ 一个攻击手的满额(90=3件×30,反应链通);
      // 攻击手身体曾见 UH 强化件(boostCreep 通,强化腿真实执行)。
      check('UH produced by the reaction line', report.assault.uhPeak >= 90);
      check('assaulters boosted with UH before departing', report.assault.uhBoosted >= 1);
      check('input labs never fed energy (sink scoped to demanded compound)', report.assault.inputLabEnergyPeak === 0);
      if (kiteProbe) {
        // 远程拉扯(M7-9):armed=2 编成带游骑;蹲守者由引擎 invasion AI 真实
        // 驱动冲锋——风筝成立要三层:入环交战、追兵逼近过 3 环、逼近后环带
        // 从未 <2(撤退腿实证)+ 全程无划伤。
        check('kite ranger fielded in the squad', report.kite.rangerSpawned);
        check('melee pursuit reached the ranger ring (contact <=3)', report.kite.contactAt !== null);
        check('kite band never broke (melee never closed under 2)', (report.kite.bandMin ?? 99) >= 2);
        check('kite ranger never scratched by melee squatters', report.kite.rangerMinHits === 400);
      }
      if (stalemateProbe) {
        // 烂尾围攻(M7-8b 评审修订):spawn 3e8 拆不完——可拆的墙/扩展照拆
        // (拆墙腿真实工作过),任务以撤退收档,目标入排除期,且不再二次立队
        // (排除表断"撤退→冷却→再锁"送兵循环的端到端证据)。
        // 战术序 spawn 优先(正确教义:先掐产能)——拆墙手死磕 3e8 spawn,
        // 压顶 rampart 被同格重定向先啃(~45t 告破 = 拆墙腿真实工作过,非自然
        // 衰减 ~3000t);ext 永远轮不到是教义结果非 bug。场景学习目标=撤退+
        // 排除+不再立队。
        check('stalemate: overlaid rampart razed in real combat (not decay)',
          report.siege.rampartGoneAt !== null && report.siege.rampartGoneAt < 2500);
        check('stalemate: unrazable spawn was NOT razed', report.siege.spawnGoneAt === null);
        check('stalemate ended in withdrawal', report.assault.phases.withdraw !== undefined);
        check('undismantlable target excluded after failed siege',
          (report.assault.excludedUntil?.W0N2 ?? 0) > 0);
        check('no refounding against the excluded room', (report.assault.foundings ?? 0) <= 1);
      }
      if (siegeProbe && !stalemateProbe) {
        // 围攻(M7-8):任务完成判据含"敌建筑拆完"——spawn/rampart/ext 全灭才收档。
        check('siege dismantled the hostile spawn', report.siege.spawnGoneAt !== null);
        check('siege chewed the rampart before decay could explain (<2500)',
          report.siege.rampartGoneAt !== null && report.siege.rampartGoneAt < 2500);
        check('siege razed the hostile extension', report.siege.extGoneAt !== null);
        // 完成时序:建筑清零在任务收档(clearedAt 后仍作战)之前或同窗——
        // 收档本身由上方"完胜无撤退"钉,这里钉"拆完才收"的因果方向。
        check('razing preceded mission completion', report.assault.clearedAt !== null);
      }
      // 歼敌:受击后清场且保持到窗口后段(证据取自 W0N2 直采采样;母房
      // objects 不含邻房,按它断"清场"恒真——空断言已废)。
      check('squatters cleared from the target room after damage',
        report.assault.clearedAt !== null && report.assault.clearedAt < tickCount - 50);
      // 真打过的取证:蹲守者曾掉血(排除"消失窗口假完成"路径)
      check('squatters took real damage from the squad', report.assault.minHits < 2000);
      // 完成:台账落地(assault 收档,冷却与目标记录在案)
      const lastMem = [...report.ticks].reverse().find(t => t.memory.intel)?.memory.intel ?? {};
      check('assault ledger closed with cooldown recorded',
        lastMem.assault === undefined && lastMem.lastAssaultTarget === 'W0N2' && typeof lastMem.lastAssaultEndAt === 'number');
      // 母房无恙:spawn 仍在,工人地板未破
      const lastTick = report.ticks.at(-1);
      const homeSpawn = lastTick.objects.some(o => o.type === 'spawn' && o.user !== undefined);
      const workersLeft = Object.keys(lastTick.memory.creeps ?? {}).filter(n => n.startsWith('worker')).length;
      check('home economy intact after the raid', homeSpawn && workersLeft >= 1);
    }
    if (factoryProbe) {
      const good = [...report.ticks].reverse().find(t => t.objects.some(o => o.type === 'factory' && o.hits > 0)) ?? report.ticks.at(-1);
      const last = good.objects;
      const cheb = (a, b) => Math.max(Math.abs(a.x - b[0]), Math.abs(a.y - b[1]));
      const factory = last.find(o => o.type === 'factory');
      check('factory built within four of the terminal', !!factory && cheb(factory, report.labsProbeState.terminalAt) <= 4);
      const barsEver = report.ticks.some(t => (t.objects.find(o => o.type === 'factory')?.store?.utrium_bar ?? 0) > 0);
      check('factory produces utrium bars from seeded stock', barsEver);
      // 喂料断言锚"作业中的线"而非瞬态库存位(压条 500/次,采样窗接不住回填峰):
      // mharv 在场 + factory 仍有矿 = 供料线在工作;消耗由 bars>0 与 U<种子佐证。
      const mharvAlive = (Object.values(report.ticks.at(-1).memory.creeps ?? {}).length, report.ticks.at(-1).memory.creeps && Object.keys(report.ticks.at(-1).memory.creeps).some(n => n.startsWith('mharv-')));
      const factoryStillStocked = (last.find(o => o.type === 'factory')?.store?.U ?? 0) > 0;
      check('courier keeps the factory mineral stocked', mharvAlive && factoryStillStocked);
      const consumed = report.ticks.some(t => { const f = t.objects.find(o => o.type === 'factory'); return f && (f.store?.U ?? 0) < 1200 && (f.store?.U ?? 0) > 0; });
      check('production consumes mineral components', consumed);
    }
    if (mineralProbe) {
      const good = [...report.ticks].reverse().find(t => t.objects.some(o => o.type === 'terminal' && o.hits > 0)) ?? report.ticks.at(-1);
      const last = good.objects;
      const cheb = (a, b) => Math.max(Math.abs(a.x - b[0]), Math.abs(a.y - b[1]));
      const terminals = last.filter(o => o.type === 'terminal');
      const extractors = last.filter(o => o.type === 'extractor');
      check('terminal placed within two of storage and owned', terminals.length === 1
        && cheb(terminals[0], report.mineral.storageAt) <= 2 && terminals[0].hits > 0);
      check('extractor sits on the mineral itself', extractors.length === 1
        && extractors[0].x === report.mineral.mineralAt[0] && extractors[0].y === report.mineral.mineralAt[1]);
      const harvesterBorn = report.ticks.some(t => Object.keys(t.memory.creeps ?? {}).some(n => n.startsWith('mharv-')));
      check('mineral harvester spawns from surplus once both structures stand', harvesterBorn);
      const harvested = report.ticks.some(t => (t.objects.find(o => o.type === 'terminal')?.store?.U ?? 0) > 0);
      check('mineral flows from deposit through harvester into terminal', harvested);
    }
    if (linksProbe) {
      const linkAt = (t, [x, y]) => t.objects.find(o => o.type === 'link' && o.x === x && o.y === y)?.store?.energy;
      const rows = report.ticks.map(t => ({ t: t.time, src: linkAt(t, report.links.sourceAt), hub: linkAt(t, report.links.hubAt) }))
        .filter(r => r.src !== undefined && r.hub !== undefined);
      check('source link is dispatched down to empty', rows.some(r => r.src === 0));
      const firstEmpty = rows.findIndex(r => r.src === 0);
      check('no energy ever flows back into the source link',
        firstEmpty >= 0 && rows.slice(firstEmpty).every(r => r.src === 0));
      check('hub receives within the 3% loss bound',
        rows.some(r => r.hub > 700 && r.hub <= report.links.expectedArrival)
        && rows.every(r => r.hub <= report.links.expectedArrival));
    }
    if (storageProbe) {
      const storageSeries = report.ticks.map(t => ({ t: t.time, e: t.objects.find(o => o.type === 'storage')?.store?.energy }));
      // 阶段一:断矿后搬运链从 storage 补货,孵化缺口被补上(缺料重规划)。
      const drawn = storageSeries.filter(s => s.t > 500 && s.t <= 900 && s.e !== undefined && s.e < report.storage.seed - 400);
      check('logistics re-routes through storage when income is cut', drawn.length > 0);
      const replacementBorn = report.ticks.some(t => Object.keys(t.memory.creeps ?? {})
        .some(n => n.startsWith('worker-') && Number(n.split('-').at(-1)) > report.storage.cutAt));
      check('workforce replacement continues through the storage feed', replacementBorn);
      const spawnFed = report.ticks.some(t => t.time > 500 && t.time <= 900
        && t.objects.find(o => o.type === 'spawn')?.store?.energy >= 300);
      check('spawn recovers to full through the storage feed', spawnFed);
      // 阶段二:全场冻结、storage 压在保底线下(800<1000)。保底是"产业
      // 不抽穿"不是"冻结":自采收入照常存入,生存链(塔防/孵化)合法取用,
      // 产业(floor 过滤)在 ≤1000 时一概不可见。断言冻结值不被击穿。
      const afterFreeze = storageSeries.filter(s => s.t > 900 && s.e !== undefined).map(s => s.e);
      check('industry never breaches the storage reserve floor',
        afterFreeze.length > 0 && Math.min(...afterFreeze) >= 800);
      check('survival stock stays full while the floor holds',
        report.ticks.at(-1).objects.find(o => o.type === 'spawn')?.store?.energy >= 290);
    }
    if (combatProbe) {
      const guardNames = new Set(report.ticks.flatMap(t => Object.keys(t.memory.creeps ?? {}).filter(n => n.startsWith('guard-'))));
      check('defender auto-spawned against armed invasion', guardNames.size > 0);
      const raiderHits = (label) => report.ticks
        .map(t => t.objects.find(o => o.type === 'creep' && o.name === label)?.hits)
        .filter(h => h !== undefined);
      if (!squadProbe) check('wave-one raider was engaged and destroyed',
        raiderHits('Raider-1').length > 0 && raiderHits('Raider-1').some(h => h < 5000)
        && !report.ticks.at(-1).objects.some(o => o.name === 'Raider-1'));
      if (!squadProbe) check('wave-two raiders were engaged and destroyed',
        raiderHits('Raider-2').length > 0 && raiderHits('Raider-2').some(h => h < 2000)
        && !report.ticks.at(-1).objects.some(o => o.name === 'Raider-2' || o.name === 'Raider-3'));
      const towerSeries = report.ticks.map(t => t.objects.find(o => o.type === 'tower')?.store?.energy ?? t.objects.find(o => o.type === 'tower')?.energy)
        .filter(e => e !== undefined);
      // 塔参战即可;防御储备断言落在 spawn:守卫/塔花钱不许把主孵化抽干。
      check('tower contributed to the defense', towerSeries.some(e => e < report.combat.towerCap));
      // 引导期(t<600)孵化自然清零不算——不变量是开战窗口后防御开销不抽干主孵化。
      const combatSpawnSeries = report.ticks.filter(t => t.time >= 600).map(t => t.objects.find(o => o.type === 'spawn')?.store?.energy).filter(e => e !== undefined);
      // "不抽干"= 不会因防御持续失血:守卫(260)/治疗(700)开票那一 tick
      // 把 spawn 存量抽 0 是成本结算,不是失血(下一 tick 即回满)。零电量
      // 快照数 ≤2(两员开票)且终帧满能 = 防御预算健康。
      const zeroTicks = combatSpawnSeries.filter(e => e === 0).length;
      check('defense spending never drains the spawn', zeroTicks <= 2 && combatSpawnSeries.at(-1) > 0);
      // 守卫 TTL 1500 覆盖全窗:清场后孵化门必须关死,不许无限增员。
      check('guard roster stays at one (no spawn spam after clear)', guardNames.size === 1);
      if (squadProbe) {
        // 小队验收(§治疗协同):治疗与守卫同期开赴、守卫全程无阵亡、
        // 歼敌后双员编制封顶不再增员。
        const healerNames = new Set(report.ticks.flatMap(t => Object.keys(t.memory.creeps ?? {}).filter(n => n.startsWith('healer-'))));
        check('healer deployed alongside the guard', healerNames.size >= 1);
        const guardAliveAt = (label) => report.ticks.some(t => t.memory.creeps && label in t.memory.creeps);
        const guardName = [...guardNames][0];
        check('guard survived the whole engagement', !!guardName && guardAliveAt(guardName)
          && report.ticks.at(-1).objects.some(o => o.type === 'creep' && o.name === guardName));
        const raiderHurt = report.ticks.some(t => t.objects.some(o => o.name === 'Raider-1' && o.hits < 5000));
        const guardNamesList = report.ticks.flatMap(t => Object.keys(t.memory.creeps ?? {}).filter(n => n.startsWith('guard-')));
        const raiderOutlivedSquad = !guardNamesList.length || report.ticks.some(t => guardNamesList.some(g => g in (t.memory.creeps ?? {})) && t.objects.some(o => o.name === 'Raider-1'));
        check('raider engaged by the squad while it stood', raiderHurt && raiderOutlivedSquad);
        const rosterStable = report.ticks.at(-1).objects.filter(o => o.type === 'creep' && (o.name.startsWith('guard-') || o.name.startsWith('healer-'))).length;
        check('squad roster caps at one guard plus one healer', rosterStable <= 2);
      }
      const ctrlProgress = (t) => t.objects.find(o => o.type === 'controller')?.progress;
      const mid = report.ticks[Math.min(4, report.ticks.length - 1)];
      check('economy keeps building after the invasions are cleared',
        ctrlProgress(report.ticks.at(-1)) > ctrlProgress(mid));
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
    if (logistics && !maintenanceProbe && !progressionProbe && !storageProbe) {
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
