import { energyBudget, populationPlan, retryDelay, trackProgress, type ProgressState } from '../domain/bootstrap';
import { validatePolicy, type Capabilities } from '../domain/config';
import { runLogistics } from './logistics';
import { runDefense } from './defense';
import { flushTraffic, requestMove } from './traffic';

interface WorkerState {
  phase: 'collect' | 'deliver';
  source?: string;
  progress?: ProgressState;
  retries: number;
  retryAt?: number;
  blocked?: string;
}
interface RuntimeMemory {
  schema: number;
  workers: Record<string, WorkerState>;
  cursor: number;
  errors: { tick: number; scope: string; message: string }[];
  rooms: Record<string, { target: number; population: number; reserve: number; reason: string; spawnUtilization: number }>;
  heartbeat: number;
  degraded: boolean;
  capabilities?: Capabilities;
  workerCursors?: Record<string, number>;
  policyIssues?: string[];
}
declare global {
  interface Memory { bootstrap?: RuntimeMemory; policy?: unknown; logisticsEnabled?: boolean }
}

function isolate(state: RuntimeMemory, scope: string, action: () => void) {
  try { action(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!state.errors.some(e => e.scope === scope && e.message === message && Game.time - e.tick < 100)) {
      state.errors.push({ tick: Game.time, scope, message });
      state.errors = state.errors.slice(-20);
      console.log(`[M1] ${scope}: ${message}`);
    }
  }
}

function move(creep: Creep, target: RoomPosition, range: number, fresh = false) {
  if (Memory.logisticsEnabled === true) { requestMove(creep, target, range); return; }
  creep.moveTo(target, { range, reusePath: fresh ? 0 : 5, maxRooms: 1, ignoreCreeps: false });
}

function work(creep: Creep, room: Room, sources: Source[], state: RuntimeMemory, reserve: number, target: number) {
  if (creep.spawning || creep.getActiveBodyparts(WORK) === 0 || creep.getActiveBodyparts(CARRY) === 0 || creep.getActiveBodyparts(MOVE) === 0) return;
  const worker = state.workers[creep.name] ??= { phase: creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? 'deliver' : 'collect', retries: 0 };
  const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  if ((worker.retryAt ?? 0) > Game.time) return;
  if (worker.progress && worker.progress.energy !== energy) {
    worker.retries = 0;
    delete worker.blocked;
    delete worker.retryAt;
  }
  worker.progress = trackProgress(worker.progress, creep.pos.x, creep.pos.y, energy);
  const stalled = Memory.logisticsEnabled !== true && worker.progress.unchanged >= 12;
  if (stalled) {
    delete worker.source;
    worker.progress.unchanged = 0;
    worker.retries = Math.min(6, worker.retries + 1);
    if (worker.retries >= 3) {
      worker.blocked = 'no-physical-progress';
      worker.retryAt = Game.time + retryDelay(worker.retries);
      return;
    }
    // Release a blocked work tile, then reconsider the target next tick.
    const directions: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
    creep.move(directions[(Game.time + worker.retries) % directions.length]!);
    return;
  }
  if (!energy) worker.phase = 'collect';
  if (!creep.store.getFreeCapacity(RESOURCE_ENERGY)) worker.phase = 'deliver';
  // The controller deadline can interrupt a partially loaded collection trip.
  if (energy && (room.controller?.ticksToDowngrade ?? Infinity) < 3000) worker.phase = 'deliver';
  if (worker.phase === 'collect') {
    const drop = creep.pos.findClosestByRange(room.find(FIND_DROPPED_RESOURCES).filter(r => r.resourceType === RESOURCE_ENERGY && r.amount >= 20));
    if (drop && creep.pos.getRangeTo(drop) <= 3) {
      if (creep.pickup(drop) === ERR_NOT_IN_RANGE) move(creep, drop.pos, 1);
      return;
    }
    // Recover energy from existing assets, while never withdrawing spawn reserves.
    const stores = room.find(FIND_STRUCTURES).filter((s): s is StructureContainer | StructureStorage =>
      (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) && s.store.getUsedCapacity(RESOURCE_ENERGY) >= 50);
    const store = creep.pos.findClosestByRange(stores);
    if (store && creep.pos.getRangeTo(store) <= 5) {
      if (creep.withdraw(store, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) move(creep, store.pos, 1);
      return;
    }
    const available = sources.filter(source => source.energy > 0);
    const counts = (source: Source) => Object.entries(state.workers).filter(([name, value]) => name !== creep.name && value.source === source.id && Game.creeps[name]).length;
    const source = available.find(s => s.id === worker.source) ?? available.sort((a, b) => counts(a) * 15 + creep.pos.getRangeTo(a) - counts(b) * 15 - creep.pos.getRangeTo(b))[0];
    if (!source) { if (energy) worker.phase = 'deliver'; return; }
    worker.source = source.id;
    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) move(creep, source.pos, 1);
    else if (result !== OK) delete worker.source;
    return;
  }
  const controller = room.controller;
  const urgent = controller && controller.ticksToDowngrade < 3000;
  const sinks = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureSpawn | StructureExtension =>
    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
  const sink = creep.pos.findClosestByRange(sinks);
  const loneWorker = room.find(FIND_MY_CREEPS).filter(c => !c.spawning && c.getActiveBodyparts(WORK) > 0).length <= 1;
  if (sink && room.energyAvailable < target && (!urgent || (room.energyAvailable < reserve && loneWorker))) {
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) move(creep, sink.pos, 1);
    return;
  }
  if (controller?.my) {
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) move(creep, controller.pos, 3);
  }
}

export function runBootstrap(): void {
  const state = Memory.bootstrap ??= { schema: 1, workers: {}, cursor: 0, errors: [], rooms: {}, heartbeat: 0, degraded: false };
  if (state.schema !== 1) throw new Error(`unsupported bootstrap schema ${state.schema}`);
  if (Game.time % 25 === 0) {
    for (const name of Object.keys(state.workers)) if (!Game.creeps[name]) delete state.workers[name];
  }
  const rooms = Object.values(Game.rooms).filter(room => room.controller?.my).sort((a, b) => a.name.localeCompare(b.name));
  const limit = Math.min(Game.cpu.tickLimit ?? Game.cpu.limit, Game.cpu.limit);
  state.degraded = Game.cpu.getUsed() > limit * 0.8;
  const policy = validatePolicy(Memory.policy ?? {});
  state.policyIssues = policy.issues;
  state.workerCursors ??= {};
  state.capabilities = { observedAt: Game.time, cpuLimit: Game.cpu.limit, gcl: Game.gcl?.level ?? 0, rooms: {} };
  for (const room of Object.values(Game.rooms)) {
    state.capabilities.rooms[room.name] = {
      visibility: 'visible', owned: room.controller?.my ?? false, rcl: room.controller?.level ?? null,
      spawnCount: room.find(FIND_MY_SPAWNS).length, energyCapacity: room.energyCapacityAvailable,
    };
  }
  for (const name of Object.keys(state.rooms)) {
    if (!Game.rooms[name]) state.capabilities.rooms[name] = { visibility: 'unknown', owned: true, rcl: null, spawnCount: null, energyCapacity: null };
  }
  const activeRooms: RuntimeMemory['rooms'] = {};
  const executionLimit = Math.max(0, limit - 2);
  for (let i = 0; i < rooms.length; i++) {
    if (Game.cpu.getUsed() >= executionLimit) { state.degraded = true; break; }
    const room = rooms[(i + state.cursor) % rooms.length]!;
    isolate(state, room.name, () => {
      isolate(state, 'defense', () => runDefense(room));
      const sources = room.find(FIND_SOURCES);
      const creeps = room.find(FIND_MY_CREEPS).filter(c => c.getActiveBodyparts(WORK) > 0 && c.getActiveBodyparts(CARRY) > 0 && c.getActiveBodyparts(MOVE) > 0);
      const spawns = room.find(FIND_MY_SPAWNS);
      const travel = Math.max(10, ...sources.map(s => spawns[0]?.pos.getRangeTo(s) ?? 50)) * 4;
      const plan = populationPlan({ energy: room.energyAvailable, capacity: room.energyCapacityAvailable, sources: sources.length,
        workers: creeps.map(c => ({ ttl: c.ticksToLive ?? 1500, spawning: c.spawning, work: c.getActiveBodyparts(WORK) })), travel, spawnBusy: spawns.every(s => s.spawning) });
      const budget = energyBudget(room.energyCapacityAvailable, policy.policy.reserveEnergy, policy.policy.targetEnergy, plan.reserve);
      activeRooms[room.name] = { target: plan.target, population: creeps.length, reserve: budget.reserve, reason: !spawns.length ? 'no-spawn-local-survival' : room.energyAvailable < plan.cost && plan.reserve ? 'income-or-delivery-limited' : plan.reason, spawnUtilization: plan.spawnUtilization };
      // A released spawn wait escalates to an emergency birth, bypassing the
      // reserve that starved it. The body still follows what the room can afford:
      // a construction room needs the double-WORK body to keep site throughput.
      const constructionBody = Memory.logisticsEnabled === true && creeps.length >= 2 && room.energyCapacityAvailable >= 300 && room.find(FIND_MY_CONSTRUCTION_SITES).some(s => s.structureType === STRUCTURE_CONTAINER);
      const escalation = Memory.spawnEscalation?.[room.name];
      if (escalation !== undefined) {
        if (Game.time - escalation > 5) delete Memory.spawnEscalation![room.name];
        else {
          const idle = spawns.find(s => !s.spawning);
          if (idle && room.energyAvailable >= (constructionBody ? 300 : 200)) {
            idle.spawnCreep(constructionBody ? [WORK, WORK, CARRY, MOVE] : [WORK, CARRY, MOVE], `worker-${room.name}-${Game.time}`, { memory: { role: 'worker' } });
            delete Memory.spawnEscalation![room.name];
          }
        }
      }
      if (plan.spawn) {
        const spawn = spawns.find(s => !s.spawning);
        const body: BodyPartConstant[] = [];
        for (let n = 0; n < plan.units; n++) body.push(WORK, CARRY, MOVE);
        if (!constructionBody || room.energyAvailable >= 300) {
          spawn?.spawnCreep(constructionBody ? [WORK, WORK, CARRY, MOVE] : body, `worker-${room.name}-${Game.time}`, { memory: { role: 'worker' } });
        }
      }
      const cursor = state.workerCursors![room.name] ?? 0;
      const spawnWaiting = spawns.length > 0 && plan.reserve > 0 && !plan.spawn && room.energyAvailable < plan.cost && spawns.some(s => !s.spawning);
      const handled = Memory.logisticsEnabled === true && !state.degraded ? runLogistics(room, creeps, sources, { spawnWaiting }) : new Set<string>();
      creeps.sort((a, b) => a.name.localeCompare(b.name));
      for (let j = 0; j < creeps.length; j++) {
        if (Game.cpu.getUsed() >= executionLimit) { state.degraded = true; break; }
        const index = (cursor + j) % creeps.length;
        const creep = creeps[index]!;
        if (handled.has(creep.name)) continue;
        state.workerCursors![room.name] = (index + 1) % creeps.length;
        isolate(state, creep.name, () => work(creep, room, sources, state, budget.reserve, budget.target));
      }
      if (Memory.logisticsEnabled === true) flushTraffic(room);
    });
  }
  state.rooms = { ...state.rooms, ...activeRooms };
  for (const name of Object.keys(state.rooms)) {
    if (Game.rooms[name] && !Game.rooms[name]!.controller?.my) {
      delete state.rooms[name];
      delete state.workerCursors[name];
      delete Memory.logisticsTasks?.[name];
      delete Memory.spawnEscalation?.[name];
    }
  }
  state.cursor = (state.cursor + 1) % Math.max(1, rooms.length);
  state.heartbeat = Game.time;
  if (!state.degraded && Game.time % 20 === 0) {
    RawMemory.segments[0] = JSON.stringify({ tick: Game.time, version: 'm1', cpu: Game.cpu.getUsed(), bucket: Game.cpu.bucket, rooms: state.rooms, issues: policy.issues });
  }
}
