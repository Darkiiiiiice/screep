import { advanceAssault, ASSAULT_CLEAR_HOLD, ASSAULT_MUSTER_TIMEOUT, evaluateAssaultTargets } from '../domain/raid';
import type { IntelMemory } from '../domain/intel';
import { markUnreachable } from '../domain/intel';
import { intelState, observeRoom } from './intel';

declare global {
  interface CreepMemory {
    /** 突袭小队目标房名(M7-6)。 */
    assaultTarget?: string;
  }
  interface Memory { assaultEnabled?: boolean }
}

/**
 * 突袭小队驱动(M7-6):阶段机推进 + 成员意图执行。
 * 台账(intel.assault)是唯一真相:孵化登记(bootstrap)、折损同步、
 * 阶段转换、解散冷却都在此收敛。成员动作与守家守卫/拆预留攻击手同式:
 * 就近扑咬/贴身治疗/寻路抛错按不可达记账。
 */
export function driveAssault(allies: readonly string[], cpuLimit: number): void {
  const intel = intelState();
  const state = intel.assault;
  const members = Object.values(Game.creeps).filter((c) => (c.memory.role === 'assaulter' || c.memory.role === 'medic') && !c.spawning);

  if (state) {
    // 折损同步:在册但已不在场 → 记折损一次(名单即台账)。
    for (const list of ['attackers', 'healers'] as const) {
      const before = state[list].length;
      state[list] = state[list].filter((name) => Object.values(Game.creeps).some((c) => c.name === name));
      state.losses += before - state[list].length;
    }

    const targetRoom = intel.rooms[state.target];
    const inRoom = members.filter((c) => c.room.name === state.target);
    // 现场观测写回(任一成员在场即刷新):完成判据与中途失效判据都吃它。
    if (inRoom.length > 0) intel.rooms[state.target] = observeRoom(inRoom[0]!.room, allies);
    // 完成三重门:曾目击(sawThreat)+ 清场保持 25 tick(敌人注入消失窗口
    // ~100 tick 自灭,armed==0 的瞬时读数不认)+ 情报新鲜。防假完成烧穿预算。
    if (inRoom.length > 0 && (targetRoom?.threat.armed ?? 0) > 0) {
      state.sawThreat = true;
      delete state.clearedSince;
    } else if (state.sawThreat && targetRoom !== undefined && targetRoom.threat.armed === 0
      && Game.time - targetRoom.observedAt <= 5) {
      state.clearedSince ??= Game.time;
    } else {
      delete state.clearedSince;
    }
    const threatCleared = state.sawThreat === true && state.clearedSince !== undefined
      && Game.time - state.clearedSince >= ASSAULT_CLEAR_HOLD;
    const squadInRoom = members.length > 0 && inRoom.length === members.length;
    // 中途失效:目标易主/起塔(v1 不打)——整队撤退止损。
    if ((state.phase === 'travel' || state.phase === 'engage') && targetRoom !== undefined
      && (targetRoom.controller?.owner !== undefined || targetRoom.threat.towers > 0)) {
      state.phase = 'withdraw';
    }
    // 集结超时(§不让整队无限等待):超时未齐即撤退。
    if (state.phase === 'muster' && Game.time - state.startedAt > ASSAULT_MUSTER_TIMEOUT) {
      state.phase = 'withdraw';
    }

    const verdict = advanceAssault(
      { phase: state.phase, target: state.target, plan: state.plan, attackers: state.attackers, healers: state.healers, losses: state.losses },
      { threatCleared, squadInRoom },
    );
    if (verdict.complete) {
      disband(intel, members, true);
    } else if (verdict.phase !== 'done' && verdict.phase !== state.phase) {
      state.phase = verdict.phase;
    }
  }

  for (const creep of members) {
    if (Game.cpu.getUsed() >= cpuLimit) break;
    const mem = creep.memory;
    const phase = intel.assault?.phase ?? (mem.assaultTarget ? ('withdraw' as const) : undefined);
    if (!phase) continue;
    if (phase === 'withdraw') {
      // 撤退:回母房即解散(到房自杀,尸体不计折损——撤退判据已把账记完)。
      if (!mem.home) { dropFromRoster(intel, creep.name); creep.suicide(); continue; }
      if (creep.room.name === mem.home) {
        dropFromRoster(intel, creep.name);
        creep.suicide();
      } else {
        try {
          creep.moveTo(new RoomPosition(25, 25, mem.home), { range: 22, reusePath: 20 });
        } catch {
          markUnreachable(intel, creep.room.name, Game.time);
          dropFromRoster(intel, creep.name);
          creep.suicide();
        }
      }
      continue;
    }
    const target = mem.assaultTarget;
    if (!target) continue;
    if (phase === 'muster') {
      // 集结:无论身在何房(含被推挤过界者)一律朝母房侧集结格走齐——
      // 集结期身处目标房不是"到位",是脱离编队的孤身送死(取证:医疗被
      // 挤过边界后原地挨打到死)。寻路抛错按不可达退役。
      if (!mem.home) { dropFromRoster(intel, creep.name); creep.suicide(); continue; }
      const tile = exitTileOf(mem.home, target);
      try {
        if (!creep.pos.isNearTo(tile)) creep.moveTo(tile, { reusePath: 10 });
      } catch {
        markUnreachable(intel, creep.room.name, Game.time);
        dropFromRoster(intel, creep.name);
        creep.suicide();
      }
      continue;
    }
    if (creep.room.name !== target) {
      try {
        creep.moveTo(new RoomPosition(25, 25, target), { range: 22, reusePath: 20 });
      } catch {
        markUnreachable(intel, target, Game.time);
        dropFromRoster(intel, creep.name);
        creep.suicide();
      }
      continue;
    }
    // 交战/在目标房:攻击手扑咬最近武装敌,医疗治疗最重伤我方。
    if (mem.role === 'assaulter') {
      const foe = creep.room.find(FIND_HOSTILE_CREEPS)
        .filter((h) => !allies.includes(h.owner.username))
        .sort((a, b) => a.pos.getRangeTo(creep) - b.pos.getRangeTo(creep))[0];
      if (foe) {
        if (creep.attack(foe) === ERR_NOT_IN_RANGE) creep.moveTo(foe);
      }
    } else {
      const wounded = creep.room.find(FIND_MY_CREEPS)
        .filter((c) => c.hits < c.hitsMax)
        .sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
      if (wounded) {
        if (creep.pos.isNearTo(wounded)) creep.heal(wounded);
        else {
          creep.rangedHeal(wounded);
          creep.moveTo(wounded);
        }
      }
    }
  }

  // 撤退收尾:名单清空才落冷却与台账(撤退途中不再立新队——assaultSpawnNeed
  // 对 withdraw 阶段返回 null)。
  if (intel.assault && intel.assault.phase === 'withdraw' && intel.assault.attackers.length === 0 && intel.assault.healers.length === 0) {
    finalizeAssault(intel);
  }

  // 周期性产出突袭目标榜(消费方在 spawn 链;空榜 = 情报范围内无武装占房)。
  if (Game.time % 25 === 0) {
    intel.assaulting = {
      tick: Game.time,
      targets: evaluateAssaultTargets({ rooms: intel.rooms, distances: intel.distances ?? {}, now: Game.time }),
    };
  }
}

/** 出击解散:完成即原地退役(战争消耗,尸体不入账);冷却与目标台账落地。 */
function disband(intel: IntelMemory, members: Creep[], suicideNow: boolean): void {
  for (const creep of members) {
    dropFromRoster(intel, creep.name);
    if (suicideNow) creep.suicide();
  }
  finalizeAssault(intel);
}

function finalizeAssault(intel: IntelMemory): void {
  const state = intel.assault;
  if (!state) return;
  intel.lastAssaultEndAt = Game.time;
  intel.lastAssaultTarget = state.target;
  delete intel.assault;
}

function dropFromRoster(intel: IntelMemory, name: string): void {
  const state = intel.assault;
  if (!state) return;
  state.attackers = state.attackers.filter((n) => n !== name);
  state.healers = state.healers.filter((n) => n !== name);
}

/** 母房朝目标房一侧的集结格:边界内缩 2 格(绝不抵住传送门格——探针实证:
 * 集结点压门时,后来者被先到者堵路会绕道踩门格孤身穿房,被蹲守者围歼)。 */
export function exitTileOf(home: string, target: string): RoomPosition {
  const parse = (name: string): { x: number; y: number } => {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    if (!m) return { x: 0, y: 0 };
    return { x: (m[1] === 'W' ? 1 : -1) * Number(m[2]), y: (m[3] === 'N' ? 1 : -1) * Number(m[4]) };
  };
  const a = parse(home);
  const b = parse(target);
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  const x = dx > 0 ? 2 : dx < 0 ? 47 : 25;
  const y = dy > 0 ? 2 : dy < 0 ? 47 : 25;
  return new RoomPosition(x, y, home);
}
