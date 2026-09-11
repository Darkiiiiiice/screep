/**
 * Local integration test: run the real bundle against a real engine.
 *
 * This is the layer that was missing, and its absence cost real time. Every
 * failure found on the live server in the last stretch was a PHYSICS failure —
 * pathfinding blocked by another creep, a cached route through an occupied tile,
 * a spawn walled in by its own construction sites, 3-tick-per-tile bodies — and
 * none of them were visible to the existing tests, which assert what the AI
 * DECIDES:
 *
 *   unit tests   pure logic, no engine, no physics
 *   smoke        the real bundle, but a stub engine with `moveTo` stubbed out
 *   replay       real room snapshots, but asserts the INTENT sequence
 *   this file    the real engine: real pathfinding, real fatigue, real energy
 *
 * It runs the same artifact that is uploaded, so what passes here is what the
 * server will run. A tick costs milliseconds instead of the live server's ~4
 * seconds, which is what makes outcome assertions affordable.
 *
 * Must run under Node 24 with GCC 15 — see scripts/engine-setup.sh for why.
 *
 * Usage:
 *   bash scripts/engine-setup.sh     # once
 *   npm run sim [-- --ticks 400]
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENGINE_DIR = resolve(ROOT, '.engine');
const BUNDLE = resolve(ROOT, 'dist/main.js');

// --- preconditions ----------------------------------------------------------

if (!existsSync(resolve(ENGINE_DIR, 'node_modules'))) {
  console.error('[sim] engine not installed. Run: bash scripts/engine-setup.sh');
  process.exit(1);
}
if (!existsSync(BUNDLE)) {
  console.error('[sim] dist/main.js missing. Run: npm run build');
  process.exit(1);
}

// The engine's dependencies must resolve from .engine, not the project.
const requireEngine = createRequire(resolve(ENGINE_DIR, 'package.json'));
const { ScreepsServer, TerrainMatrix } = requireEngine('screeps-server-mockup');

const args = process.argv.slice(2);
const ticksFlag = args.indexOf('--ticks');
// 600 by default: the interesting paths (extensions, containers, the ESTABLISHED
// transition) need long enough for the colony to reach them. A 300-tick default
// ran only to RCL 1, where the container check had nothing to inspect and would
// have reported a vacuous pass — which is worse than no check, because it reads
// as evidence.
const TICKS = ticksFlag !== -1 ? Number(args[ticksFlag + 1]) : 600;

/**
 * Longest tolerated run of ticks with no harvester alive.
 *
 * A harvester dying of old age leaves a respawn window: replacement bodies take
 * 3 ticks per part to build, and the spawn may need ticks to accumulate the
 * energy first. Measured on the healthy 2000-tick run the longest such window
 * was ~30 ticks; 60 leaves comfortable headroom while still being far below the
 * hundreds of ticks a death spiral lasts.
 */
const HARVESTER_GAP_LIMIT = 60;

const out = console;
const bundleSource = readFileSync(BUNDLE, 'utf8');

// --- world ------------------------------------------------------------------

// A source 5 tiles from the spawn and a controller 19 away, mirroring the live
// room's geometry: those distances are what make "fill before travel" and the
// container decision matter, so a toy layout would not exercise them.
const SPAWN = { x: 25, y: 25 };
const SOURCES = [
  { x: 25, y: 20 },
  { x: 20, y: 25 },
];
const CONTROLLER = { x: 44, y: 32 };

async function buildWorld() {
  const server = new ScreepsServer();
  await server.world.reset();

  const terrain = new TerrainMatrix();
  // A walled border, plus an interior wall with a single gap. The gap is what
  // makes pathfinding fallible: a creep can path through it, and a structure
  // placed in it seals the room — the failure that stalled the live colony.
  for (let i = 0; i < 50; i += 1) {
    terrain.set(i, 0, 'wall');
    terrain.set(i, 49, 'wall');
    terrain.set(0, i, 'wall');
    terrain.set(49, i, 'wall');
  }
  for (let x = 30; x < 40; x += 1) {
    if (x === 35) continue; // the gap
    terrain.set(x, 28, 'wall');
  }

  await server.world.addRoom('W0N1');
  await server.world.setTerrain('W0N1', terrain);
  // RCL 2 from the start, deliberately: that is the level where the build paths
  // (extensions, containers, then the ESTABLISHED transition) actually run. An
  // earlier version started at RCL 1, where the container check passed VACUOUSLY
  // — no container is even buildable below level 2, so there was nothing to
  // inspect and the check proved nothing.
  //
  // progressTotal is large so progress never resets on a level-up, which keeps
  // the throughput assertion comparable across the run.
  await server.world.addRoomObject('W0N1', 'controller', CONTROLLER.x, CONTROLLER.y, {
    level: 2,
    progress: 0,
    progressTotal: 100000,
  });
  for (const s of SOURCES) {
    await server.world.addRoomObject('W0N1', 'source', s.x, s.y, {
      energy: 3000,
      energyCapacity: 3000,
      ticksToRegeneration: 0,
    });
  }

  return server;
}

/**
 * Read observable game state from the engine.
 *
 * Deliberately read from the harness side rather than by injecting a probe into
 * the bot: the artifact under test stays byte-for-byte what is deployed, and the
 * observations come from the same source the game client would use.
 */
async function readState(server, botUser) {
  const objects = await server.world.roomObjects('W0N1');
  const byType = (t) => objects.filter((o) => o.type === t);

  const spawn = byType('spawn')[0];
  const controller = byType('controller')[0];

  return {
    time: await server.world.gameTime,
    /**
     * Creeps in the room NOT owned by the bot.
     *
     * Exposed because this scenario must contain none, and the first version
     * quietly contained one: the inert blocker was written with `user: '2'`,
     * which is the mockup's built-in Invader user, so the run silently became a
     * permanent siege. That is a different scenario from the one intended, and it
     * concealed a real bug — the threat policy was inert, and a hostile in the
     * room was exactly what would have revealed it.
     */
    foreignCreeps: objects.filter((o) => o.type === 'creep' && o.user !== botUser).length,
    spawnEnergy: spawn ? (spawn.store?.energy ?? 0) : -1,
    spawnCapacity: spawn ? (spawn.storeCapacityResource?.energy ?? 300) : 300,
    spawning: spawn?.spawning ? spawn.spawning.name : null,
    controllerLevel: controller ? (controller.level ?? -1) : -1,
    controllerProgress: controller ? (controller.progress ?? -1) : -1,
    sites: byType('constructionSite').length,
    objects: byType('constructionSite').map((c) => ({
      structureType: c.structureType,
      x: c.x,
      y: c.y,
    })),
    extensions: byType('extension').length,
    containers: byType('container').length,
    /** Completed structures, so a finished container counts as well as a site. */
    built: byType('container')
      .concat(byType('extension'))
      .map((c) => ({ structureType: c.structureType, x: c.x, y: c.y })),
    creeps: byType('creep').map((c) => ({
      name: c.name,
      x: c.x,
      y: c.y,
      energy: c.store?.energy ?? 0,
      fatigue: c.fatigue ?? 0,
      user: c.user,
      ticksToLive: c.ticksToLive ?? null,
    })),
  };
}

/** State samples, one per tick. */
const samples = [];

// --- run --------------------------------------------------------------------

out.log(`[sim] ticks=${TICKS}  node=${process.version}  bundle=${(bundleSource.length / 1024).toFixed(1)} KiB`);

const server = await buildWorld();
const bot = await server.world.addBot({
  username: 'colony',
  room: 'W0N1',
  x: SPAWN.x,
  y: SPAWN.y,
  modules: { main: bundleSource },
});

// An inert creep parked in the spawn's approach corridor.
//
// This is not decoration: the live failure needed exactly this — an immobile
// creep one tile from the spawn that other creeps had to path around. Without
// it, a pathfinding bug that stalls creeps behind a blocker cannot reproduce
// here, and the harness cannot see the failure it exists to catch.
//
// It is owned by the bot, and that matters. It was first written with `user: '2'`,
// which is the mockup's built-in Invader user (see screeps-server-mockup
// world.js) — so it registered as a hostile and the whole run silently became a
// permanent siege. That conflated two unrelated scenarios, and it hid a real bug:
// the threat policy in plan.ts was inert, and a hostile in the room was the only
// thing that would have exercised it. An obstacle must not smuggle in a siege.
//
// Its role is left unassigned so the AI has no behaviour for it, matching the
// live case: `decide` falls through to null and it never moves.
await server.world.addRoomObject('W0N1', 'creep', 24, 26, {
  name: 'inert-blocker',
  user: bot.id,
  hits: 100,
  hitsMax: 100,
  body: [{ type: 'move', hits: 100 }],
  store: { energy: 0 },
});

const botLogs = [];
bot.on('console', (logs) => {
  for (const line of logs) if (!/^\[\d+\] \(\+\d+ suppressed\)$/.test(line)) botLogs.push(line);
});

await server.start();

const startedAt = Date.now();
for (let i = 0; i < TICKS; i += 1) {
  await server.tick();
  // Sampling every tick is what makes the stall and movement checks possible;
  // it costs one engine read per tick and no game CPU.
  samples.push(await readState(server, bot.id));
}
const elapsed = (Date.now() - startedAt) / 1000;

// Decision log, for post-mortem: every tick's own summary line, including the
// spawn reason. Written before any assertion so a crash still leaves evidence.
writeFileSync('/tmp/sim-logs.txt', botLogs.join('\n'));

server.stop();

// --- assertions -------------------------------------------------------------

/**
 * Every check is an OUTCOME a player could observe in the game client. None of
 * them inspect the AI's intent, because intent was never what broke.
 */
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

const last = samples.at(-1);
const first = samples[0];

check('the engine produced state samples', samples.length > 0, `${String(samples.length)} samples`);

if (first && last) {
  // 1. The colony bootstrapped: a creep exists and keeps existing.
  const maxCreeps = Math.max(...samples.map((s) => s.creeps.length));
  check('creeps were spawned and survive', maxCreeps > 0, `peak ${String(maxCreeps)} creeps`);

  const endedWithCreeps = last.creeps.length > 0;
  check('colony is not extinct at the end', endedWithCreeps, `${String(last.creeps.length)} alive`);

  // 2. The economy is turning: the spawn was refilled at some point.
  const peakSpawn = Math.max(...samples.map((s) => s.spawnEnergy));
  check('energy was delivered to the spawn', peakSpawn > 50, `peak spawn energy ${String(peakSpawn)}`);

  // 3. The controller advanced, which is the whole objective.
  const progressGain = last.controllerProgress - first.controllerProgress;
  const levelledUp = last.controllerLevel > first.controllerLevel;
  check(
    'controller progressed',
    progressGain > 0 || levelledUp,
    `progress +${String(progressGain)}, level ${String(first.controllerLevel)} -> ${String(last.controllerLevel)}`,
  );

  // 4. Nothing is frozen. This is the check that would have caught the stalled
  //    creeps directly instead of via a stalled controller.
  const frozen = [];
  for (const creep of last.creeps) {
    const history = samples
      .map((s) => s.creeps.find((c) => c.name === creep.name))
      .filter((c) => c !== undefined);
    if (history.length < 12) continue;

    const positions = new Set(history.map((c) => `${String(c.x)},${String(c.y)}`));
    const energyLevels = new Set(history.map((c) => c.energy));
    // A creep that has not moved tile AND has not changed energy for 12 ticks is
    // doing nothing at all. Occupying a source for several ticks is normal, so
    // both must be static before this fires.
    if (positions.size <= 2 && energyLevels.size === 1) {
      frozen.push(`${creep.name} stuck near ${String(creep.x)},${String(creep.y)}`);
    }
  }
  check('no creep is frozen with nothing to do', frozen.length === 0, frozen.join('; '));

  // 5. Movement is at full speed. A body that moves slower than 1 tile/tick is a
  //    permanent throughput loss, and it is invisible without a real engine.
  const slow = [];
  for (const creep of last.creeps) {
    const history = samples
      .map((s) => s.creeps.find((c) => c.name === creep.name))
      .filter((c) => c !== undefined);
    for (let i = 1; i < history.length; i += 1) {
      const moved =
        Math.max(
          Math.abs(history[i].x - history[i - 1].x),
          Math.abs(history[i].y - history[i - 1].y),
        ) > 0;
      // fatigue > 0 while standing still means the body cannot move each tick.
      if (!moved && history[i].fatigue > 0) {
        slow.push(`${creep.name} fatigue=${String(history[i].fatigue)}`);
        break;
      }
    }
  }
  check('no creep is movement-limited by its body', slow.length === 0, slow.join('; '));

  // 6. Throughput: the outcome that actually matters, and the check with teeth.
  //
  // A binary "is any creep frozen" test was not enough: the live stall showed up
  // first as degraded throughput, and a creep can lose most of its working time
  // to path thrash without ever sitting perfectly still. Comparing the passing
  // and failing runs of this file, controller progress was 130 versus 94 over
  // 300 ticks — a clear signal that a freeze test missed entirely.
  //
  // The floor is calibrated from a known-good run with margin, and exists to fail
  // loudly when a movement change costs throughput.
  const progressRate = (last.controllerProgress - first.controllerProgress) / samples.length;
  check(
    'controller progresses at a usable rate',
    progressRate >= 0.3,
    `${progressRate.toFixed(3)}/tick (floor 0.30)`,
  );

  // 7. Containers end up beside a source, which is the only place they help.
  //
  // Measured on the live room: a spawn-anchored search put containers four and
  // six tiles from the nearest source, where they buffer nothing and the
  // harvester keeps walking the full trip. The engine can see adjacency directly.
  const objectives = [];
  const objectSamples = (last.objects ?? []).concat(last.built ?? []);
  const containerSamples = objectSamples.filter((o) => o.structureType === 'container');

  // A vacuous pass is not a pass: if the run never produced a container, this
  // check has proven nothing about placement.
  if (containerSamples.length === 0) {
    objectives.push(
      `no container was started in ${String(samples.length)} ticks (check would be vacuous — raise --ticks)`,
    );
  }

  for (const c of containerSamples) {
    const nearest = Math.min(
      ...SOURCES.map((sPos) => Math.max(Math.abs(c.x - sPos.x), Math.abs(c.y - sPos.y))),
    );
    if (nearest > 2) objectives.push(`container at (${String(c.x)},${String(c.y)}) is ${String(nearest)} tiles from a source`);
  }
  check('containers sit beside a source', objectives.length === 0, objectives.join('; '));

  // 8. The room is a pure economy scenario, with no hostiles in it.
  //
  // This is a guard on the FIXTURE, not on the AI. The intended scenario is
  // "pathfinding around an inert obstacle", and a foreign creep in the room turns
  // it into "operate under siege" — a different scenario that also suppresses
  // upgrading. Asserting its absence keeps the two from silently becoming one.
  const sieged = samples.filter((s) => s.foreignCreeps > 0).length;
  check(
    'the room has no foreign creeps (obstacle, not a siege)',
    sieged === 0,
    `${String(sieged)}/${String(samples.length)} ticks had a foreign creep in the room`,
  );

  // 9. Long runs: a full creep lifecycle must pass without a population gap.
  //
  // The 600-tick gate cannot see this failure class at all — no creep reaches
  // its 1500-tick lifespan inside it. The death spiral measured live (harvester
  // died, first respawn failed, colony mined by hand from zero) only exists
  // beyond tick 1500. So when the run is long enough to cross a death, assert
  // the lifecycle actually closed: a creep died, a replacement was born, and the
  // colony never hit zero creeps after its first spawn.
  //
  // "The run crossed a death" is checked against sampled names, not assumed from
  // the tick count, so a future fixture change can't silently empty this check.
  if (TICKS >= 1600) {
    const firstSpawnIdx = samples.findIndex((s) => s.creeps.length > 0);
    if (firstSpawnIdx === -1) {
      check('colony survived a full creep lifecycle', false, 'no creep ever spawned');
    } else {
      const earlyNames = new Set(
        samples.slice(firstSpawnIdx, firstSpawnIdx + 400).flatMap((s) => s.creeps.map((c) => c.name)),
      );
      const lateNames = new Set(
        samples.slice(-200).flatMap((s) => s.creeps.map((c) => c.name)),
      );
      const newNamesLate = [...lateNames].filter((n) => !earlyNames.has(n));
      // Population > 0 is too weak a floor: the injected reserve bug left ONE
      // creep alive (an upgrader idling for want of energy) and still passed,
      // while throughput collapsed to 0.267/tick and progress fell to 534 vs
      // 1510. The contract is that INCOME survives, and income is harvesters.
      //
      // But "a harvester exists at every tick" is too strict the other way: a
      // harvester that dies of old age leaves a short window while its
      // replacement is still being born (a 4-part body takes 12 ticks to spawn,
      // longer if the spawn has to accumulate energy first). That window is
      // normal; a death spiral is a SUSTAINED harvesterless gap. So bound the
      // gap, not the tick.
      let streak = 0;
      let longest = 0;
      let longestStart = -1;
      let cursor = firstSpawnIdx;
      for (let i = firstSpawnIdx; i < samples.length; i += 1) {
        if (samples[i].creeps.some((c) => c.name.includes('harvester'))) {
          if (streak > longest) {
            longest = streak;
            longestStart = cursor;
          }
          streak = 0;
          cursor = i + 1;
        } else {
          streak += 1;
        }
      }
      if (streak > longest) {
        longest = streak;
        longestStart = cursor;
      }

      // Full window detail when it exceeds the limit: when it started, what was
      // alive instead, and what the spawn was holding. Without this the number is
      // an accusation with no evidence attached.
      let detail = `longest run with no harvester=${String(longest)} ticks (limit ${String(HARVESTER_GAP_LIMIT)})`;
      if (longest > HARVESTER_GAP_LIMIT && longestStart >= 0) {
        const win = samples.slice(longestStart, longestStart + longest);
        detail += `; window ticks ${String(win[0].time)}-${String(win[win.length - 1].time)}`;
        detail += `, roles inside: ${JSON.stringify(
          win[win.length - 1].creeps.map((c) => c.name.split('-')[0]),
        )}`;
        detail += `, spawn energy ${String(win[0].spawnEnergy)}->${String(win[win.length - 1].spawnEnergy)}`;
        detail += `, controller ${String(win[0].controllerProgress)}->${String(win[win.length - 1].controllerProgress)}`;
        writeFileSync('/tmp/sim-window.json', JSON.stringify(win, null, 2));
        detail += ' (window dumped to /tmp/sim-window.json)';
      }

      check(
        'colony survived a full creep lifecycle (death -> respawn, no sustained gap)',
        newNamesLate.length > 0 && longest <= HARVESTER_GAP_LIMIT,
        detail,
      );
    }
  }

  // 10. The AI's own error channel stayed quiet. Console lines are captured, so
  //    an error flood is visible as repeated `[error]` lines.
  const errorLines = botLogs.filter((l) => l.includes('[error]'));
  check('no error flood from the AI', errorLines.length <= 3, `${String(errorLines.length)} error lines`);
}

out.log('');
for (const c of checks) {
  out.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` — ${c.detail}`}`);
}

out.log('');
out.log(`[sim] ${String(TICKS)} ticks in ${elapsed.toFixed(1)}s (${((elapsed / TICKS) * 1000).toFixed(1)} ms/tick, vs ~4000 ms live)`);
if (last) {
  out.log(
    `[sim] final: RCL${String(last.controllerLevel)} progress=${String(last.controllerProgress)} creeps=${String(last.creeps.length)} spawn=${String(last.spawnEnergy)} sites=${String(last.sites)}`,
  );
  out.log(
    `[sim] sites by type: ${JSON.stringify(
      (last.objects ?? []).reduce((a, o) => {
        a[o.structureType] = (a[o.structureType] ?? 0) + 1;
        return a;
      }, {}),
    )}`,
  );
}

const failed = checks.filter((c) => !c.ok).length;
out.log(failed === 0 ? '[sim] OK' : `[sim] ${String(failed)} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
