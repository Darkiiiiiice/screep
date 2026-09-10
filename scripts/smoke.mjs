/**
 * Local smoke test: run the built bundle against a stand-in engine.
 *
 * Why this exists: there is no local engine harness (the official server is the
 * only real environment), and a deploy costs 1 of 240 daily code uploads. This
 * runs the ACTUAL uploaded artifact — `dist/main.js`, not the TypeScript — for
 * N ticks against engine globals that model the documented contracts, so an
 * obvious break is caught before it costs a deploy.
 *
 * What it can and cannot prove:
 *   CAN  — the bundle loads, exports `loop`, survives repeated calls, writes the
 *          stats segment, migrates Memory once, and stays within its CPU budget.
 *   CANNOT — anything physical: movement, damage, resource drain, structure
 *          durability. Those only exist in the real engine.
 *
 * Usage: node scripts/smoke.mjs [--ticks N] [--cpu-per-tick X]
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bodyCost, buildCreep, buildRoom, CONSTANTS, newestSnapshot } from './lib/fake-room.mjs';

// Hold the real console before any engine stub replaces `globalThis.console`,
// otherwise this script's own output would be captured as game output.
const out = console;

const args = process.argv.slice(2);
const ticksFlag = args.indexOf('--ticks');
const cpuFlag = args.indexOf('--cpu-per-tick');
const TICKS = ticksFlag !== -1 ? Number(args[ticksFlag + 1]) : 200;
const CPU_PER_TICK = cpuFlag !== -1 ? Number(args[cpuFlag + 1]) : 1.5;

const BUNDLE = resolve(process.cwd(), 'dist/main.js');
if (!existsSync(BUNDLE)) {
  out.error('[smoke] dist/main.js missing — run `npm run build` first.');
  process.exit(1);
}

/**
 * Install engine globals modelled on the documented behaviour.
 *
 * The CPU counter resets each tick, `RawMemory.segments` is a plain id->string
 * map, and `Memory` is a fresh object the bundle is expected to migrate.
 */
function installEngine({ cpuLimit }) {
  let time = 1;
  let used = 0;

  const cpu = {
    limit: cpuLimit,
    tickLimit: cpuLimit,
    bucket: 0,
    getUsed() {
      return used;
    },
  };

  // Objects the bundle resolves by id. Populated by the colony phase so the
  // real adapter and executor see the room's actual structures.
  const objects = new Map();

  const game = {
    time,
    cpu,
    creeps: {},
    rooms: {},
    getObjectById(id) {
      return objects.get(id) ?? null;
    },
  };

  const rawMemory = {
    segments: {},
    setActiveSegments: (ids) => ids,
  };

  const logs = [];
  globalThis.Game = game;
  globalThis.Memory = {};
  globalThis.RawMemory = rawMemory;
  globalThis.console = {
    ...console,
    log: (...a) => logs.push(a.map(String).join(' ')),
  };

  return {
    game,
    rawMemory,
    logs,
    addObject(id, object) {
      objects.set(id, object);
    },
    memory: () => globalThis.Memory,
    advance() {
      time += 1;
      game.time = time;
      cpu.bucket = Math.min(10000, cpu.bucket + Math.max(0, cpuLimit - used));
      used = 0;
    },
    spend(n) {
      used += n;
    },
  };
}

const engine = installEngine({ cpuLimit: 20 });
const require = createRequire(import.meta.url);
const bundle = require(BUNDLE);

if (typeof bundle.loop !== 'function') {
  out.error(`[smoke] bundle does not export a callable loop (got ${typeof bundle.loop}).`);
  process.exit(1);
}

/**
 * Run ticks, charging `cpu` before each call.
 *
 * Charging BEFORE the call is what makes the kernel's degradation path
 * reachable: the engine bills CPU as work happens, so a tick that is already
 * expensive when the pipeline starts is the case the budget logic exists for.
 * Charging after would leave `getUsed()` at 0 and never exercise it.
 */
function run(ticks, cpu) {
  let failures = 0;
  for (let i = 0; i < ticks; i += 1) {
    engine.spend(cpu);
    try {
      bundle.loop();
    } catch (err) {
      failures += 1;
      if (failures <= 3) out.error(`[smoke] tick ${String(i + 1)} threw: ${err.message}`);
    }
    engine.advance();
  }
  return failures;
}

out.log('[smoke] phase 1: comfortable budget (CPU well under the 20 ms limit)');
const normalFailures = run(TICKS, CPU_PER_TICK);

const normalChecks = [
  ['no tick threw under a comfortable budget', normalFailures === 0, `${normalFailures} exceptions`],
  ['stats segment written', engine.rawMemory.segments[90] !== undefined, ''],
  [
    'no degradation under a comfortable budget',
    !engine.logs.some((l) => l.includes('skipped=')),
    engine.logs.find((l) => l.includes('skipped=')) ?? '',
  ],
];

out.log('');
out.log('[smoke] phase 2: CPU pressure (tick starts near the 20 ms limit)');
const before = engine.logs.length;
const pressuredFailures = run(TICKS, 19);

const pressureChecks = [
  ['no tick threw under pressure', pressuredFailures === 0, `${pressuredFailures} exceptions`],
  [
    'degradation triggered',
    engine.logs.slice(before).some((l) => l.includes('skipped=')),
    'no degrade line emitted',
  ],
  [
    'critical phases never skipped',
    !engine.logs.slice(before).some((l) => /skipped=.*\b(spawn|assign|cleanup)\b/.test(l)),
    engine.logs.slice(before).find((l) => /skipped=.*\b(spawn|assign|cleanup)\b/.test(l)) ?? '',
  ],
];

out.log('');
out.log('[smoke] phase 3: colony against a real recorded room');
const snapshot = newestSnapshot();
let colonyChecks = [];

if (!snapshot) {
  out.log('  SKIP  no recorded snapshot — run `npm run snapshot` first');
} else {
  out.log(`[smoke] replaying room ${snapshot.room} (recorded at gameTime ${String(snapshot.gameTime)})`);

  // Fresh globals: the colony needs its own heap state, and reusing the profile
  // phase's heap would leave stale task leases in place.
  const colony = installEngine({ cpuLimit: 20 });
  const spawnRequests = [];
  const creeps = [];
  const built = buildRoom(snapshot, {
    creeps,
    onSpawn: (req) => {
      spawnRequests.push(req);
      // Register the creep so the next tick sees it, exactly as the engine would
      // once the spawn completes.
      const c = buildCreep(req.name, req.memory?.role ?? 'harvester', 24, 10, snapshot.room, 0);
      creeps.push(c);
      colony.game.creeps[req.name] = c;
      colony.memory.creeps ??= {};
      colony.memory.creeps[req.name] = req.memory ?? {};
    },
  });
  colony.game.rooms[snapshot.room] = built.room;
  colony.memory.creeps = {};
  for (const o of built.objects) colony.addObject(o.id, o);

  // The engine injects these as globals; the bundle's adapter reads them.
  Object.assign(globalThis, CONSTANTS);

  let colonyFailures = 0;
  for (let i = 0; i < 60; i += 1) {
    try {
      bundle.loop();
    } catch (err) {
      colonyFailures += 1;
      if (colonyFailures <= 3) out.error(`[smoke] colony tick ${String(i + 1)} threw: ${err.message}`);
    }
    // A spawn takes a few ticks; complete it so the creep participates.
    for (const s of built.spawns) if (s.spawning) s.spawning = null;
    colony.advance();
  }

  // The colony's per-room line names the room and its derived state.
  const colonyLogs = colony.logs.filter((l) => l.includes(snapshot.room));
  colonyChecks = [
    ['colony ticks did not throw', colonyFailures === 0, `${colonyFailures} exceptions`],
    [
      'the colony issued a spawn request',
      spawnRequests.length > 0,
      `0 requests; last log: ${colonyLogs.at(-1) ?? '(none)'}`,
    ],
    [
      'the first spawn requested is a harvester',
      spawnRequests[0]?.memory?.role === 'harvester',
      JSON.stringify(spawnRequests[0]?.memory ?? null),
    ],
    [
      'the requested body is affordable by the real room',
      spawnRequests.length > 0 && bodyCost(spawnRequests[0].body) <= built.room.energyCapacityAvailable,
      spawnRequests.length > 0
        ? `cost ${String(bodyCost(spawnRequests[0].body))} vs capacity ${String(built.room.energyCapacityAvailable)}`
        : '',
    ],
    [
      'the body includes MOVE, so the creep is not stranded',
      spawnRequests.length > 0 && spawnRequests[0].body.includes('move'),
      JSON.stringify(spawnRequests[0]?.body ?? null),
    ],
    [
      'the colony reported its room state',
      colonyLogs.some((l) => l.includes('BOOTSTRAP')),
      colonyLogs.at(-1) ?? '(no room logs)',
    ],
  ];

  if (colonyLogs.length > 0) out.log(`[smoke] last room log: ${colonyLogs.at(-1)}`);
}

// --- structural assertions --------------------------------------------------

const mem = engine.memory();
const history = engine.rawMemory.segments[90] ? JSON.parse(engine.rawMemory.segments[90]) : [];

const structuralChecks = [
  ['Memory migrated once', mem.version === 1, `version=${mem.version}`],
  ['stats history bounded', history.length > 0 && history.length <= 20, `${history.length} samples`],
  [
    'sample carries the binding constraints',
    typeof history.at(-1)?.cpu?.limit === 'number',
    JSON.stringify(history.at(-1)?.cpu ?? null),
  ],
];

const checks = [...normalChecks, ...pressureChecks, ...colonyChecks, ...structuralChecks];

out.log('');
out.log('[smoke] all checks');
for (const [name, ok, detail] of checks) {
  out.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

out.log('');
out.log(`[smoke] sampled console output (${engine.logs.length} lines total):`);
for (const line of engine.logs.slice(0, 4)) out.log(`        ${line}`);

const failed = checks.filter(([, ok]) => !ok).length;
out.log('');
out.log(
  failed === 0
    ? `[smoke] OK (${TICKS} ticks x 2 phases${snapshot ? ' + colony replay' : ''})`
    : `[smoke] ${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
