import { advanceAssault, ASSAULT_CLEAR_HOLD, ASSAULT_MISSION_TIMEOUT, ASSAULT_MUSTER_TIMEOUT, ASSAULT_TIMEOUT_EXCLUDE, assaultExclusionDue, evaluateAssaultTargets } from '../domain/raid';
import { BOOST_ENERGY_PER_PART, BOOST_MINERAL_PER_PART, BOOST_WAIT_LIMIT, boostFeasible, combatBoostDemand, squadBoostLeg } from '../domain/boost';
import type { IntelMemory } from '../domain/intel';
import { markUnreachable } from '../domain/intel';
import { intelState, observeRoom } from './intel';
import { labMineral } from './labs';

declare global {
  interface CreepMemory {
    /** 突袭小队目标房名(M7-6)。 */
    assaultTarget?: string;
    /** 强化等待截止(M7-7,集结到 lab 后起算);超时放弃强化开拔。 */
    boostWaitUntil?: number;
    /** 强化已放弃(无料/超时/领满):置位后直达集结格,不再绕 lab。 */
    boostSkipped?: boolean;
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
  const members = Object.values(Game.creeps).filter((c) => (c.memory.role === 'assaulter' || c.memory.role === 'medic' || c.memory.role === 'dismantler' || c.memory.role === 'ranger') && !c.spawning);

  if (state) {
    // 折损同步:在册但已不在场 → 记折损一次(名单即台账)。
    // 老存档迁移(M7-8 前无拆墙手字段):缺省补空,台账语义不变。
    state.dismantlers ??= [];
    state.plan.dismantlers ??= 0;
    for (const list of ['attackers', 'healers', 'dismantlers', 'rangers'] as const) {
      const before = state[list].length;
      const kept = state[list].filter((name) => Object.values(Game.creeps).some((c) => c.name === name));
      const lost = state[list].filter((name) => !kept.includes(name));
      if (lost.length > 0) state.lastLoss = { names: lost, tick: Game.time };
      state[list] = kept;
      state.losses += before - state[list].length;
    }

    // 老存档迁移:在飞任务补 deadline(自立队起算的总预算,M7-8)/游骑名册(M7-9)。
    state.deadline ??= Game.time + ASSAULT_MISSION_TIMEOUT;
    state.rangers ??= [];
    state.plan.rangers ??= 0;
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
      state.withdrawReason = 'invalidated';
    }
    // 集结超时(§不让整队无限等待):超时未齐即撤退。
    if (state.phase === 'muster' && Game.time - state.startedAt > ASSAULT_MUSTER_TIMEOUT) {
      state.phase = 'withdraw';
      state.withdrawReason = 'muster-timeout';
    }

    // M7-7 开拔闸:满编只是人数到齐——全员"强化已了结"(已强化/已放弃/
    // 本无化合物)才翻 travel,否则编成一满强化腿就被名单数跳过(探针实证:
    // 能量靠 sink 腿现送时 3 攻 0 强化开拔)。孵化中的成员按未了结计。
    const squadBoostResolved = [...state.attackers, ...state.healers, ...state.dismantlers, ...state.rangers].every((name) => {
      const creep = Game.creeps[name];
      return creep !== undefined && (creep.memory.boostSkipped === true || squadBoostLeg(creep) === null);
    });
    // 集结位置闸(M7-9):名册齐只是数字——全员贴集结格(母房侧门格,2 环)
    // 才算集合完毕;迟到的(强化等待/后补员)不拖整队去敌门格站桩挨打。
    const homeRoom = members[0]?.memory.home;
    const musterTile = homeRoom ? exitTileOf(homeRoom, state.target) : undefined;
    const squadAssembled = musterTile !== undefined && members.length > 0
      && members.every((m) => m.pos.inRangeTo(musterTile, 2));
    const verdict = advanceAssault(
      { phase: state.phase, target: state.target, plan: state.plan, attackers: state.attackers, healers: state.healers, dismantlers: state.dismantlers, rangers: state.rangers, losses: state.losses, deadline: state.deadline },
      { now: Game.time, threatCleared, squadInRoom, squadBoostResolved, squadAssembled,
        structuresCleared: targetRoom !== undefined && targetRoom.threat.structures === 0 },
    );
    if (verdict.withdrawReason === 'timeout') {
      // 打不下的房记排除期:冷却只挡节奏,排除才断"再锁同一目标"的循环。
      (intel.assaultExcludedUntil ??= {})[state.target] = Game.time + ASSAULT_TIMEOUT_EXCLUDE;
    }
    if (verdict.complete) {
      disband(intel, members, true);
    } else if (verdict.phase !== 'done' && verdict.phase !== state.phase) {
      state.phase = verdict.phase;
      if (verdict.withdrawReason) state.withdrawReason = verdict.withdrawReason;
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
      // M7-7 强化腿:编成期先到强化 lab 领料再开拔。强化是增益不是前提:
      // 超时(BOOST_WAIT_LIMIT ≪ 集结超时)或本房无 lab 即放弃开拔,不拖任务后腿;
      // 料暂时清零(部分强化后引擎把 storeCapacityResource 置空)不判死——反应
      // 涓流会补,贴着等到 deadline。
      if (!mem.boostSkipped) {
        const leg = squadBoostLeg(creep);
        if (!leg) { mem.boostSkipped = true; }
        else {
          const deadline = mem.boostWaitUntil ?? (mem.boostWaitUntil = Game.time + BOOST_WAIT_LIMIT);
          if (Game.time >= deadline) { mem.boostSkipped = true; }
          else {
            const has = (l: StructureLab): boolean =>
              (l.store.getUsedCapacity(leg.compound as ResourceConstant) ?? 0) >= BOOST_MINERAL_PER_PART
              && (l.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) >= BOOST_ENERGY_PER_PART;
            const roomLabs = creep.room.find(FIND_MY_STRUCTURES)
              .filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB);
            if (roomLabs.length === 0) { mem.boostSkipped = true; continue; }
            const labs = roomLabs.filter((l) => labMineral(l) === leg.compound);
            const lab = labs.find(has) ?? labs[0];
            if (!lab) {
              // 无持料 lab:库存(storage/terminal/lab)掏不出本体也掏不出原料
              // = 本任务永远等不到——立即放弃开拔(强化非前提);有料在产贴着等。
              const stock: Record<string, number> = {};
              for (const st of [creep.room.storage, creep.room.terminal]) {
                if (st) for (const [res, amt] of Object.entries(st.store)) stock[res] = (stock[res] ?? 0) + (amt as number);
              }
              for (const l of roomLabs) {
                const m = labMineral(l);
                if (m) stock[m] = (stock[m] ?? 0) + (l.store.getUsedCapacity(m as ResourceConstant) ?? 0);
              }
              if (!boostFeasible(leg.compound, stock)) mem.boostSkipped = true;
              continue;
            }
            else if (!creep.pos.isNearTo(lab.pos)) {
              try { creep.moveTo(lab.pos, { reusePath: 10 }); } catch {
                markUnreachable(intel, creep.room.name, Game.time);
                dropFromRoster(intel, creep.name);
                creep.suicide();
              }
              continue;
            } else {
              // 邻接即领料(料足时 boostCreep 一次强化全部可强化部件);
              // 料不足就贴着等(production 5/tick),deadline 兜底。
              if (has(lab)) lab.boostCreep(creep);
              continue;
            }
          }
        }
      }
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
    // 跨房同步(M7-9,§3.8 出口两侧集结):travel 期进房即贴朝母房的门格
    // 列队,等全队到齐翻 engage 再开打——零散进场=被逐个击破(探针实证:
    // 先头攻击手孤身在 25,41 接触双蹲守者,15 tick 被打掉 460 血折损撤退)。
    if (phase === 'travel') {
      // 列队不缴械(评审修订):站桩期被打要还手——医疗照治、贴脸照打、
      // 3 环照射;只是不追击不深入(实证:医疗站桩被焦点打死,旁边攻击手满血)。
      if (mem.home) {
        try {
          const tile = exitTileOf(target, mem.home);
          if (!creep.pos.isNearTo(tile)) creep.moveTo(tile, { reusePath: 10 });
        } catch {
          markUnreachable(intel, target, Game.time);
          dropFromRoster(intel, creep.name);
          creep.suicide();
        }
      }
      if (mem.role === 'medic') {
        // 医疗先归位再行医——只治不走会把小队永远拖在 travel(实证:医疗
        // 流落场外,squadAssembled 永不成立,全队站桩到 TTL 耗尽)。
        healWounded(creep, allies);
        continue;
      }
      const stager = creep.room.find(FIND_HOSTILE_CREEPS)
        .filter((h) => !allies.includes(h.owner.username))
        .sort((a, b) => a.pos.getRangeTo(creep) - b.pos.getRangeTo(creep))[0];
      if (stager) {
        const d = creep.pos.getRangeTo(stager);
        if (mem.role === 'assaulter' && d <= 1) creep.attack(stager);
        else if (mem.role === 'ranger' && d <= 3) {
          creep.rangedAttack(stager);
          const meleeArmed = stager.body.some((p) => p.type === ATTACK && p.hits > 0);
          if (d <= 3 && meleeArmed) kiteRetreatStep(creep, stager.pos);
        }
      }
      continue;
    }
    // 交战/在目标房:攻击手扑咬最近武装敌,医疗治疗最重伤我方。
    if (mem.role === 'assaulter') {
      // 焦点最弱(评审实证):各咬最近会把火力摊在双敌上,输出期被入侵 AI
      // 的焦点火反杀(240dps 集火 3-4t 杀一名攻击手);hits 升序+名字决胜
      // 让全队收敛同一目标,先杀先减对面 DPS。
      const foe = creep.room.find(FIND_HOSTILE_CREEPS)
        .filter((h) => !allies.includes(h.owner.username))
        .sort((a, b) => a.hits - b.hits || a.name.localeCompare(b.name))[0];
      if (foe) {
        if (creep.attack(foe) === ERR_NOT_IN_RANGE) creep.moveTo(foe);
      }
    } else if (mem.role === 'ranger') {
      // 游骑(M7-9 远程拉扯):3 环内全额输出(引擎 rangedAttack 无距离衰减);
      // 近战压到 3 环(满射程缘)就边射边撤——等速追击下环带恒 3,追兵永远
      // 贴不上(实证:d<3 才撤的均衡是 d=1 恒贴脸,25 tick 连咬)。
      // 对远程/无近战敌对射不亏(同 10/件),不枉风。
      // 目标与攻击手同序(焦点最弱),不另起最近序分散火力。
      const foe = creep.room.find(FIND_HOSTILE_CREEPS)
        .filter((h) => !allies.includes(h.owner.username))
        .sort((a, b) => a.hits - b.hits || a.name.localeCompare(b.name))[0];
      if (foe) {
        const d = creep.pos.getRangeTo(foe);
        if (d > 3) creep.moveTo(foe, { range: 3 });
        else {
          creep.rangedAttack(foe);
          const meleeArmed = foe.body.some((p) => p.type === ATTACK && p.hits > 0);
          if (d <= 3 && meleeArmed) kiteRetreatStep(creep, foe.pos);
        }
      }
    } else if (mem.role === 'dismantler') {
      // 拆墙手(M7-8):无战力——武装在场退到朝母房的门格候场(不贴火力区);
      // 武装清零后按战术序贴拆(spawn 优先,其次 id 序确定性)。rampart 压在
      // 目标格上由引擎 dismantle 重定向先啃(dist/processor/intents/creeps/
      // dismantle.js:33-36 实证),拆除还按 DISMANTLE_COST 回吐能量。
      const armedNow = intel.rooms[target]?.threat.armed ?? 0;
      if (armedNow > 0 && mem.home) {
        try {
          const tile = exitTileOf(target, mem.home);
          if (!creep.pos.isNearTo(tile)) creep.moveTo(tile, { reusePath: 10 });
        } catch {
          markUnreachable(intel, target, Game.time);
          dropFromRoster(intel, creep.name);
          creep.suicide();
        }
        continue;
      }
      const structure = creep.room.find(FIND_HOSTILE_STRUCTURES)
        .filter((s) => !allies.includes(s.owner?.username ?? '') && s.structureType !== STRUCTURE_CONTROLLER)
        .sort((a, b) => (a.structureType === STRUCTURE_SPAWN ? 0 : 1) - (b.structureType === STRUCTURE_SPAWN ? 0 : 1)
          || a.id.localeCompare(b.id))[0];
      if (structure && creep.dismantle(structure) === ERR_NOT_IN_RANGE) creep.moveTo(structure.pos);
    } else {
      healWounded(creep, allies);
    }
  }

  // 撤退收尾:名单清空才落冷却与台账(撤退途中不再立新队——assaultSpawnNeed
  // 对 withdraw 阶段返回 null)。
  if (intel.assault && intel.assault.phase === 'withdraw' && intel.assault.attackers.length === 0
    && intel.assault.healers.length === 0 && intel.assault.dismantlers.length === 0 && intel.assault.rangers.length === 0) {
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

/** 风筝后撤步(M7-9 评审修订):直线远离被地形/队友堵死时按 ±45°、±90°
 * 顺序横切——风筝死于顶墙被咬(实证:追兵把游骑逼到队友身后,环带破 1,
 * 挨了一刀 30),不死于侧移。全堵也交直线意图(交通仲裁下 tick 可能挪开)。 */
function kiteRetreatStep(creep: Creep, from: RoomPosition): void {
  const dir = from.getDirectionTo(creep.pos);
  const order = [dir, ((dir + 6) % 8) + 1, (dir % 8) + 1, ((dir + 5) % 8) + 1, ((dir + 1) % 8) + 1];  // away,±45°,±90°(评审修订:原第 5 项 ((dir+3)%8)+1 是 180° 朝敌)
  const dx = [0, 0, 1, 1, 1, 0, -1, -1, -1];
  const dy = [0, -1, -1, 0, 1, 1, 1, 0, -1];
  const terrain = Game.map.getRoomTerrain(creep.room.name);
  const occupied = new Set(creep.room.find(FIND_CREEPS).map((c) => c.pos.x * 50 + c.pos.y));
  for (const d of order) {
    const nx = creep.pos.x + (dx[d] ?? 0);
    const ny = creep.pos.y + (dy[d] ?? 0);
    if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;  // 0/49 是合法贴边格(评审修订:底边恰是风筝风暴眼)
    if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
    if (occupied.has(nx * 50 + ny)) continue;
    creep.move(d as DirectionConstant);
    return;
  }
  creep.move(dir);
}

/** 医疗共性腿:治疗本房最重伤我方(邻接 heal,否则 rangedHeal+贴近)。 */
function healWounded(creep: Creep, allies: readonly string[]): void {
  const wounded = creep.room.find(FIND_MY_CREEPS)
    .filter((c) => c.hits < c.hitsMax)
    .sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
  // 火线医疗(评审两轮实证):站打 3 环 rangedHeal 疗效 4/件,喂不住被
  // 集火的前排(60dps 焦点 vs 16hps = 前排 23t 阵亡)——贴脸 12/件(双医疗
  // 48hps)才能淹没了了 60dps。但 medic 自己贴敌(1 环)会被 swap 集火,
  // 此时边治边退;敌在 2 环够不着近战,是安全位,照常贴伤员满疗。
  if (wounded) {
    if (creep.pos.isNearTo(wounded)) creep.heal(wounded);
    else if (creep.pos.getRangeTo(wounded) <= 3) creep.rangedHeal(wounded);
  }
  const threat = creep.room.find(FIND_HOSTILE_CREEPS)
    .filter((h) => !allies.includes(h.owner.username)
      && h.body.some((p) => p.type === ATTACK && p.hits > 0))
    .sort((a, b) => a.pos.getRangeTo(creep) - b.pos.getRangeTo(creep))[0];
  if (threat && creep.pos.isNearTo(threat)) {
    kiteRetreatStep(creep, threat.pos);
  } else if (wounded && !creep.pos.isNearTo(wounded)) {
    creep.moveTo(wounded);
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
  // 烂尾围攻记排除期(评审修订:锚终态观测而非 timeout——密封房零战损,
  // TTL 折损撤退永远抢跑 deadline)。完成收档(无 withdrawReason)不涉及。
  if (assaultExclusionDue(state, intel.rooms[state.target]?.threat.structures)) {
    (intel.assaultExcludedUntil ??= {})[state.target] = Game.time + ASSAULT_TIMEOUT_EXCLUDE;
  }
  intel.lastAssaultEndAt = Game.time;
  intel.lastAssaultTarget = state.target;
  delete intel.assault;
}

function dropFromRoster(intel: IntelMemory, name: string): void {
  const state = intel.assault;
  if (!state) return;
  state.attackers = state.attackers.filter((n) => n !== name);
  state.healers = state.healers.filter((n) => n !== name);
  state.dismantlers = state.dismantlers.filter((n) => n !== name);
  state.rangers = state.rangers.filter((n) => n !== name);
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

/** 当前任务的强化需求(M7-7,muster 期才产——开拔后强化料即失效;无任务返回 undefined)。 */
export function currentBoostDemand(): Record<string, number> | undefined {
  if (Memory.assaultEnabled !== true) return undefined;
  const state = intelState().assault;
  if (!state || state.phase !== 'muster') return undefined;
  return combatBoostDemand(state.plan);
}
