/** Independent review regression: real OKX client and refresh worker, mocked HTTP and database. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const budget = vi.hoisted(() => ({ allow: true }));

vi.mock('../lib/env.js', () => ({
  env: {
    OKX_API_KEY: 'key', OKX_API_SECRET: 'secret', OKX_PASSPHRASE: 'pass', OKX_PROJECT_ID: undefined,
    OKX_WS_ENABLED: false, OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS: 60_000,
    OKX_WS_STALE_AFTER_MS: 60_000, OKX_WS_URL: 'wss://x', BNB_RPC_URL: 'https://bsc', RHC_RPC_URL: 'https://rh', RHC_CHAIN_ID: 4663,
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    okxSignal: { findUnique: async () => null, update: async () => null },
    $transaction: async () => { throw new Error('база в этом тесте не нужна'); },
  },
}));
vi.mock('./hot-tokens.js', () => ({ markHot: vi.fn() }));
vi.mock('./candle-builder.js', () => ({ requestCandlesSoon: vi.fn() }));
vi.mock('./paper-agent.js', () => ({ queuePaperAgentSignal: vi.fn(), setPaperSignalSourceProbe: vi.fn() }));
vi.mock('../services/okx-usage.js', () => ({
  canSpendOkxCall: () => (budget.allow ? { allow: true, slow: false } : { allow: false, slow: false, reason: 'reserve' }),
  recordOkxCall: vi.fn(),
}));
// Локальные повторы `safeCall` здесь не нужны: сигналы идут через reportedCall без повторов.
vi.mock('../lib/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cache.js')>();
  return { ...actual, RateLimit: class { async take() {} }, Concurrency: class { async run<T>(fn: () => Promise<T>) { return fn(); } } };
});

const ingest = await import('./okx-signal-ingest.js');

const fetchMock = vi.fn<(url: string) => Promise<Response>>();

const market = await import('../services/okx-market.js');
let signalFails = false, marketFails = false, empty = false;
const calls = (kind: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(`/${kind}/supported/chain`)).length;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
  ingest.stopOkxSignalIngest(); market.setOkxSignalChainIndexes(null); market.setOkxMarketChainIndexes(null);
  budget.allow = true; signalFails = false; marketFails = false; empty = false;
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear();
  fetchMock.mockImplementation(async (url: string) => {
    const fails = String(url).includes('/signal/') ? signalFails : marketFails;
    return { ok: !fails, status: fails ? 403 : 200, headers: {get: () => null},
      json: async () => ({code:'0', data: empty ? [] : [{chainIndex:'501',chainName:'Solana'}]}) } as any;
  });
});
afterEach(() => { ingest.stopOkxSignalIngest(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['market','signal'] as const)('%s failure retries after two minutes independently of the successful other list (independent review repro)', async kind => {
  signalFails = kind === 'signal'; marketFails = kind === 'market';
  await ingest.refreshSignalSupportedChains();
  expect(market.getOkxChainConfirmation(kind).status).toBe('missing');
  expect(calls('signal')).toBe(1); expect(calls('market')).toBe(1);
  await vi.advanceTimersByTimeAsync(120_000); signalFails = false; marketFails = false;
  await ingest.refreshSignalSupportedChains();
  expect(calls(kind)).toBe(2); expect(calls(kind === 'signal' ? 'market' : 'signal')).toBe(1);
  expect(market.getOkxChainConfirmation(kind).status).toBe('valid');
});
it('TTL expiry refuses stale confirmations; failed hourly refresh retries in a minute and recovers', async () => {
  await ingest.refreshSignalSupportedChains();
  await vi.advanceTimersByTimeAsync(60*60_000); signalFails = true; marketFails = true;
  await ingest.refreshSignalSupportedChains();
  expect(market.getOkxChainConfirmation('signal').status).toBe('valid');
  await vi.advanceTimersByTimeAsync(60_000); await ingest.refreshSignalSupportedChains();
  expect(calls('signal')).toBe(3); expect(calls('market')).toBe(3);
  await vi.advanceTimersByTimeAsync(5*60_000);
  expect(market.getOkxChainConfirmation('signal').status).toBe('expired');
  expect(market.getOkxSignalChainIndexes()).toEqual([]); expect(market.getOkxMarketChainIndexes()).toEqual([]);
  signalFails = false; marketFails = false; await ingest.refreshSignalSupportedChains();
  expect(market.getOkxSignalChainIndexes()).toEqual(['501']); expect(market.getOkxMarketChainIndexes()).toEqual(['501']);
});
it('successful empty list is a valid hourly confirmation, distinct from missing and expired', async () => {
  expect(market.getOkxChainConfirmation('signal')).toEqual({status:'missing',succeededAt:null});
  empty = true; await ingest.refreshSignalSupportedChains();
  expect(market.getOkxSignalChainIndexes()).toEqual([]);
  expect(market.getOkxChainConfirmation('signal').status).toBe('valid');
  await vi.advanceTimersByTimeAsync(120_000); await ingest.refreshSignalSupportedChains();
  expect(calls('signal')).toBe(1); expect(calls('market')).toBe(1);
  await vi.advanceTimersByTimeAsync(64*60_000);
  expect(market.getOkxChainConfirmation('signal').status).toBe('expired');
  await ingest.refreshSignalSupportedChains(); expect(calls('signal')).toBe(2);
});
it('repeated ticks and overlapping refreshes do not create a request storm', async () => {
  signalFails = true; marketFails = true;
  await Promise.all(Array.from({length:50},()=>ingest.refreshSignalSupportedChains()));
  expect(calls('signal')).toBe(1); expect(calls('market')).toBe(1);
  await vi.advanceTimersByTimeAsync(59_000);
  await Promise.all(Array.from({length:50},()=>ingest.refreshSignalSupportedChains()));
  expect(calls('signal')).toBe(1); expect(calls('market')).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000); await ingest.refreshSignalSupportedChains();
  expect(calls('signal')).toBe(2); expect(calls('market')).toBe(2);
});
it('one pending request does not overlap itself or block recovery of the other list', async () => {
  let resolve!: (response: any) => void;
  fetchMock.mockImplementation(async (url: string) => String(url).includes('/signal/') ? new Promise(r => {resolve=r;}) : ({ok:false,status:403,headers:{get:()=>null}} as any));
  const pending = ingest.refreshSignalSupportedChains();
  for(let i=0;i<30;i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(120_000);
  await ingest.refreshSignalSupportedChains();
  expect(calls('signal')).toBe(1); expect(calls('market')).toBe(2);
  resolve({ok:true,status:200,headers:{get:()=>null},json:async()=>({code:'0',data:[]})}); await pending;
});
