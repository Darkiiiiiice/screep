export interface Supply { id: string; amount: number }
export interface Demand { id: string; amount: number; priority: number }
export interface Shipment { worker: string; from: string; to: string; amount: number }

/**
 * storage 保底线(M6-1):低于此能量,产业性取能(升级/建造/维修/升级护卫)
 * 对 storage 不可见——保底留给紧急孵化与塔防(§关键岗位接替:storage 库存
 * 不得视为已准备好)。生存链(搬运-孵化补货)不受此线约束,可以击穿保底。
 */
export const STORAGE_RESERVE_FLOOR = 1000;

/** 升级值勤单班上限:3 条腿专跑控制器,其余照常伺候真实 sink。 */
export const UPGRADE_DUTY_QUOTA = 3;
/** 值勤能量红线:spawn 存量低于此即全员回归 sink(补员优先,§3.1)。 */
export const UPGRADE_DUTY_MIN_ENERGY = 300;
/** 值勤保底搬运腿:真实 sink 永远留足两条线。 */
export const UPGRADE_DUTY_MIN_RUNNERS = 2;

/**
 * 升级值勤配额(纯):控制器是经济的尾闾——无工地、无降级紧急、spawn 存量
 * 安全时,从闲置劳力里固定切出一班专跑升级(名字序确定性排班防抖动);
 * 工地在期/存量告急/劳力不足时配额归零,搬运腿全量回归真实 sink。
 * 收益模型:50 货架 20 格通勤的利用率 ~20%,定班 ~90%,同编制 4-5 倍
 * 升级吞吐(线上实证:全员被 spawn/ext 1300 缓冲吸干,升级只剩 0.5/tick)。
 */
export function upgradeDutyQuota(args: { sites: number; ticksToDowngrade: number; energyAvailable: number; idleWorkers: number }): number {
  if (args.sites > 0) return 0;
  if (args.ticksToDowngrade < 3000) return 0;
  if (args.energyAvailable < UPGRADE_DUTY_MIN_ENERGY) return 0;
  return Math.max(0, Math.min(UPGRADE_DUTY_QUOTA, args.idleWorkers - UPGRADE_DUTY_MIN_RUNNERS));
}

export interface FuelStockpile { id: string; energy: number; storage?: boolean }

/** 产业取能视角的库存表:storage 低于保底线时被过滤,其余全量透传。 */
export function refuelTargets(stockpiles: readonly FuelStockpile[], floor: number = STORAGE_RESERVE_FLOOR): FuelStockpile[] {
  return stockpiles.filter(s => !s.storage || s.energy > floor);
}

/** Rebuilt each tick from observed stores: reservations never survive lost cargo. */
export class LogisticsBoard {
  readonly shipments: Shipment[] = [];
  private readonly supply: Map<string, number>;
  private readonly demand: Map<string, number>;
  constructor(sources: Supply[], private readonly targets: Demand[]) {
    this.supply = new Map(sources.map(s => [s.id, s.amount]));
    this.demand = new Map(targets.map(s => [s.id, s.amount]));
  }
  reserve(worker: string, capacity: number, sources: string[], targetId?: string): Shipment | undefined {
    const existing = this.shipments.find(s => s.worker === worker);
    if (existing) return existing;
    for (const target of [...this.targets].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
      if (targetId && target.id !== targetId) continue;
      for (const from of sources) {
        if (from === target.id) continue;
        const amount = Math.min(capacity, this.supply.get(from) ?? 0, this.demand.get(target.id) ?? 0);
        if (amount <= 0) continue;
        const shipment = { worker, from, to: target.id, amount };
        this.supply.set(from, this.supply.get(from)! - amount);
        this.demand.set(target.id, this.demand.get(target.id)! - amount);
        this.shipments.push(shipment);
        return shipment;
      }
    }
    return undefined;
  }

  release(worker: string): void {
    const index = this.shipments.findIndex(s => s.worker === worker);
    if (index < 0) return;
    const [shipment] = this.shipments.splice(index, 1);
    if (!shipment) return;
    this.supply.set(shipment.from, (this.supply.get(shipment.from) ?? 0) + shipment.amount);
    this.demand.set(shipment.to, (this.demand.get(shipment.to) ?? 0) + shipment.amount);
  }
}
