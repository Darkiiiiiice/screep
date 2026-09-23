import { energyBudget, mharvesterSpawnNeed, minerSpawnNeed, populationPlan, retryDelay, trackProgress, type ProgressState } from '../domain/bootstrap';
import { healerSpawnNeed } from '../domain/combat';
import { validatePolicy, type Capabilities } from '../domain/config';
import { guardSpawnNeed } from '../domain/combat';
import { STORAGE_RESERVE_FLOOR } from '../domain/logistics';
import { claimerSpawnNeed, colonizerSpawnNeed, pioneerSpawnNeed, remoteHaulerSpawnNeed, remoteMinerSpawnNeed } from '../domain/intel';
import { attackerSpawnNeed, evaluateRaidTargets } from '../domain/expedition';
import { runLogistics, runMinerals, runMiners } from './logistics';
import { driveLabs } from './labs';
import { runMarket } from './market';
import { driveFactory } from './factory';
import { driveGuards, driveHealers, runDefense } from './defense';
import { driveLinks } from './links';
import { flushTraffic, requestMove } from './traffic';
import { driveClaimers, driveColonizers, drivePioneers, driveRemoteMining, driveScouts, intelState, maybeSpawnScout, runEvaluation } from './intel';
import { driveRaiders } from './expedition';

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
    // storage 保底(M6-1):升级护卫的产业性收集不抽保底——降级紧急(<3000,
    // 房间存亡)除外。容器不受限。
    const stores = room.find(FIND_STRUCTURES).filter((s): s is StructureContainer | StructureStorage => {
      if (s.structureType === STRUCTURE_CONTAINER) return s.store.getUsedCapacity(RESOURCE_ENERGY) >= 50;
      if (s.structureType !== STRUCTURE_STORAGE) return false;
      const downgrade = room.controller?.ticksToDowngrade ?? Infinity;
      return downgrade < 3000 || s.store.getUsedCapacity(RESOURCE_ENERGY) > STORAGE_RESERVE_FLOOR;
    });
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
    // Engine creep memory: claims (minerSource/containerBuilder/repairTarget)
    // outlive their owners without this sweep; spawning creeps are safe because
    // Game.creeps lists them from spawnCreep on.
    for (const name of Object.keys(Memory.creeps ?? {})) if (!Game.creeps[name]) delete Memory.creeps[name];
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
      isolate(state, 'defense', () => runDefense(room, policy.policy.allies));
      isolate(state, 'guard', () => driveGuards(room, policy.policy.allies));
      isolate(state, 'healer', () => driveHealers(room, policy.policy.allies));
      isolate(state, 'links', () => driveLinks(room));
      const sources = room.find(FIND_SOURCES);
      const roomCreeps = room.find(FIND_MY_CREEPS);
      const creeps = roomCreeps.filter(c => c.memory.role !== 'miner' && c.memory.role !== 'pioneer' && c.memory.role !== 'mharvester' && c.getActiveBodyparts(WORK) > 0 && c.getActiveBodyparts(CARRY) > 0 && c.getActiveBodyparts(MOVE) > 0);
      const miners = roomCreeps.filter(c => c.memory.role === 'miner');
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
      const spawnWaiting = spawns.length > 0 && plan.reserve > 0 && !plan.spawn && room.energyAvailable < plan.cost && spawns.some(s => !s.spawning);
      // 专职矿工补员:工人补员(plan.spawn)与储备等待(spawnWaiting)均优先;
      // 矿工花的是满员工人口粮之外的盈余(§3.1 补员优先)。
      if (!plan.spawn) {
        const idle = spawns.find(s => !s.spawning);
        if (idle) {
          // 守卫:M7 机动防御第一顺位(工人地板之后)——武装入侵在场时抢占
          // 全部盈余支出;损失预算尽(劣势战场)则停开票,不再白烧 260 身体。
          const armedHostiles = room.find(FIND_HOSTILE_CREEPS)
            .filter(c => !policy.policy.allies.includes(c.owner?.username ?? ''))
            .filter(c => c.body.some(p => p.type === ATTACK || p.type === RANGED_ATTACK));
          const guards = Object.values(Game.creeps).filter(c => c.memory.role === 'guard' && c.room.name === room.name);
          const guardTtls = guards.map(c => c.ticksToLive ?? 0);
          const guardNeed = guardSpawnNeed({
            hostiles: armedHostiles.map(c => ({ armed: c.body.filter(p => p.type === ATTACK || p.type === RANGED_ATTACK).length, hits: c.hits })),
            guards: guards.length, guardTtl: guardTtls.length ? Math.max(...guardTtls) : undefined,
            capacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
            losses: Memory.guardLoss?.[room.name]?.count ?? 0,
          });
          if (guardNeed) idle.spawnCreep([ATTACK, ATTACK, MOVE, MOVE], `guard-${room.name}-${Game.time}`, { memory: { role: 'guard' } });
          else if (healerSpawnNeed({
            hostiles: armedHostiles.map(c => ({ armed: c.body.filter(p => p.type === ATTACK || p.type === RANGED_ATTACK).length, hits: c.hits })),
            guards: guards.length,
            healers: Object.values(Game.creeps).filter(c => c.memory.role === 'healer' && c.room.name === room.name).length,
            healerTtl: (() => { const t = Object.values(Game.creeps).filter(c => c.memory.role === 'healer' && c.room.name === room.name).map(c => c.ticksToLive ?? 0); return t.length ? Math.max(...t) : undefined; })(),
            capacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
          })) idle.spawnCreep([HEAL, HEAL, MOVE, MOVE], `healer-${room.name}-${Game.time}`, { memory: { role: 'healer' } });
          else {
          const containers = room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER);
          const need = minerSpawnNeed({ capacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
            workerCount: creeps.length, workerSpawnPending: spawnWaiting,
            sources: sources.map(s => ({ id: s.id, hasContainer: containers.some(c => c.pos.isNearTo(s)), minerAlive: miners.some(m => m.memory.minerSource === s.id) })) });
          if (need) idle.spawnCreep([WORK, WORK, WORK, WORK, WORK, CARRY, MOVE], `miner-${room.name}-${Game.time}`, { memory: { role: 'miner', minerSource: need } });
          else {
            // 预定者:矿工需求落空后才轮到的第二顺位盈余支出(§3.9 CLAIM/RESERVE)。
            // 交接 TTL 取全体在飞预定者的最大值:继任者在孵后旧者的低 TTL
            // 不再触发重复孵化(否则每个 tick 都补一具 650)。
            const claimerTtls = Object.values(Game.creeps).filter(c => c.memory.role === 'claimer').map(c => c.ticksToLive ?? 0);
            const claimTarget = claimerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
              energyAvailable: room.energyAvailable, claimerAlive: claimerTtls.length > 0, claimerTtl: claimerTtls.length ? Math.max(...claimerTtls) : undefined,
              me: idle.owner.username, now: Game.time });
            if (claimTarget) idle.spawnCreep([CLAIM, MOVE], `claimer-${room.name}-${Game.time}`, { memory: { role: 'claimer', claimTarget } });
            else {
              // 远程机组:预定生效后的第三顺位盈余(§3.9 DEPLOY)——矿工先行,
              // 在岗后按 REMOTE_HAULERS_PER_MINER 配搬运工。
              // 预定者需求挂起(各门齐、只差能量)时机组暂停孵化攒 650:预定是
              // 机组的命脉,交接窗口被低价机组零件截胡会造成预定真空(线上实证
              // 2026-09-18:claimer 寿终撞上机组孵化期,真空 ~400 tick)。
              const claimPending = claimerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
                energyAvailable: room.energyCapacityAvailable, claimerAlive: claimerTtls.length > 0, claimerTtl: claimerTtls.length ? Math.max(...claimerTtls) : undefined,
                me: idle.owner.username, now: Game.time }) !== null;
              if (!claimPending) {
                const remoteMiners = Object.values(Game.creeps).filter(c => c.memory.role === 'remoteMiner').length;
                const remoteHaulers = Object.values(Game.creeps).filter(c => c.memory.role === 'remoteHauler').length;
                const rMinerTarget = remoteMinerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
                  energyAvailable: room.energyAvailable, minerAlive: remoteMiners > 0, me: idle.owner.username, now: Game.time });
                if (rMinerTarget) {
                  idle.spawnCreep([WORK, WORK, WORK, WORK, WORK, CARRY, MOVE], `rminer-${room.name}-${Game.time}`, { memory: { role: 'remoteMiner', remoteTarget: rMinerTarget, home: room.name } });
                } else {
                  const rHaulerTarget = remoteHaulerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
                    energyAvailable: room.energyAvailable, haulers: remoteHaulers, miners: remoteMiners, me: idle.owner.username, now: Game.time });
                  if (rHaulerTarget) idle.spawnCreep([CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE], `rhauler-${room.name}-${Game.time}`, { memory: { role: 'remoteHauler', remoteTarget: rHaulerTarget, home: room.name } });
                  else {
                    // 殖民者:第四顺位盈余(M5)。GCL 空额是硬闸——名额不足时
                    // 不浪费派兵(验收原文);线上 GCL1 期间此门恒关,属设计行为。
                    const colonizeTarget = colonizerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
                      energyAvailable: room.energyAvailable, colonizerAlive: Object.values(Game.creeps).some(c => c.memory.role === 'colonizer'),
                      gclFreeSlots: Game.gcl.level - Object.values(Game.rooms).filter(r => r.controller?.my).length, now: Game.time });
                    if (colonizeTarget) idle.spawnCreep([CLAIM, MOVE], `colonizer-${room.name}-${Game.time}`, { memory: { role: 'colonizer', colonizeTarget, home: room.name } });
                    else {
                      // 启动队:第五顺位盈余(M5-3)。以殖民台账为令箭,给已占领
                      // 而 spawn 未落成的殖民地补先遣(自采自建,200/只)。
                      const pioneerCounts: Record<string, number> = {};
                      for (const c of Object.values(Game.creeps)) {
                        if (c.memory.role !== 'pioneer') continue;
                        const colony = c.memory.colony;
                        if (colony) pioneerCounts[colony] = (pioneerCounts[colony] ?? 0) + 1;
                      }
                      const pioneerTarget = pioneerSpawnNeed({ intel: intelState(), workers: creeps.length, capacity: room.energyCapacityAvailable,
                        energyAvailable: room.energyAvailable, pioneers: pioneerCounts, me: idle.owner.username, now: Game.time });
                      if (pioneerTarget) idle.spawnCreep([WORK, CARRY, MOVE], `pioneer-${room.name}-${Game.time}`, { memory: { role: 'pioneer', colony: pioneerTarget, home: room.name } });
                      else {
                        // 采矿区:第六顺位盈余(M6-4)。extractor+terminal 落成、
                        // 矿体有存量才开票; minerals 是慢滴流,一具足够。
                        const mineral = room.find(FIND_MINERALS)[0];
                        const mNeed = mharvesterSpawnNeed({
                          capacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
                          workerCount: creeps.length, workerSpawnPending: spawnWaiting,
                          extractorOwned: room.find(FIND_MY_STRUCTURES).some(s => s.structureType === STRUCTURE_EXTRACTOR),
                          terminalOwned: room.find(FIND_MY_STRUCTURES).some(s => s.structureType === STRUCTURE_TERMINAL),
                          mineralAmount: mineral?.mineralAmount ?? 0,
                          harvesterAlive: Object.values(Game.creeps).some(c => c.memory.role === 'mharvester'),
                        });
                        if (mNeed) idle.spawnCreep([WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE], `mharv-${room.name}-${Game.time}`, { memory: { role: 'mharvester' } });
                        else {
                          // 拆预留远征:第八顺位盈余(M7-3)。被他人有效预定的
                          // 候选房堵住远矿/殖民两榜时,派 [CLAIM,MOVE] 去剥离
                          // (attackController 每次剥 CLAIM 数*1 tick,接力制);
                          // 让位 mharv:产业是经常收入,远征是一次性开销。
                          const raidTargets = evaluateRaidTargets({ rooms: intelState().rooms, distances: intelState().distances ?? {}, me: idle.owner.username, now: Game.time });
                          const raidTarget = attackerSpawnNeed({
                            targets: raidTargets,
                            attackerAlive: Object.values(Game.creeps).some(c => c.memory.role === 'raider'),
                            workers: creeps.length, capacity: room.energyCapacityAvailable, energyAvailable: room.energyAvailable,
                            lastDeathAt: intelState().lastRaiderDeathAt, now: Game.time,
                          });
                          if (raidTarget) idle.spawnCreep([CLAIM, MOVE], `raider-${room.name}-${Game.time}`, { memory: { role: 'raider', raidTarget } });
                        }
                      }
                    }
                  }
                }
              }
          }
        }
      }
      }
      }
      const cursor = state.workerCursors![room.name] ?? 0;
      isolate(state, 'intel-spawn', () => maybeSpawnScout(room, spawns, plan.spawn || spawnWaiting));
      const handled = Memory.logisticsEnabled === true && !state.degraded ? runLogistics(room, creeps, sources, { spawnWaiting, dedicatedSources: new Set(miners.map(m => m.memory.minerSource).filter((id): id is string => id !== undefined)) }) : new Set<string>();
      if (Memory.logisticsEnabled === true) isolate(state, 'miners', () => runMiners(room, sources));
      if (Memory.logisticsEnabled === true) isolate(state, 'minerals', () => runMinerals(room));
      if (Memory.logisticsEnabled === true) isolate(state, 'labs', () => driveLabs(room));
      if (Memory.logisticsEnabled === true) isolate(state, 'market', () => runMarket(room));
      if (Memory.logisticsEnabled === true) isolate(state, 'factory', () => driveFactory(room));
      isolate(state, 'intel-eval', () => runEvaluation(room.name));
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
  isolate(state, 'intel', () => driveScouts(policy.policy.allies, executionLimit));
  isolate(state, 'claim', () => driveClaimers(policy.policy.allies, executionLimit));
  isolate(state, 'colonize', () => driveColonizers(policy.policy.allies, executionLimit));
  isolate(state, 'raid', () => driveRaiders(policy.policy.allies, executionLimit));
  isolate(state, 'pioneer', () => drivePioneers(policy.policy.allies, executionLimit));
  isolate(state, 'remote', () => driveRemoteMining(executionLimit));
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
