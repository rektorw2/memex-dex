/**
 * `GET /tokens/resolve` — ссылка из истории ведёт ровно на тот токен.
 *
 * Проверяются настоящий маршрут и правила совпадения: id + сеть +
 * адрес должны сойтись; регистр адреса Solana значим, EVM — нет;
 * скрытый сигнальный токен находится.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const dec = (v: string | number) => ({ toString: () => String(v) });
const MINT = 'BonkKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK';
const EVM = '0xAbCdEf0000000000000000000000000000000001';

const token = (over: Record<string, unknown> = {}) => ({
  id: 'tk-1', chain: 'SOLANA', address: MINT, symbol: 'BONK', name: 'Bonk', decimals: 5, logoUrl: null,
  isQuote: false, isVerified: false, isHidden: true, priceUsd: dec('0.0000125'), priceChange24h: null, priceUpdatedAt: new Date(),
  liquidityUsd: null, volume24hUsd: null, fdvUsd: null, riskScore: 10, riskLevel: 'low', riskCodes: [], isRegistered: false,
  scamVerdict: 'OK', scamReasons: null, scamCheckedAt: new Date(), scamRulesVersion: 10, scamProviderError: false,
  poolAddress: 'pool-1', poolCreatedAt: new Date(), firstSeenAt: new Date(), createdAt: new Date(), source: 'okx_signal',
  buys24h: null, sells24h: null, socials: null, holders: null, topHolderPct: null, lpBurnedPct: null, isHoneypot: false, metricsUpdated: null, research: null,
  ...over,
});

let rows: Record<string, any>[] = [];
const calls: Array<{ kind: string; args: any }> = [];

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    token: {
      findUnique: async (args: any) => {
        calls.push({ kind: 'findUnique', args });
        if (args.where.id) return rows.find((row) => row.id === args.where.id) ?? null;
        const key = args.where.chain_address;
        return rows.find((row) => row.chain === key.chain && row.address === key.address) ?? null; // точное сравнение, как в базе
      },
      findFirst: async (args: any) => {
        calls.push({ kind: 'findFirst', args });
        const { chain, address } = args.where;
        return rows.find((row) => row.chain === chain && row.address.toLowerCase() === address.equals.toLowerCase()) ?? null;
      },
      findMany: async () => rows, count: async () => rows.length, aggregate: async () => ({ _sum: {}, _count: 0 }), groupBy: async () => [],
      createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }),
    },
    candle: { findMany: async () => [], count: async () => 0 },
    call: { findMany: async () => [] }, trade: { findMany: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }) },
    position: { count: async () => 0, findMany: async () => [] }, auditLog: { create: async () => ({}) },
    $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };
  return { prisma, serializable: vi.fn() };
});
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../services/okx-market.js', () => ({ MARKET_DATA_SOURCE: 'okx', fetchPriceInfo: async () => ({ prices: new Map(), report: null }), fetchTokenCandles: async () => [] }));
vi.mock('../services/dexscreener.js', () => ({ fetchBoostedTokens: async () => [] }));
vi.mock('../lib/env.js', () => ({ env: { MIN_LIQUIDITY_USD: 0, RADAR_MIN_LIQUIDITY_USD: 0, NODE_ENV: 'test' } }));

const { tokenRoutes } = await import('./tokens.js');
let app: FastifyInstance;

beforeEach(async () => {
  rows = [token(), token({ id: 'tk-evm', chain: 'BNB', address: EVM.toLowerCase(), symbol: 'CAKE' })];
  calls.length = 0;
  app = Fastify();
  app.decorate('requireAdmin', async () => undefined);
  await app.register(tokenRoutes);
  await app.ready();
});

const resolve = (query: string) => app.inject({ method: 'GET', url: `/tokens/resolve?${query}` });

describe('GET /tokens/resolve', () => {
  it('скрытый сигнальный токен находится по id и помечен как скрытый', async () => {
    const res = await resolve('id=tk-1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'tk-1', hidden: true, hasChart: true });
  });

  it('id с чужой сетью или адресом — 404 TOKEN_LINK_MISMATCH, чужой график не отдаётся', async () => {
    expect((await resolve('id=tk-1&chain=BNB&address=' + MINT)).json()).toMatchObject({ code: 'TOKEN_LINK_MISMATCH' });
    expect((await resolve('id=tk-1&chain=SOLANA&address=Other11111111111111111111111111111111111111')).statusCode).toBe(404);
    expect((await resolve('id=tk-1&chain=SOLANA&address=' + MINT)).statusCode).toBe(200);
  });

  it('Solana: адрес сравнивается точно, регистр значим', async () => {
    expect((await resolve('chain=SOLANA&address=' + MINT)).statusCode).toBe(200);
    expect((await resolve('chain=SOLANA&address=' + MINT.toLowerCase())).statusCode).toBe(404);
    expect((await resolve('id=tk-1&chain=SOLANA&address=' + MINT.toLowerCase())).json()).toMatchObject({ code: 'TOKEN_LINK_MISMATCH' });
    expect(calls.filter((c) => c.kind === 'findFirst' && c.args.where.chain === 'SOLANA')).toHaveLength(0);
  });

  it('EVM: регистр адреса не значим', async () => {
    expect((await resolve('chain=BNB&address=' + EVM)).json()).toMatchObject({ id: 'tk-evm' });
    expect((await resolve('id=tk-evm&chain=BNB&address=' + EVM.toUpperCase().replace('0X', '0x'))).statusCode).toBe(200);
  });

  it('несуществующий токен — 404 TOKEN_NOT_FOUND', async () => {
    const res = await resolve('id=nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'TOKEN_NOT_FOUND' });
  });
});
