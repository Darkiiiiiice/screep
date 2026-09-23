/**
 * 远征拆预留决策(M7-3,纯):§3.8 远征链 v1 + §3.9"敌方预留→攻击控制器"。
 * 我们的远矿/殖民候选房被他人挂着有效预订时,远矿评估把它排除、殖民门禁
 * 把它挡住——唯一符合 经济性 的动作是派 [CLAIM,MOVE] 攻击手把预订拆掉
 * (attackController 每次剥离 CLAIM 数×1 tick)。全部读数以普通对象传入,
 * 禁止引擎全局。
 */

import { isStale } from './intel';
import type { RoomIntel } from './intel';

/** 攻击手身体 [CLAIM, MOVE] 造价(与预定者/殖民者同构)。 */
export const ATTACKER_BODY_COST = 650;
/** 与矿工/预定者同地板:拆预留是满员工人口粮外的盈余支出。 */
export const ATTACKER_WORKER_FLOOR = 4;
/** 攻击手死亡冷却(§1 失败有界):CLAIM 件寿命 600,冷却须远小于它。 */
export const ATTACKER_DEATH_COOLDOWN = 150;
/** 过远的被占房不拆(行军损耗失去意义)。 */
export const RAID_MAX_DISTANCE = 3;

export interface RaidCandidate {
  name: string;
  distance: number;
  /** 按观测年龄折算后的预订余量(>0 才有得拆)。 */
  effectiveTicks: number;
}

/**
 * 拆预留目标榜(纯):被他人有效预定的无主房,威胁/新鲜/有源/距离闸全同
 * 远矿评估口径。effectiveTicks 升序排(快赢先拆),同分按名字字典序确定性。
 */
export function evaluateRaidTargets(args: { rooms: Record<string, RoomIntel>; distances: Record<string, number>; me: string; now: number }): RaidCandidate[] {
  const candidates: RaidCandidate[] = [];
  for (const [name, intel] of Object.entries(args.rooms)) {
    if (isStale(intel, args.now)) continue;
    if (intel.threat.armed > 0 || intel.threat.towers > 0) continue;
    const controller = intel.controller;
    if (!controller || controller.owner !== undefined) continue;
    if (controller.reserver === undefined || controller.reserver === args.me) continue;
    const effectiveTicks = (controller.reservationTicks ?? 0) - Math.max(0, args.now - intel.observedAt);
    if (effectiveTicks <= 0) continue;
    const distance = args.distances[name];
    if (distance === undefined || distance > RAID_MAX_DISTANCE) continue;
    if (intel.sources.length === 0) continue;
    candidates.push({ name, distance, effectiveTicks });
  }
  return candidates.sort((a, b) => a.effectiveTicks - b.effectiveTicks || a.name.localeCompare(b.name));
}

export interface AttackerSpawnNeedArgs {
  targets: readonly RaidCandidate[];
  attackerAlive: boolean;
  workers: number;
  capacity: number;
  energyAvailable: number;
  /** 最近一次攻击手死亡的 tick(死亡冷却台账)。 */
  lastDeathAt?: number | undefined;
  now: number;
}

/**
 * 攻击手孵化决策(纯):有可拆目标、无在飞、工人地板/容量/全额能量齐、
 * 死亡冷却已过。返回目标房名或 null。攻击手是接力制(CLAIM 件寿命 600,
 * 长预订由继任者接续),alive 检查天然防重叠。
 */
export function attackerSpawnNeed(args: AttackerSpawnNeedArgs): string | null {
  if (args.attackerAlive) return null;
  if (args.capacity < ATTACKER_BODY_COST || args.energyAvailable < ATTACKER_BODY_COST) return null;
  if (args.workers < ATTACKER_WORKER_FLOOR) return null;
  if (args.lastDeathAt !== undefined && args.now - args.lastDeathAt < ATTACKER_DEATH_COOLDOWN) return null;
  return args.targets[0]?.name ?? null;
}
