import { evaluateRaidTargets } from '../domain/expedition';
import { markUnreachable } from '../domain/intel';
import { intelState, observeRoom } from './intel';

/**
 * 攻击手驱动(M7-3 远征链 v1):行军→attackController 剥离预订→任务完成
 * 即自尽(预约真空交还正常 claimer 链——现场观测写回情报,拆完当 tick
 * claimer 门禁就能看到)。无效目标(威胁/过期/易主)途中自尽止损,
 * 失踪记死亡冷却(接力节奏由台账把门,防 650 连续填坑)。
 */
export function driveRaiders(allies: readonly string[], cpuLimit: number): void {
  const intel = intelState();
  for (const creep of Object.values(Game.creeps)) {
    const mem = creep.memory;
    if (mem.role !== 'raider' || creep.spawning) continue;
    if (Game.cpu.getUsed() >= cpuLimit) break;
    const target = mem.raidTarget;
    const room = target ? intel.rooms[target] : undefined;
    const controller = room?.controller;
    const stillForeign = controller !== undefined && controller.reserver !== undefined
      && controller.reserver !== creep.owner.username
      && (controller.reservationTicks ?? 0) - Math.max(0, Game.time - room!.observedAt) > 0;
    const invalid = !target || !room || isStaleRoom(room, Game.time)
      || room.threat.armed > 0
      || (controller?.owner !== undefined && controller.owner !== creep.owner.username)
      || !stillForeign;
    if (invalid) {
      // 目标已不是"他占我要拆"状态:要么拆完了,要么易主/开战——撤退止损。
      creep.suicide();
      continue;
    }
    if (creep.room.name !== target) {
      try {
        creep.moveTo(new RoomPosition(25, 25, target), { range: 22, reusePath: 20 });
      } catch {
        // 与 scout/colonizer 同式:寻路层抛错按不可达记账(探针可观测),止损换任。
        markUnreachable(intel, target, Game.time);
        creep.suicide();
      }
      continue;
    }
    // 现场观测写回:拆完的当 tick 情报即清,claimer 链无缝接管(§链条不空转)。
    intel.rooms[target] = observeRoom(creep.room, allies);
    const live = creep.room.controller;
    if (live?.reservation && live.reservation.username !== creep.owner.username) {
      if (creep.attackController(live) === ERR_NOT_IN_RANGE) creep.moveTo(live);
    } else {
      creep.suicide();
    }
  }

  // 台账:在飞攻击手失踪 → 记死亡冷却(与 claimer 同式,接力防填坑)。
  const alive = Object.values(Game.creeps).find(c => c.memory.role === 'raider' && !c.spawning);
  if (alive) {
    intel.raiderActive = alive.name;
  } else if (intel.raiderActive && !Object.values(Game.creeps).some(c => c.name === intel.raiderActive)) {
    intel.lastRaiderDeathAt = Game.time;
    delete intel.raiderActive;
  }

  // 周期性产出拆预留目标榜(消费方在 spawn 链;空榜 = 暂无可拆房)。
  if (Game.time % 25 === 0) {
    const home = Object.keys(Game.rooms).find(r => Game.rooms[r]?.controller?.my);
    if (home) {
      intel.raiding = {
        tick: Game.time,
        targets: evaluateRaidTargets({ rooms: intel.rooms, distances: intel.distances ?? {}, me: Object.values(Game.creeps)[0]?.owner?.username ?? '', now: Game.time }),
      };
    }
  }
}

function isStaleRoom(room: { observedAt: number }, now: number): boolean {
  return now - room.observedAt > 1500;
}
