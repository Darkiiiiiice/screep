import { describe, expect, it } from 'vitest';
import {
  marketEnergyFee,
  MARKET_BUY_CEILING,
  MARKET_BUY_TRIGGER,
  MARKET_CREDIT_RESERVE,
  MARKET_DEAL_MAX,
  MARKET_ENERGY_FEE_RATIO,
  MARKET_KEEP_PRODUCT,
  MARKET_SELL_FLOOR,
  MARKET_SELL_THRESHOLD,
  planBuy,
  planSell,
  type MarketOrderLike,
} from '../../src/domain/market';

const base = { homeRoomName: 'W0N1', terminalEnergy: 5000, stock: { UH: 500, H: 0 } as Record<string, number> };
const inRoom = (id: string, type: 'buy' | 'sell', resourceType: string, price: number, amount: number): MarketOrderLike => ({ id, type, resourceType, price, amount, roomName: 'W0N2' });

describe('market sell (M6-6)', () => {
  it('sells surplus above threshold to the best-priced buy order', () => {
    const orders = [inRoom('lo', 'buy', 'UH', 0.5, 1000), inRoom('hi', 'buy', 'UH', 1.2, 1000)];
    const deal = planSell({ ...base, orders });
    expect(deal).toEqual({ orderId: 'hi', resourceType: 'UH', amount: (base.stock.UH ?? 0) - MARKET_KEEP_PRODUCT, kind: 'sell' });
  });
  it('ignores stock at or below the threshold and keeps the reserve', () => {
    expect(planSell({ ...base, stock: { UH: MARKET_SELL_THRESHOLD }, orders: [] })).toBeUndefined();
    const orders = [inRoom('o', 'buy', 'UH', 1, 10000)];
    const deal = planSell({ ...base, stock: { UH: MARKET_SELL_THRESHOLD + 10 }, orders });
    expect(deal?.amount).toBe(MARKET_SELL_THRESHOLD + 10 - MARKET_KEEP_PRODUCT);
  });
  it('respects the deal cap and skips lowball orders', () => {
    const orders = [inRoom('cheap', 'buy', 'UH', MARKET_SELL_FLOOR - 0.01, 10000), inRoom('ok', 'buy', 'UH', 1, 10000)];
    const deal = planSell({ ...base, orders });
    expect(deal?.orderId).toBe('ok');
    expect(deal!.amount).toBeLessThanOrEqual(MARKET_DEAL_MAX);
  });
  it('declines when the energy fee is unaffordable or the order is too far', () => {
    const orders = [inRoom('o', 'buy', 'UH', 1, 10000)];
    expect(planSell({ ...base, terminalEnergy: 10, orders })).toBeUndefined();
    const far: MarketOrderLike[] = [{ id: 'far', type: 'buy', resourceType: 'UH', price: 1, amount: 10000, roomName: 'W40N40' }];
    expect(planSell({ ...base, orders: far })).toBeUndefined();
    // 能量费上限随 terminal 能量伸缩
    expect(marketEnergyFee({ amount: 100, distance: 1 })).toBe(10);
    expect(marketEnergyFee({ amount: 100, distance: 1 })).toBeLessThanOrEqual(5000 * MARKET_ENERGY_FEE_RATIO);
  });
});

describe('market buy (M6-6)', () => {
  const inputs = ['H'] as const;
  it('buys missing input at the cheapest acceptable sell order', () => {
    const orders = [inRoom('pricy', 'sell', 'H', MARKET_BUY_CEILING, 1000), inRoom('deal', 'sell', 'H', 0.3, 1000)];
    const deal = planBuy({ ...base, credits: MARKET_CREDIT_RESERVE + 100, inputs, orders });
    expect(deal).toEqual({ orderId: 'deal', resourceType: 'H', amount: MARKET_BUY_TRIGGER, kind: 'buy' });
  });
  it('stops buying when credits are at reserve', () => {
    const orders = [inRoom('o', 'sell', 'H', 0.3, 1000)];
    expect(planBuy({ ...base, credits: MARKET_CREDIT_RESERVE, inputs, orders })).toBeUndefined();
  });
  it('skips overpriced sellers and caps spend at the credit buffer', () => {
    const orders = [inRoom('hi', 'sell', 'H', MARKET_BUY_CEILING + 0.1, 1000), inRoom('fat', 'sell', 'H', 1, 10000)];
    const credits = MARKET_CREDIT_RESERVE + 50;
    const deal = planBuy({ ...base, credits, inputs, orders });
    expect(deal?.orderId).toBe('fat');
    expect(deal!.amount).toBe(50); // credits - RESERVE = 预算
  });
});
