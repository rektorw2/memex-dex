/**
 * Поведение `/health/agent` на настоящем сервере и настоящем воркере.
 *
 * Сервер собирается `buildServer`, запрос идёт через Fastify inject,
 * воркер — настоящий `startPaperAgent` / `runPaperAgentTickOnce`
 * с подменённой базой. Подменяется ровно то, чего в тесте нет:
 * PostgreSQL и переключатель `RUN_WORKERS_IN_API`. Ни маршрут,
 * ни runtime агента не мокируются — иначе тест проверял бы мок.
 *
 * Независимое ревью воспроизвело два дефекта прежнего маршрута:
 * остановленный встроенный воркер отвечал HTTP 200, а при
 * `RUN_WORKERS_IN_API=false` ненаблюдаемый внешний процесс получал
 * `ok: true`. Оба случая здесь — обязательные.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  enabled: false,
  /** Как отвечает чтение PaperAgentControl: 'ok' | 'throw' | 'hang'. */
  lookup: 'ok' as 'ok' | 'throw' | 'hang',
  /** Сколько первых чтений ещё успешны, прежде чем начнёт действовать `lookup`. */
  okCallsLeft: 0,
}));
const heartbeatStore = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  readError: null as null | { code: string },
  writes: [] as Array<Record<string, unknown>>,
}));
const flags = vi.hoisted(() => ({ workersInApi: true }));

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
  $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => work(prismaMock)),
  paperAgentControl: {
    findUnique: vi.fn(async () => {
      if (control.okCallsLeft > 0) { control.okCallsLeft--; return { id: 'primary', isEnabled: control.enabled, baselineStrategyKey: 'okx-signal-v2-baseline', telegramShadowEnabled: false }; }
      if (control.lookup === 'throw') { const e: any = new Error('db down'); e.code = 'P1001'; throw e; }
      if (control.lookup === 'hang') return new Promise(() => undefined);
      return { id: 'primary', isEnabled: control.enabled, baselineStrategyKey: 'okx-signal-v2-baseline', telegramShadowEnabled: false };
    }),
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  paperAgentStrategy: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
  paperAgentAllocation: { findMany: vi.fn(async () => []) },
  paperAgentRun: { findMany: vi.fn(async () => []) },
  token: { findMany: vi.fn(async () => []) },
  workerHeartbeat: {
    findUnique: vi.fn(async () => {
      if (heartbeatStore.readError) { const e: any = new Error('no table'); e.code = heartbeatStore.readError.code; throw e; }
      return heartbeatStore.row;
    }),
    upsert: vi.fn(async ({ create }: any) => { heartbeatStore.writes.push(create); return create; }),
  },
}));

vi.mock('./lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('./lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/env.js')>();
  return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'RUN_WORKERS_IN_API' ? flags.workersInApi : (target as any)[key]) }) };
});

const { buildServer } = await import('./server.js');
const agent = await import('./workers/paper-agent.js');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

const NOW = Date.parse('2026-09-09T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);

async function health() {
  const res = await app.inject({ method: 'GET', url: '/health/agent' });
  return { http: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  control.enabled = false;
  control.lookup = 'ok';
  control.okCallsLeft = 0;
  heartbeatStore.row = null;
  heartbeatStore.readError = null;
  heartbeatStore.writes.length = 0;
  flags.workersInApi = true;
  app = await buildServer();
});

afterEach(async () => {
  agent.stopPaperAgent();
  await app.close();
  vi.useRealTimers();
});

describe('воркер внутри API (RUN_WORKERS_IN_API=true)', () => {
  it('воркер не запускался — 503 unhealthy, а не 200 с ok=false', async () => {
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ ok: false, state: 'unhealthy', reason: 'WORKER_NOT_RUNNING', workersInApi: true, observedVia: 'in-process' });
    expect(body.agent.running).toBe(false);
    expect(body.agent.lastTickCompletedAt).toBeNull();
  });

  it('запущен и проход завершился — 200 healthy; начатый и завершённый проход показаны раздельно', async () => {
    expect(await agent.startPaperAgent()).toBe(true);
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(200);
    expect(body).toMatchObject({ ok: true, state: 'healthy', reason: 'TICK_COMPLETED_RECENTLY' });
    expect(body.agent.lastTickStartedAt).toEqual(expect.any(String));
    expect(body.agent.lastTickCompletedAt).toEqual(expect.any(String));
    expect(Date.parse(body.agent.lastTickCompletedAt)).toBeGreaterThanOrEqual(Date.parse(body.agent.lastTickStartedAt));
    expect(body.agent.consecutiveTickFailures).toBe(0);
    // Состояние источника — отдельным полем, и не влияет на код ответа.
    expect(body.source).toMatchObject({ state: expect.stringMatching(/^(available|unavailable)$/), code: expect.any(String) });
  });

  it('остановлен после работы — 503 unhealthy, хотя последний проход был успешным', async () => {
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    expect((await health()).http).toBe(200);
    agent.stopPaperAgent();
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'WORKER_NOT_RUNNING' });
    expect(body.agent.lastTickCompletedAt, 'история прохода сохранена, но здоровья не даёт').toEqual(expect.any(String));
  });

  it('просроченный проход (воркер завис на запросе к базе) — 503 unhealthy при running=true', async () => {
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    // Следующий проход зависает: чтение управления не отвечает.
    control.lookup = 'hang';
    vi.setSystemTime(NOW + 30_000);
    void agent.runPaperAgentTickOnce();
    vi.setSystemTime(NOW + 61_000);
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'TICK_STALE' });
    expect(body.agent.running).toBe(true);
    expect(body.agent.lastTickCompletedAgeMs).toBeGreaterThanOrEqual(61_000);
    // Начатый проход свежий — именно его прежняя проверка принимала за жизнь.
    expect(body.agent.lastTickStartedAgeMs).toBeLessThan(61_000);
  });

  it('постоянно падающий воркер: проходы начинаются, ни один не завершается — 503, счётчик и код ошибки', async () => {
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    control.lookup = 'throw';
    for (let i = 0; i < 3; i++) await agent.runPaperAgentTickOnce();
    vi.setSystemTime(NOW + 61_000);
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'TICK_STALE' });
    expect(body.agent.consecutiveTickFailures).toBe(4);
    expect(body.agent.lastErrorCode).toBe('P1001');
    expect(body.message).toContain('4');
    // Восстановление базы возвращает здоровье и обнуляет серию.
    control.lookup = 'ok';
    await agent.runPaperAgentTickOnce();
    const after = await health();
    expect(after.http).toBe(200);
    expect(after.body.agent.consecutiveTickFailures).toBe(0);
  });

  it('падает с первого прохода — 503 unhealthy, не «стартует»', async () => {
    // Старт читает управление один раз успешно; каждый проход после — с ошибкой.
    control.okCallsLeft = 1;
    control.lookup = 'throw';
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'NO_COMPLETED_TICK' });
  });

  it('перезапуск не наследует отметку прошлого запуска: сразу падающий воркер не выглядит здоровым', async () => {
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    expect((await health()).http).toBe(200);
    agent.stopPaperAgent();
    vi.setSystemTime(NOW + 5_000);
    control.okCallsLeft = 1;
    control.lookup = 'throw';
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'NO_COMPLETED_TICK' });
    expect(body.agent.lastTickCompletedAt).toBeNull();
  });

  it('пульс пишется в базу и ошибка записи проход не ломает', async () => {
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    expect(heartbeatStore.writes.at(-1)).toMatchObject({ name: 'paper-agent', processId: String(process.pid), consecutiveFailures: 0 });
    expect(heartbeatStore.writes.at(-1)!.lastTickCompletedAt).toBeInstanceOf(Date);

    prismaMock.workerHeartbeat.upsert.mockRejectedValueOnce(Object.assign(new Error('no table'), { code: 'P2021' }));
    vi.setSystemTime(NOW + 11_000);
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(200);
    expect(body.agent.heartbeatWriteErrors).toBe(1);
  });
});

describe('воркер в отдельном процессе (RUN_WORKERS_IN_API=false)', () => {
  beforeEach(() => { flags.workersInApi = false; });

  it('пульса нет — 503 unknown, а не ok=true; локальная память воркера не используется', async () => {
    // Даже если в этом процессе воркер «жив» (стенд), внешний не наблюдается.
    await agent.startPaperAgent();
    await agent.runPaperAgentTickOnce();
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ ok: false, state: 'unknown', reason: 'HEARTBEAT_MISSING', workersInApi: false, observedVia: 'none' });
    expect(body.agent.running).toBeNull();
    expect(body.agent.heartbeat).toBeNull();
  });

  it('пульс не читается (таблицы нет) — 503 unknown с кодом ошибки', async () => {
    heartbeatStore.readError = { code: 'P2021' };
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unknown', reason: 'HEARTBEAT_UNREADABLE' });
    expect(body.agent.heartbeatError).toBe('P2021');
  });

  it('свежий пульс с завершённым проходом — 200 healthy по пульсу', async () => {
    heartbeatStore.row = { name: 'paper-agent', processId: '777', hostname: 'srv', startedAt: ago(3_600_000), lastTickStartedAt: ago(900), lastTickCompletedAt: ago(800), lastErrorCode: null, consecutiveFailures: 0, updatedAt: ago(700) };
    const { http, body } = await health();
    expect(http).toBe(200);
    expect(body).toMatchObject({ ok: true, state: 'healthy', observedVia: 'heartbeat' });
    expect(body.agent.heartbeat).toMatchObject({ processId: '777', consecutiveFailures: 0 });
    expect(body.agent.heartbeat.lastTickCompletedAgeMs).toBe(800);
  });

  it('пульс умершего процесса — 503 unhealthy', async () => {
    heartbeatStore.row = { name: 'paper-agent', processId: '777', hostname: null, startedAt: ago(3_600_000), lastTickStartedAt: ago(600_000), lastTickCompletedAt: ago(600_000), lastErrorCode: null, consecutiveFailures: 0, updatedAt: ago(600_000) };
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'HEARTBEAT_STALE' });
  });

  it('пульс свежий, но процесс падает на каждом проходе — 503 unhealthy', async () => {
    heartbeatStore.row = { name: 'paper-agent', processId: '777', hostname: null, startedAt: ago(3_600_000), lastTickStartedAt: ago(500), lastTickCompletedAt: ago(300_000), lastErrorCode: 'P1001', consecutiveFailures: 299, updatedAt: ago(400) };
    const { http, body } = await health();
    expect(http).toBe(503);
    expect(body).toMatchObject({ state: 'unhealthy', reason: 'HEARTBEAT_STALE' });
    expect(body.agent.heartbeat).toMatchObject({ consecutiveFailures: 299, lastErrorCode: 'P1001' });
  });
});

describe('/health не подменяет /health/agent', () => {
  it('процесс и база отвечают ok, пока агент стоит', async () => {
    const plain = await app.inject({ method: 'GET', url: '/health' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().ok).toBe(true);
    expect((await health()).http).toBe(503);
  });
});

describe('автономный таймер без посетителей', () => {
  it('таймер продолжает проходы 20 минут без HTTP-запросов и сам восстанавливается после ошибки базы', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    await agent.startPaperAgent();
    // Ни health(), ни ручного runPaperAgentTickOnce в период простоя.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const idle = agent.getPaperAgentRuntimeStatus();
    expect(idle.running).toBe(true);
    expect(idle.lastTickCompletedAt).toBe(new Date(NOW + 20 * 60_000).toISOString());
    expect(heartbeatStore.writes.length).toBeGreaterThanOrEqual(120);

    control.lookup = 'throw';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.getPaperAgentRuntimeStatus().consecutiveTickFailures).toBeGreaterThan(0);
    control.lookup = 'ok';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.getPaperAgentRuntimeStatus().consecutiveTickFailures).toBe(0);
    expect(agent.getPaperAgentRuntimeStatus().lastTickCompletedAt).toBe(new Date(NOW + 1_210_000).toISOString());
    expect((await health()).http).toBe(200);
  });

});
