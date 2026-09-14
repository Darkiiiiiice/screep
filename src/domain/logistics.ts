export interface Supply { id: string; amount: number }
export interface Demand { id: string; amount: number; priority: number }
export interface Shipment { worker: string; from: string; to: string; amount: number }

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
