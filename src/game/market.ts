import { MARKET_BUY_TRIGGER, planBuy, planSell, type MarketDeal, type MarketOrderLike } from '../domain/market';
import { LAB_RECIPES } from '../domain/labs';
import { terminalStock } from './labs';

/**
 * 市场驱动(M6-6):每 MARKET_INTERVAL tick 撮合一次。
 * 卖:home 产物超阈值挂给最高价买单;买:反应表基础输入低于触发线时
 * 从最低价卖单回购。费用/限价/仓位闸全部在域层,这里只做读数与执行。
 */
export const MARKET_INTERVAL = 100;

/** 反应表里出现过的全部基础输入(原料清单)。 */
export function recipeInputs(): string[] {
  const inputs = new Set<string>();
  for (const recipe of LAB_RECIPES) for (const input of recipe.inputs) inputs.add(input);
  return [...inputs];
}

/** 订单簿快照(纯数据):只留非能量、有剩余量的挂单。 */
function orderBook(): MarketOrderLike[] {
  const book: MarketOrderLike[] = [];
  for (const o of Game.market.getAllOrders()) {
    if (o.resourceType === RESOURCE_ENERGY || !o.id || !o.roomName) continue;
    const amount = (o as unknown as { remainingAmount?: number }).remainingAmount ?? (o as unknown as { amount: number }).amount;
    if (!(amount > 0)) continue;
    book.push({ id: o.id, type: o.type, resourceType: o.resourceType, price: o.price, amount, roomName: o.roomName });
  }
  return book;
}

/** 当前成交计划(供探针断言复用):先卖后买,互不排队。 */
export function marketPlan(room: Room): { sell?: MarketDeal | undefined; buy?: MarketDeal | undefined; book: MarketOrderLike[] } {
  const terminal = room.find(FIND_MY_STRUCTURES).find((s): s is StructureTerminal => s.structureType === STRUCTURE_TERMINAL);
  if (!terminal) return { book: [] };
  const stock = terminalStock(terminal);
  const book = orderBook();
  const args = {
    homeRoomName: room.name,
    terminalEnergy: terminal.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0,
    stock,
  };
  const sell = planSell({ ...args, orders: book });
  const credits = Game.market.credits ?? 0;
  const inputs = recipeInputs().filter((res) => (stock[res] ?? 0) < MARKET_BUY_TRIGGER);
  const buy = inputs.length ? planBuy({ ...args, credits, inputs, orders: book }) : undefined;
  return { sell, buy, book };
}

export function runMarket(room: Room): void {
  if (Game.time % MARKET_INTERVAL !== 0) return;
  const { sell, buy } = marketPlan(room);
  if (sell) Game.market.deal(sell.orderId, sell.amount, room.name);
  else if (buy) Game.market.deal(buy.orderId, buy.amount, room.name);
}
