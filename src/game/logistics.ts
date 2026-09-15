import { LogisticsBoard } from '../domain/logistics';
import { planEconomy } from '../domain/economy';
import { rankServices, settleService, type ServiceState } from '../domain/service';
import { REPAIR_THRESHOLD, selectRepairTarget } from '../domain/maintenance';
import { type TrafficState } from '../domain/traffic';
import { requestMove as travel } from './traffic';
import { extensionTiles, preservesConnectivity } from '../domain/planning';

declare global {
  interface CreepMemory {
    role?: string; minerSource?: string;
    shipment?: { from: string; to: string; expires: number; dependsOn?: string[]; waitingSince?: number };
    logisticsRecovery?: { attempts: number; retryAt: number; reason: string; stopped: boolean };
    delivery?: { tick: number; energy: number; amount: number; target?: string };
    repairTarget?: string;
    building?: boolean;
    containerBuilder?: boolean;
    containerSite?: string;
    traffic?: TrafficState;
  }
  interface Memory {
    logisticsDelivered?: number;
    logisticsCycles?: number;
    logisticsTasks?: Record<string, Record<string, { kind: string; dependsOn: string[]; blocked: boolean; lastProgress: number; retries: number }>>;
    logisticsServices?: Record<string, Record<string, ServiceState>>;
    controllerService?: Record<string, { progress: number; level: number; lastProgress: number; worker?: string }>;
    spawnEscalation?: Record<string, number>;
  }
}

/** Assign at most one miner per container while retaining mobile recovery workers. */
export function runLogistics(room: Room, creeps: Creep[], sources: Source[], context?: { spawnWaiting?: boolean }): Set<string> {
  const handled = new Set<string>();
  // Let bootstrap's urgent controller policy arbitrate before logistics consumes cargo.
  if ((room.controller?.ticksToDowngrade ?? Infinity) < 3000) return handled;
  const mobile = creeps.filter(c => !c.spawning).sort((a, b) => a.name.localeCompare(b.name));
  for (const creep of mobile) {
    const shipment = creep.memory.shipment;
    if (shipment && shipment.waitingSince === undefined) shipment.waitingSince = Game.time;
  }
  // Task memory is namespaced per room so sibling rooms cannot clobber each
  // other's starvation history on a shared Memory object.
  const taskMemory = Memory.logisticsTasks ??= {};
  const prior = taskMemory[room.name] ?? {};
  // Shipments reserve their destination; record who is inbound to each sink or site.
  const inbound = new Map<string, string[]>();
  for (const creep of mobile) {
    const to = creep.memory.shipment?.to;
    if (!to) continue;
    const names = inbound.get(to) ?? [];
    names.push(creep.name);
    inbound.set(to, names);
  }
  // Towers join the sink list so haulers refuel them; they rank between spawn
  // and extensions because a dry tower is a dead defense (PLAN §3.7).
  const sinks = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureSpawn | StructureExtension | StructureTower =>
    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER)
    && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
  const spawns = room.find(FIND_MY_SPAWNS);
  const priorService = Memory.controllerService?.[room.name];
  const upgrade = priorService?.worker && Game.time - priorService.lastProgress >= 200 ? { room: room.name, worker: priorService.worker } : undefined;
  const plan = planEconomy({
    now: Game.time,
    haulers: mobile.map(creep => ({
      name: creep.name, carrying: creep.store.energy > 0, waitingSince: creep.memory.shipment?.waitingSince,
      retries: creep.memory.logisticsRecovery?.attempts ?? 0, shipment: creep.memory.shipment,
    })),
    sites: room.find(FIND_MY_CONSTRUCTION_SITES).map(site => ({
      id: site.id, needsEnergy: site.progress < site.progressTotal, suppliers: inbound.get(site.id) ?? [],
    })),
    spawn: spawns.length ? { room: room.name, waiting: context?.spawnWaiting === true, suppliers: sinks.flatMap(s => inbound.get(s.id) ?? []) } : undefined,
    upgrade, prior,
  }, 100);
  const live = new Set(plan.tasks.map(task => task.id));
  const roomTasks = taskMemory[room.name] ??= {};
  for (const task of plan.tasks) {
    roomTasks[task.id] = { kind: task.kind, dependsOn: task.dependsOn, blocked: plan.decision.blocked.includes(task.id), lastProgress: task.lastProgress, retries: task.retries };
  }
  for (const id of Object.keys(roomTasks)) if (!live.has(id)) delete roomTasks[id];
  const services = (Memory.logisticsServices ??= {})[room.name] ??= {};
  Memory.logisticsCycles = (Memory.logisticsCycles ?? 0) + plan.decision.cycles.length;
  // A released spawn wait escalates to an emergency minimum-body birth next tick.
  if (context?.spawnWaiting && plan.decision.release.includes(`spawn:${room.name}`)) {
    (Memory.spawnEscalation ??= {})[room.name] = Game.time;
  }
  for (const creep of mobile) {
    const taskId = `haul:${creep.name}`;
    if (plan.decision.release.includes(taskId)) {
      const attempts = Math.min(3, (creep.memory.logisticsRecovery?.attempts ?? 0) + 1);
      creep.memory.logisticsRecovery = { attempts, retryAt: Game.time + 10 * 2 ** (attempts - 1), reason: plan.decision.cycles.some(cycle => cycle.includes(taskId)) ? 'dependency-cycle' : 'dependency-timeout', stopped: attempts >= 3 };
      // The board is reconstructed below, so discarded leases reserve no resources.
      delete creep.memory.shipment;
    } else if (plan.decision.blocked.includes(taskId)) handled.add(creep.name);
  }
  for (const creep of mobile) {
    const delivery = creep.memory.delivery;
    if (delivery && delivery.tick < Game.time) {
      // This creep submitted only transfer on that tick; observe settled cargo.
      if (delivery.tick === Game.time - 1) {
        const settled = Math.max(0, Math.min(delivery.amount, delivery.energy - creep.store.energy));
        Memory.logisticsDelivered = (Memory.logisticsDelivered ?? 0) + settled;
        if (settled > 0) delete creep.memory.logisticsRecovery;
        if (settled > 0 && delivery.target) settleService(services, delivery.target, Game.time);
      }
      delete creep.memory.delivery;
      delete creep.memory.shipment;
    }
    if (creep.memory.shipment && creep.memory.shipment.expires <= Game.time) delete creep.memory.shipment;
    // A backed-off creep cannot act this tick; retaining its shipment would keep a
    // reservation (possibly an injected invalid one) alive past the release window.
    if ((creep.memory.traffic?.retryAt ?? 0) > Game.time) {
      delete creep.memory.shipment;
      handled.add(creep.name);
    }
  }
  // Recovered workers fall back to bootstrap while waiting; terminal failures remain
  // diagnosable and do not repeatedly acquire the same logistics reservation.
  const eligible = mobile.filter(c => !c.memory.logisticsRecovery?.stopped && (c.memory.logisticsRecovery?.retryAt ?? 0) <= Game.time);
  // A service lease survives task selection until observed controller progress.
  // Reserve one worker after 200 ticks without progress, retaining two for the economy.
  const controller = room.controller;
  if (controller && mobile.length >= 3) {
    const services = Memory.controllerService ??= {};
    const service = services[room.name] ??= { progress: controller.progress, level: controller.level, lastProgress: Game.time };
    if (service.progress !== controller.progress || service.level !== controller.level) {
      service.lastProgress = Game.time;
      service.progress = controller.progress;
      service.level = controller.level;
      delete service.worker;
    }
    if (Game.time - service.lastProgress >= 200) {
      const worker = mobile.find(c => c.name === service.worker) ?? [...mobile].sort((a, b) => b.store.energy - a.store.energy || a.pos.getRangeTo(controller) - b.pos.getRangeTo(controller))[0]!;
      service.worker = worker.name;
      handled.add(worker.name);
      delete worker.memory.shipment;
      delete worker.memory.containerSite;
      delete worker.memory.minerSource;
      if (worker.store.energy) {
        if (worker.upgradeController(controller) === ERR_NOT_IN_RANGE) travel(worker, controller.pos, 3);
      } else {
        const source = worker.pos.findClosestByRange(sources.filter(s => s.energy > 0));
        if (source && worker.harvest(source) === ERR_NOT_IN_RANGE) travel(worker, source.pos, 1);
      }
    }
  }
  const containers = room.find(FIND_STRUCTURES).filter((s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER);
  const allSites = room.find(FIND_MY_CONSTRUCTION_SITES);
  // Keep the mining plan self-starting: request a container beside each source
  // when the room has construction capacity and no compatible container exists.
  for (const source of sources) {
    if (containers.some(container => container.pos.isNearTo(source))) continue;
    if (allSites.some(site => site.structureType === STRUCTURE_CONTAINER && site.pos.isNearTo(source))) continue;
    const positions: RoomPosition[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const x = source.pos.x + dx, y = source.pos.y + dy;
      if ((!dx && !dy) || x < 1 || x > 48 || y < 1 || y > 48) continue;
      const position = new RoomPosition(x, y, room.name);
      if (position.lookFor(LOOK_TERRAIN)[0] === 'wall' || position.lookFor(LOOK_STRUCTURES).length || position.lookFor(LOOK_CONSTRUCTION_SITES).length) continue;
      positions.push(position);
    }
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    positions.sort((a, b) => (spawn ? a.getRangeTo(spawn) - b.getRangeTo(spawn) : 0) || a.x - b.x || a.y - b.y);
    for (const position of positions) {
      if (room.createConstructionSite(position, STRUCTURE_CONTAINER) === OK) break;
    }
  }
  // RCL2+ unlocks extensions; grow toward the controller's structure cap one
  // site per tick on a deterministic ring around the spawn — but only once every
  // source has a built container beside it. Extensions are growth; the mining
  // plan is survival, and builders above the two-worker floor are scarce.
  const miningSelfSufficient = sources.every(source => containers.some(container => container.pos.isNearTo(source)));
  const rcl = room.controller?.level ?? 0;
  // Unlocks arrive in build order: extensions first (spawn capacity), then the
  // tower (defense), then storage (RCL4 buffer). Each type waits for the previous
  // one to finish — 分批施工，收入与防御先于缓存。
  const extensionCap = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION]?.[rcl] ?? 0;
  const extensionOwned = room.find(FIND_MY_STRUCTURES).filter(s => s.structureType === STRUCTURE_EXTENSION).length;
  const extensionPlanned = allSites.filter(s => s.structureType === STRUCTURE_EXTENSION).length;
  const extensionsComplete = extensionOwned + extensionPlanned >= extensionCap && extensionPlanned === 0;
  const towerCap = CONTROLLER_STRUCTURES[STRUCTURE_TOWER]?.[rcl] ?? 0;
  const towerOwned = room.find(FIND_MY_STRUCTURES).filter(s => s.structureType === STRUCTURE_TOWER).length;
  const towerPlanned = allSites.filter(s => s.structureType === STRUCTURE_TOWER).length;
  const storageCap = CONTROLLER_STRUCTURES[STRUCTURE_STORAGE]?.[rcl] ?? 0;
  const storageOwned = room.find(FIND_MY_STRUCTURES).filter(s => s.structureType === STRUCTURE_STORAGE).length;
  const storagePlanned = allSites.filter(s => s.structureType === STRUCTURE_STORAGE).length;
  const growthType: BuildableStructureConstant | undefined =
    extensionCap - extensionOwned - extensionPlanned > 0 ? STRUCTURE_EXTENSION
    : extensionsComplete && towerCap - towerOwned - towerPlanned > 0 ? STRUCTURE_TOWER
    : extensionsComplete && towerOwned + towerPlanned >= towerCap && storageCap - storageOwned - storagePlanned > 0
      ? STRUCTURE_STORAGE : undefined;
  const growthOwned = growthType === STRUCTURE_EXTENSION ? extensionOwned
    : growthType === STRUCTURE_TOWER ? towerOwned : storageOwned;
  const growthPlanned = growthType === STRUCTURE_EXTENSION ? extensionPlanned
    : growthType === STRUCTURE_TOWER ? towerPlanned : storagePlanned;
  const growthCap = growthType === STRUCTURE_EXTENSION ? extensionCap
    : growthType === STRUCTURE_TOWER ? towerCap : storageCap;
  if (miningSelfSufficient && growthType && growthCap - growthOwned - growthPlanned > 0 && spawns[0]) {
    const free = (x: number, y: number) => {
      const position = new RoomPosition(x, y, room.name);
      return position.lookFor(LOOK_TERRAIN)[0] !== 'wall'
        && position.lookFor(LOOK_STRUCTURES).length === 0
        && position.lookFor(LOOK_CONSTRUCTION_SITES).length === 0;
    };
    const passable = (x: number, y: number) => x >= 0 && x < 50 && y >= 0 && y < 50 && free(x, y);
    // Scan a small candidate window: cut vertices (corridor/pocket entrances)
    // are skipped, then the first surviving tile gets the one site of this tick.
    for (const tile of extensionTiles({ x: spawns[0].pos.x, y: spawns[0].pos.y }, free, 8)) {
      if (!preservesConnectivity(tile, passable)) continue;
      if (room.createConstructionSite(tile.x, tile.y, growthType) === OK) break;
    }
  }
  const ranked = rankServices(sinks.map(s => ({ id: s.id, priority: s.structureType === STRUCTURE_SPAWN ? 10 : s.structureType === STRUCTURE_TOWER ? 7 : 5,
    emergency: mobile.length < 2 && s.structureType === STRUCTURE_SPAWN })), services, Game.time);
  const rclLevel = room.controller?.level ?? 0;
  const ownedByType = new Map<string, number>();
  for (const s of room.find(FIND_MY_STRUCTURES)) ownedByType.set(s.structureType, (ownedByType.get(s.structureType) ?? 0) + 1);
  const plannedByType = new Map<BuildableStructureConstant, number>();
  for (const s of allSites) plannedByType.set(s.structureType, (plannedByType.get(s.structureType) ?? 0) + 1);
  for (const creep of mobile) if (!allSites.some(s => s.id === creep.memory.containerSite)) {
    delete creep.memory.containerBuilder;
    delete creep.memory.containerSite;
  }
  const containerSites = allSites.filter(s => s.structureType === STRUCTURE_CONTAINER);
  const extensionSites = allSites.filter(s => s.structureType !== STRUCTURE_CONTAINER);
  // Repair flags are cleaned unconditionally: a destroyed or healed target must
  // not permanently exclude its former worker from future assignments.
  for (const creep of mobile) {
    if (!creep.memory.repairTarget) continue;
    const target = containers.find(c => c.id === creep.memory.repairTarget);
    if (!target || target.hits / target.hitsMax >= REPAIR_THRESHOLD) delete creep.memory.repairTarget;
  }
  // Storage is both a stockpile sink and a supply source for builders/repairers
  // once it exists (RCL4). Withdrawals read it without pulling from the haul loops.
  const storage = room.find(FIND_MY_STRUCTURES).filter((s): s is StructureStorage => s.structureType === STRUCTURE_STORAGE && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0)[0];
  const stockpiles = [...containers, ...(storage ? [storage] : [])];
  const repair = selectRepairTarget(containers.map(container => ({ id: container.id, structureType: container.structureType,
    hits: container.hits, hitsMax: container.hitsMax, critical: true })));
  const urgent = repair !== undefined && repair.urgent;
  if (repair !== undefined && (mobile.length - handled.size > (urgent ? 1 : 2))) {
    const available = eligible.filter(c => !handled.has(c.name));
    const target = containers.find(c => c.id === repair.id)!;
    const worker = available.find(c => c.memory.repairTarget === repair.id)
      ?? available.filter(c => !c.memory.repairTarget).sort((a, b) => b.getActiveBodyparts(WORK) - a.getActiveBodyparts(WORK) || a.pos.getRangeTo(target) - b.pos.getRangeTo(target))[0];
    if (worker) {
      worker.memory.repairTarget = repair.id;
      delete worker.memory.minerSource;
      delete worker.memory.shipment;
      delete worker.memory.containerSite;
      delete worker.memory.containerBuilder;
      handled.add(worker.name);
      if (!worker.store.energy) {
        const container = worker.pos.findClosestByRange(containers.filter(c => c.store.getUsedCapacity(RESOURCE_ENERGY) > 0));
        if (container) {
          if (worker.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) travel(worker, container.pos, 1);
        } else {
          const source = worker.pos.findClosestByRange(sources.filter(s => s.energy > 0));
          if (source) {
            if (worker.harvest(source) === ERR_NOT_IN_RANGE) travel(worker, source.pos, 1);
          }
        }
      } else if (worker.repair(target) === ERR_NOT_IN_RANGE) travel(worker, target.pos, 3);
    }
  }
  for (const site of containerSites) {
    // Container sites are income-critical, so they may spend the two-worker
    // economy floor. Urgent repair and controller emergencies pause building.
    const cap = CONTROLLER_STRUCTURES[site.structureType]?.[rclLevel] ?? 0;
    const planned = (plannedByType.get(site.structureType) ?? 0) - 1;
    if (cap - (ownedByType.get(site.structureType) ?? 0) - planned <= 0) continue;
    if (urgent || mobile.length - handled.size <= 2 || (room.controller?.ticksToDowngrade ?? 0) <= 3000) break;
    const available = eligible.filter(c => !handled.has(c.name));
    const builder = available.find(c => c.memory.containerSite === site.id) ?? available.filter(c => !c.memory.containerSite).sort((a, b) => b.getActiveBodyparts(WORK) - a.getActiveBodyparts(WORK) || a.pos.getRangeTo(site) - b.pos.getRangeTo(site))[0];
    if (builder) {
      builder.memory.containerBuilder = true;
      builder.memory.containerSite = site.id;
      delete builder.memory.minerSource;
      delete builder.memory.shipment;
      handled.add(builder.name);
      if (!builder.store.energy) builder.memory.building = false;
      if (!builder.store.getFreeCapacity(RESOURCE_ENERGY)) builder.memory.building = true;
      if (builder.memory.building) {
        if (builder.build(site) === ERR_NOT_IN_RANGE) travel(builder, site.pos, 3);
      } else {
        const source = site.pos.findClosestByRange(sources.filter(s => s.energy > 0));
        if (source && builder.harvest(source) === ERR_NOT_IN_RANGE) travel(builder, source.pos, 1);
      }
    }
  }
  const board = new LogisticsBoard([...stockpiles.map(c => ({ id: c.id, amount: c.store.getUsedCapacity(RESOURCE_ENERGY) })),
    ...mobile.map(c => ({ id: `cargo:${c.name}`, amount: c.store.energy }))],
    sinks.map(s => ({ id: s.id, amount: s.store.getFreeCapacity(RESOURCE_ENERGY), priority: ranked.length - ranked.findIndex(c => c.id === s.id) })));
  for (const source of sources) {
    if (mobile.length - handled.size <= 2) break;
    const container = containers.find(c => c.pos.isNearTo(source));
    if (!container) continue;
    const candidates = eligible.filter(c => !handled.has(c.name));
    const miner = candidates.find(c => c.memory.minerSource === source.id) ?? candidates.sort((a, b) => a.pos.getRangeTo(container) - b.pos.getRangeTo(container))[0];
    if (!miner) continue;
    handled.add(miner.name);
    miner.memory.minerSource = source.id;
    delete miner.memory.shipment;
    if (!miner.pos.isEqualTo(container.pos)) { travel(miner, container.pos, 0); continue; }
    if (miner.store.energy > 0) miner.transfer(container, RESOURCE_ENERGY);
    if (container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) miner.harvest(source);
  }
  // Growth sites (extensions, roads, …) are the RCL2-4 development gate: a single
  // dedicated builder slot above the two-worker floor, claimed after miners but
  // before hauling so build progress does not depend on idle luck. Urgent repair
  // pauses this entirely; the RCL cap keeps phantom sites unbuilt.
  if (!urgent) for (const site of extensionSites) {
    const cap = CONTROLLER_STRUCTURES[site.structureType]?.[rclLevel] ?? 0;
    const planned = (plannedByType.get(site.structureType) ?? 0) - 1;
    if (cap - (ownedByType.get(site.structureType) ?? 0) - planned <= 0) continue;
    // Exactly one builder per site: reclaim the sticky worker when present, and
    // clear duplicate flags earlier assignments left on the same site.
    for (const creep of mobile) if (creep.memory.containerSite === site.id && !eligible.includes(creep)) {
      delete creep.memory.containerSite;
      delete creep.memory.containerBuilder;
    }
    // Leave at least one worker unclaimed for hauling: extensions must not starve
    // spawn deliveries (symmetric with the miner floor).
    if (mobile.length - handled.size <= 1) break;
    const surplus = eligible.filter(c => !handled.has(c.name) && (!c.memory.containerSite || c.memory.containerSite === site.id));
    const builder = surplus.find(c => c.memory.containerSite === site.id)
      ?? surplus.sort((a, b) => b.getActiveBodyparts(WORK) - a.getActiveBodyparts(WORK) || a.pos.getRangeTo(site) - b.pos.getRangeTo(site))[0];
    if (!builder) continue;
    for (const other of mobile) if (other !== builder && other.memory.containerSite === site.id) {
      delete other.memory.containerSite;
      delete other.memory.containerBuilder;
    }
    builder.memory.containerBuilder = true;
    builder.memory.containerSite = site.id;
    delete builder.memory.minerSource;
    delete builder.memory.shipment;
    handled.add(builder.name);
    if (!builder.store.energy) builder.memory.building = false;
    if (!builder.store.getFreeCapacity(RESOURCE_ENERGY)) builder.memory.building = true;
    if (builder.memory.building) {
      if (builder.build(site) === ERR_NOT_IN_RANGE) travel(builder, site.pos, 3);
    } else {
      const source = site.pos.findClosestByRange(sources.filter(s => s.energy > 0));
      if (source && builder.harvest(source) === ERR_NOT_IN_RANGE) travel(builder, source.pos, 1);
    }
  }
  // Reserve delivery capacity for cargo already on the road before issuing new pickups.
  for (const creep of eligible) {
    if (handled.has(creep.name)) continue;
    delete creep.memory.minerSource;
    if (!creep.store.energy) continue;
    const shipment = board.reserve(creep.name, creep.store.energy, [`cargo:${creep.name}`], creep.memory.shipment?.to)
      ?? board.reserve(creep.name, creep.store.energy, [`cargo:${creep.name}`]);
    if (!shipment) { delete creep.memory.shipment; continue; }
    creep.memory.shipment = { from: shipment.from, to: shipment.to, expires: creep.memory.shipment?.expires ?? Game.time + 150 };
    const sink = sinks.find(s => s.id === shipment.to)!;
    const result = creep.transfer(sink, RESOURCE_ENERGY, shipment.amount);
    if (result === ERR_NOT_IN_RANGE) travel(creep, sink.pos, 1);
    else if (result === OK) creep.memory.delivery = { tick: Game.time, energy: creep.store.energy, amount: shipment.amount, target: sink.id };
    else { board.release(creep.name); delete creep.memory.shipment; }
    handled.add(creep.name);
  }
  for (const creep of eligible) {
    if (handled.has(creep.name) || creep.store.energy > 0) continue;
    const sorted = [...containers].sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
    const prior = creep.memory.shipment;
    const shipment = (prior ? board.reserve(creep.name, creep.store.getFreeCapacity(RESOURCE_ENERGY), [prior.from], prior.to) : undefined)
      ?? board.reserve(creep.name, creep.store.getFreeCapacity(RESOURCE_ENERGY), sorted.map(c => c.id));
    if (!shipment) { delete creep.memory.shipment; continue; }
    creep.memory.shipment = { from: shipment.from, to: shipment.to, expires: prior?.expires ?? Game.time + 150 };
    const source = containers.find(c => c.id === shipment.from)!;
    if (creep.withdraw(source, RESOURCE_ENERGY, shipment.amount) === ERR_NOT_IN_RANGE) travel(creep, source.pos, 1);
    handled.add(creep.name);
  }
  return handled;
}
