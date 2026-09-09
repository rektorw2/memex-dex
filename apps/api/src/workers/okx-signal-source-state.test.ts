/**
 * Состояние REST-источника — по настоящему клиенту OKX, а не по
 * подготовленным фактам.
 *
 * Подделан только `fetch` (сеть) и база. Всё между ними настоящее:
 * подпись, `reportedCall`, разбор кода OKX в теле, классификация
 * отказа, воркер сверки и вердикт ядра. Проверяется главное: отказ
 * провайдера не выглядит как успешный ответ без сигналов, время
 * успеха обновляется только после подтверждённого ответа, а после
 * восстановления входы открываются сами.
 */
import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signalSourceVerdict } from '@memex/core';

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
    $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw: gate.$queryRaw, $executeRaw: gate.$executeRaw })),
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

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
let replies: Reply[] = [];
const fetchMock = vi.fn(async (url: string) => {
  // Список сетей — фиксированный ответ; очередь ответов — только для signal/list.
  const next: Reply = String(url).includes('/signal/supported/chain')
    ? { status: 200, body: { code: '0', data: [{ chainIndex: '501', chainName: 'Solana' }, { chainIndex: '56', chainName: 'BNB Chain' }] } }
    : replies.shift() ?? { status: 200, body: { code: '0', data: [] } };
  if (next instanceof Error) throw next;
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
    json: async () => next.body ?? null,
  } as unknown as Response;
});

const verdict = (now: number) => signalSourceVerdict(ingest.getOkxSignalSourceFacts(now));

beforeEach(() => {
  gate.reset();
  vi.stubGlobal('fetch', fetchMock);
  replies = [];
  budget.allow = true;
  fetchMock.mockClear();
});
afterEach(() => { ingest.stopOkxSignalIngest(); vi.unstubAllGlobals(); });

/** Сверка по одной сети: `syncLatestOkxSignals` для указанной сети. */
const reconcile = (chain = 'SOLANA') => ingest.syncLatestOkxSignals([chain as never], 'REST_RECONCILIATION');

/**
 * Запуск воркера: стартовый backfill идёт по умолчанию успешно
 * (пустой рынок), после чего очередь ответов пуста и счётчик вызовов
 * обнулён — дальше каждый тест управляет ответами сам.
 */
async function started() {
  ingest.startOkxSignalIngest();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  fetchMock.mockClear();
  const facts = ingest.getOkxSignalSourceFacts();
  expect(facts.lastRestSuccessAtMs).not.toBeNull();
  return facts.lastRestSuccessAtMs!;
}

describe('состояние REST-источника по настоящему клиенту', () => {
  it('успешный ответ без событий — источник жив', async () => {
    const before = await started();
    replies = [{ status: 200, body: { code: '0', data: [] } }];
    await reconcile();
    const facts = ingest.getOkxSignalSourceFacts();
    expect(facts.lastRestSuccessAtMs).toBeGreaterThanOrEqual(before);
    expect(facts.lastRestErrorCode).toBeNull();
    expect(verdict(Date.now())).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
  });

  it.each([
    [401, 'auth', 'REST_AUTH_REJECTED'],
    [403, 'auth', 'REST_AUTH_REJECTED'],
    [402, 'quota', 'REST_QUOTA_EXHAUSTED'],
  ])('HTTP %s — отказ %s: входы приостановлены сразу, время успеха не обновляется', async (status, code, verdictCode) => {
    const before = await started();
    replies = [{ status }];
    await reconcile();
    const facts = ingest.getOkxSignalSourceFacts();
    expect(facts.lastRestSuccessAtMs).toBe(before);
    expect(facts.lastRestErrorCode).toBe(code);
    expect(verdict(Date.now())).toMatchObject({ available: false, code: verdictCode });
  });

  it('код OKX в теле при HTTP 200 (50111 — неверный ключ) — это отказ, а не пустой рынок', async () => {
    const before = await started();
    replies = [{ status: 200, body: { code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] } }];
    await reconcile();
    const facts = ingest.getOkxSignalSourceFacts();
    expect(facts.lastRestSuccessAtMs).toBe(before);
    expect(facts.lastRestErrorCode).toBe('auth');
    expect(verdict(Date.now()).available).toBe(false);
  });

  it('429 и сетевой отказ — временные: успех не обновляется, источник стареет и через три интервала закрывается', async () => {
    const successAt = await started();

    replies = [{ status: 429, headers: { 'retry-after': '5' } }];
    await reconcile();
    expect(ingest.getOkxSignalSourceFacts().lastRestSuccessAtMs).toBe(successAt);
    expect(ingest.getOkxSignalSourceFacts().lastRestErrorCode).toMatch(/^rate-limit/);
    expect(verdict(successAt + 10_000)).toMatchObject({ available: true, code: 'OK_REST_ONLY' });

    replies = [new TypeError('fetch failed')];
    await reconcile();
    expect(ingest.getOkxSignalSourceFacts().lastRestSuccessAtMs).toBe(successAt);
    expect(ingest.getOkxSignalSourceFacts().lastRestErrorCode).toMatch(/^network/);
    const stale = verdict(successAt + 181_000);
    expect(stale).toMatchObject({ available: false, code: 'REST_STALE' });
    expect(stale.message).toContain('открытые позиции ведутся');
  });

  it('отказ нашего бюджета — сеть не трогали: не успех и не смерть, ответ провайдера не выдумывается', async () => {
    const successAt = await started();
    budget.allow = false;
    await reconcile();
    expect(fetchMock).not.toHaveBeenCalled();
    const facts = ingest.getOkxSignalSourceFacts();
    expect(facts.lastRestSuccessAtMs).toBe(successAt);
    expect(facts.lastRestErrorCode).toBe('budget');
    expect(verdict(successAt + 1_000)).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
    const stale = verdict(successAt + 181_000);
    expect(stale).toMatchObject({ available: false, code: 'REST_STALE' });
    expect(stale.message).toContain('бюджета');
  });

  it('после отказа успешный ответ снимает ошибку и возвращает источник в работу', async () => {
    await started();
    replies = [{ status: 401 }];
    await reconcile();
    expect(verdict(Date.now()).available).toBe(false);
    replies = [{ status: 200, body: { code: '0', data: [] } }];
    await reconcile();
    const facts = ingest.getOkxSignalSourceFacts();
    expect(facts.lastRestErrorCode).toBeNull();
    expect(verdict(Date.now())).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
  });

  it('несколько сетей: успех хотя бы по одной — источник жив; отказ по всем — записан', async () => {
    await started();
    replies = [{ status: 200, body: { code: '0', data: [] } }, { status: 429 }];
    await ingest.syncLatestOkxSignals(['SOLANA', 'BNB'] as never, 'REST_RECONCILIATION');
    expect(ingest.getOkxSignalSourceFacts().lastRestErrorCode).toBeNull();
    replies = [{ status: 403 }, { status: 403 }];
    await ingest.syncLatestOkxSignals(['SOLANA', 'BNB'] as never, 'REST_RECONCILIATION');
    expect(ingest.getOkxSignalSourceFacts().lastRestErrorCode).toBe('auth');
  });
});
