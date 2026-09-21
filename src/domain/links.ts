/**
 * M6-2 link 调拨的纯决策层:源 link → 中枢 link 的单发送决策。
 * 角色静态(源/中枢按临近关系在 game 层判定),决策图恒为源→中枢,
 * 结构上排除订单环(§157 相同资源不得反复搬回)。
 */

export const LINK_CAPACITY = 800;
/** 源 link 半仓即发:发送冷却 10 tick,半仓阈值让每波都有可观吞吐。 */
export const LINK_SEND_THRESHOLD = 400;
/** 引擎 3% 传输损耗(决策侧只用于估算入仓量,实际损耗由引擎结算)。 */
export const LINK_LOSS = 0.03;

export interface LinkNode {
  id: string;
  energy: number;
  free: number;
  cooldown: number;
  role: 'source' | 'hub';
}

export interface LinkTransfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * 本 tick 的发送计划。规则:冷却归零的源 link 达到半仓阈值即发,目的中枢
 * 须冷却归零且有净空(按 (1-损耗) 折算入仓量后仍装得下);一源一回合至多
 * 一发,一中枢一回合只收一发(引擎接收侧同一 tick 多源竞争会超发,决策侧
 * 先行错开)。中枢不回发——角色静态,无环。
 */
export function linkTransfers(nodes: readonly LinkNode[]): LinkTransfer[] {
  const out: LinkTransfer[] = [];
  const busy = new Set<string>();
  for (const src of nodes) {
    if (src.role !== 'source' || src.cooldown > 0 || src.energy < LINK_SEND_THRESHOLD) continue;
    const hub = nodes.find(h => h.role === 'hub' && h.cooldown === 0 && !busy.has(h.id)
      && Math.floor(h.free / (1 - LINK_LOSS)) > 0);
    if (!hub) continue;
    const amount = Math.min(src.energy, Math.floor(hub.free / (1 - LINK_LOSS)));
    if (amount <= 0) continue;
    out.push({ from: src.id, to: hub.id, amount });
    busy.add(hub.id);
  }
  return out;
}
