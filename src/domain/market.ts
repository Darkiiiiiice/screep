/**
 * 市场决策(M6-6,纯):卖产物换 credits、买缺口输入补反应链。
 * 原则:只与订单簿比价(挂单限价保护),仓位上限+credits 保底双闸,
 * 交易能量费按订单实际房间距离估算、可承受才下单。
 * 所有读数以普通对象传入,禁止引擎全局。
 */

/** 产物库存高于此量才卖(多出的部分换 credits,自身留底)。 */
export const MARKET_SELL_THRESHOLD = 400;
/** 卖出后 home 端至少保留的产物量。 */
export const MARKET_KEEP_PRODUCT = 100;
/** 输入库存低于此量才买(与 LAB_INPUT_FLOOR 同量级)。 */
export const MARKET_BUY_TRIGGER = 60;
/** 单笔成交上限(防止一口吃掉整个订单或压穿自家 terminal)。 */
export const MARKET_DEAL_MAX = 500;
/** credits 低于此值停买(卖出的钱先攒着,不掏老本)。 */
export const MARKET_CREDIT_RESERVE = 500;
/** 卖单最低限价:低于此价的买单不卖(防贱卖)。 */
export const MARKET_SELL_FLOOR = 0.1;
/** 买单最高限价:高于此价的卖单不买(防天价)。 */
export const MARKET_BUY_CEILING = 2;
/** 交易能量费不得超过 terminal 能量的这一比例。 */
export const MARKET_ENERGY_FEE_RATIO = 0.2;
/** 距离过远的订单不碰(能量费失去意义)。 */
export const MARKET_MAX_DISTANCE = 5;

export interface MarketOrderLike {
  id: string;
  type: 'buy' | 'sell';
  resourceType: string;
  price: number;
  amount: number;
  roomName: string;
}

export interface MarketDeal {
  orderId: string;
  resourceType: string;
  amount: number;
  kind: 'sell' | 'buy';
}

/** 房间名线性距离(Chebyshev;不考虑地道/传送门,与引擎计费量级一致)。 */
export function roomNameDistance(a: string, b: string): number {
  const parse = (n: string): { x: number; y: number } | undefined => {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(n);
    if (!m) return undefined;
    return { x: (m[1] === 'W' ? -1 : 1) * Number(m[2]), y: (m[3] === 'N' ? 1 : -1) * Number(m[4]) };
  };
  const p = parse(a);
  const q = parse(b);
  if (!p || !q) return Infinity;
  return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
}

/** 交易能量费(与引擎 calcTerminalEnergyCost 同式:线性×0.1/格)。 */
export function marketEnergyFee(args: { amount: number; distance: number }): number {
  return Math.ceil(args.amount * 0.1 * args.distance);
}

function feeOk(args: { amount: number; homeRoomName: string; orderRoomName: string; terminalEnergy: number }): boolean {
  const distance = roomNameDistance(args.homeRoomName, args.orderRoomName);
  if (distance > MARKET_MAX_DISTANCE) return false;
  return marketEnergyFee({ amount: args.amount, distance }) <= args.terminalEnergy * MARKET_ENERGY_FEE_RATIO;
}

/** 产物换钱:home 产物超阈值时,找限价达标的最高价买单出掉多余额。 */
export function planSell(args: {
  homeRoomName: string;
  terminalEnergy: number;
  stock: Readonly<Record<string, number>>;
  orders: ReadonlyArray<MarketOrderLike>;
}): MarketDeal | undefined {
  for (const [resourceType, amount] of Object.entries(args.stock)) {
    if (resourceType === 'energy' || amount <= MARKET_SELL_THRESHOLD) continue;
    const surplus = Math.min(amount - MARKET_KEEP_PRODUCT, MARKET_DEAL_MAX);
    if (surplus <= 0) continue;
    const buyers = args.orders
      .filter((o) => o.type === 'buy' && o.resourceType === resourceType && o.price >= MARKET_SELL_FLOOR && o.amount > 0)
      .sort((a, b) => b.price - a.price);
    for (const order of buyers) {
      const qty = Math.min(surplus, order.amount);
      if (qty <= 0) continue;
      if (!feeOk({ amount: qty, homeRoomName: args.homeRoomName, orderRoomName: order.roomName, terminalEnergy: args.terminalEnergy })) continue;
      return { orderId: order.id, resourceType, amount: qty, kind: 'sell' };
    }
  }
  return undefined;
}

/** 缺口补料:credits 有保底时,找限价内的最低价卖单买回缺的输入(预算内部分成交)。 */
export function planBuy(args: {
  homeRoomName: string;
  terminalEnergy: number;
  credits: number;
  stock: Readonly<Record<string, number>>;
  inputs: ReadonlyArray<string>;
  orders: ReadonlyArray<MarketOrderLike>;
}): MarketDeal | undefined {
  if (args.credits < MARKET_CREDIT_RESERVE) return undefined;
  for (const resourceType of args.inputs) {
    if ((args.stock[resourceType] ?? 0) >= MARKET_BUY_TRIGGER) continue;
    const need = MARKET_BUY_TRIGGER - (args.stock[resourceType] ?? 0);
    const qty = Math.min(Math.max(need, 0), MARKET_DEAL_MAX);
    if (qty <= 0) continue;
    const sellers = args.orders
      .filter((o) => o.type === 'sell' && o.resourceType === resourceType && o.price <= MARKET_BUY_CEILING && o.amount > 0)
      .sort((a, b) => a.price - b.price);
    for (const order of sellers) {
      const budget = args.credits - MARKET_CREDIT_RESERVE;
      const amount = Math.min(qty, order.amount, Math.floor(budget / order.price));
      if (amount <= 0) continue;
      if (!feeOk({ amount, homeRoomName: args.homeRoomName, orderRoomName: order.roomName, terminalEnergy: args.terminalEnergy })) continue;
      return { orderId: order.id, resourceType, amount, kind: 'buy' };
    }
  }
  return undefined;
}
