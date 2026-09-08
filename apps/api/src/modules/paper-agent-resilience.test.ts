import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Что происходит с `/agent`, когда ломается один из его источников.
 *
 * Отчёт о причине отказа мне достался готовым, и проверять его
 * сравнением с ним же бессмысленно. Здесь причина воспроизводится
 * поведением: база отвечает ровно так, как отвечала боевая — таблицы
 * `FundingSafetyLatch` в ней нет, потому что миграция не применялась,
 * — и видно, что именно получает человек.
 *
 * Разделение простое и оно же требование:
 *
 *   • данные PAPER — обязательные. Без них показывать нечего;
 *   • диагностика пополнения, диагностика подписи и готовность LIVE
 *     — дополнительные. Ни одна из них не участвует в PAPER-торговле,
 *     и падение любой из них не должно уносить весь экран.
 *
 * До исправления любой из четырёх блоков ронял ответ целиком: человек
 * с бумажным счётом видел пустой экран из-за диагностики контура,
 * которым не пользовался.
 */

/** Ошибка Prisma при обращении к отсутствующей таблице. */
function missingTable(table: string): Error {
  const error = new Error(
    `The table \`public.${table}\` does not exist in the current database.`,
  );
  (error as any).code = 'P2021';
  (error as any).clientVersion = '6.0.0';
  return error;
}

const control = {
  id: 'primary',
  isEnabled: true,
  baselineStrategyKey: 'okx-signal-v2-baseline',
  telegramShadowEnabled: false,
  activeAllocationMode: 'FIXED',
  learningModeEnabled: false,
  updatedAt: new Date('2026-09-05T10:00:00Z'),
};

/** Сколько раз запрошены отсутствующие таблицы поздних миграций. */
const missing = {
  fundingSafetyLatch: vi.fn(async () => {
    throw missingTable('FundingSafetyLatch');
  }),
  signingIdentity: vi.fn(async () => {
    throw missingTable('SigningIdentity');
  }),
  signingAttempt: vi.fn(async () => {
    throw missingTable('SigningAttempt');
  }),
};

const healthy = {
  fundingSafetyLatch: vi.fn(async () => null),
  signingIdentity: vi.fn(async () => null),
  signingAttempt: vi.fn(async () => 0),
};

/** Переключатель между «таблиц нет» и «таблицы на месте». */
let phase4Tables: 'missing' | 'healthy' = 'healthy';
const latch = () =>
  phase4Tables === 'missing'
    ? missing.fundingSafetyLatch()
    : healthy.fundingSafetyLatch();

const prismaMock = {
  user: { findUnique: vi.fn(async () => ({ role: 'USER' })) },
  paperAgentControl: { findUniqueOrThrow: vi.fn(async () => ({ ...control })) },
  paperAgentStrategy: {
    findMany: vi.fn(async () => [
      {
        id: 'baseline-id',
        key: 'okx-signal-v2-baseline',
        label: 'Baseline',
        kind: 'BASELINE',
        isEnabled: true,
        config: {},
      },
    ]),
  },
  paperAgentRun: {
    groupBy: vi.fn(async () => []),
    findMany: vi.fn(async () => []),
  },
  okxSignal: {
    findFirst: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    groupBy: vi.fn(async () => []),
  },
  paperAgentNotification: { count: vi.fn(async () => 0) },
  paperAgentAccountSession: { findMany: vi.fn(async () => []) },
  paperAgentAllocationPolicy: { findMany: vi.fn(async () => []) },
  paperAgentAllocation: { findMany: vi.fn(async () => []) },
  fundingSafetyLatch: { findUnique: vi.fn(async () => latch()) },
  signingIdentity: {
    findUnique: vi.fn(async () =>
      phase4Tables === 'missing' ? missing.signingIdentity() : healthy.signingIdentity(),
    ),
  },
  signingAttempt: {
    count: vi.fn(async () =>
      phase4Tables === 'missing' ? missing.signingAttempt() : healthy.signingAttempt(),
    ),
  },
};

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../workers/paper-agent.js', () => ({
  ensurePaperAgentConfig: vi.fn(async () => undefined),
  getPaperAgentRuntimeStatus: vi.fn(() => ({
    running: true,
    queued: 0,
    lastActivityAt: new Date().toISOString(),
  })),
  paperAgentStartVerdict: vi.fn(() => ({ ok: true })),
  setPaperAgentEnabledCache: vi.fn(),
}));
vi.mock('../workers/okx-signal-ingest.js', () => ({
  getOkxSignalIngestStatus: vi.fn(() => ({
    running: true,
    transportMode: 'WEBSOCKET',
    socket: { state: 'connected' },
  })),
}));
vi.mock('../workers/paper-agent-notifications.js', () => ({
  getPaperAgentNotificationRuntime: vi.fn(() => ({
    running: true,
    telegramEnabled: false,
    transport: 'disabled',
  })),
  retryPaperAgentNotification: vi.fn(async () => true),
}));

const { paperAgentRoutes } = await import('./paper-agent.js');

/** Записи журнала: сюда уходит настоящая причина. */
const logged: Array<{ message: string; details: any }> = [];

async function userApp() {
  const instance = Fastify();
  const capture = (details: any, message: string) => {
    logged.push({ message, details });
  };
  (instance as any).log.error = capture;
  instance.addHook('onRequest', async (req: any) => {
    req.log.error = capture;
  });
  (instance as any).decorateRequest('user', null);
  instance.decorate('authenticate', async (req: any) => {
    req.user = { sub: 'user-1', role: 'USER' };
  });
  instance.decorate('requireAdmin', async (_req: any, reply: any) =>
    reply.code(403).send({ code: 'FORBIDDEN' }),
  );
  await instance.register(paperAgentRoutes);
  return instance;
}

beforeEach(() => {
  phase4Tables = 'healthy';
  logged.length = 0;
  vi.clearAllMocks();
});

describe('источник отказа /agent', () => {
  it('на исправной базе экран отдаётся целиком', async () => {
    /*
     * Негативный контроль к тестам ниже. Без него «отказ при
     * отсутствующей таблице» ничего не доказывает: ответ мог бы
     * падать и по любой другой причине.
     */
    const server = await userApp();
    const response = await server.inject({ method: 'GET', url: '/paper-agent' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ paper: true });

    await server.close();
  });

  it('отсутствующие таблицы поздних миграций не уносят PAPER-данные', async () => {
    /*
     * Ровно боевое состояние: планировщик пропустил четыре миграции,
     * приложение стартовало, таблиц нет.
     *
     * Требование: обязательная часть ответа доходит до человека,
     * а неработающая диагностика честно называется недоступной.
     */
    phase4Tables = 'missing';

    const server = await userApp();
    const response = await server.inject({ method: 'GET', url: '/paper-agent' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ paper: true });

    await server.close();
  });

  it('диагностика, которой нет, помечена недоступной, а не выдумана', async () => {
    // Худший исход — не пустой экран, а бодрый «всё в порядке»
    // на месте диагностики, которая не отвечает.
    phase4Tables = 'missing';

    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4).toMatchObject({ status: 'UNAVAILABLE' });

    await server.close();
  });

  it('в журнал уходит настоящая причина, человеку — ничего', async () => {
    /*
     * Два адресата, и путать их нельзя. Дежурному без причины
     * нечего чинить; человеку имя таблицы не поможет, а постороннему
     * расскажет об устройстве контура.
     */
    phase4Tables = 'missing';

    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).body;

    expect(logged.some((row) => row.details?.section === 'funding')).toBe(true);
    expect(logged.some((row) => /FundingSafetyLatch/.test(row.details?.err?.message ?? ''))).toBe(
      true,
    );
    expect(body).not.toMatch(/FundingSafetyLatch|does not exist|P2021|prisma/i);

    await server.close();
  });

  it('молчащая диагностика не делает LIVE готовым', async () => {
    // Инвариант из ядра, проверенный на настоящем ответе маршрута.
    phase4Tables = 'missing';

    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4.live.ready).toBe(false);
    expect(body.phase4.live.blockers).toContain('FUNDING_DIAGNOSTICS_UNAVAILABLE');

    await server.close();
  });

  it('раздел, который не ответил, отдаётся пустым, а не выдуманным', async () => {
    /*
     * `null` вместо значения по умолчанию. `HEALTHY` на месте
     * непрочитанной защёлки — это не «пока не знаем», это
     * утверждение, и притом ложное.
     */
    phase4Tables = 'missing';

    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4.depositNetwork).toBeNull();
    expect(body.phase4.unavailable).toContain('FUNDING');

    await server.close();
  });
});

describe('отказ обязательной части', () => {
  it('503 с машинным кодом и без подробностей', async () => {
    /*
     * Счёт, позиции и решения — без них показывать нечего, и
     * притворяться, что экран цел, нельзя.
     *
     * 503, а не 500: состояние временное и повтор осмыслен.
     * Интерфейс обязан отличать это от «нет доступа».
     */
    prismaMock.paperAgentControl.findUniqueOrThrow.mockRejectedValueOnce(
      missingTable('PaperAgentControl'),
    );

    const server = await userApp();
    const response = await server.inject({ method: 'GET', url: '/paper-agent' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'PAPER_SNAPSHOT_UNAVAILABLE' });
    expect(response.body).not.toMatch(/PaperAgentControl|does not exist|P2021/i);

    await server.close();
  });

  it('причина отказа обязательной части попадает в журнал', async () => {
    prismaMock.paperAgentControl.findUniqueOrThrow.mockRejectedValueOnce(
      missingTable('PaperAgentControl'),
    );

    const server = await userApp();
    await server.inject({ method: 'GET', url: '/paper-agent' });

    expect(
      logged.some((row) => /PaperAgentControl/.test(row.details?.err?.message ?? '')),
    ).toBe(true);

    await server.close();
  });

  it('исправная база отвечает 200 — отказ вызван именно поломкой', async () => {
    // Негативный контроль к двум тестам выше.
    const server = await userApp();
    const response = await server.inject({ method: 'GET', url: '/paper-agent' });

    expect(response.statusCode).toBe(200);

    await server.close();
  });
});

describe('ступень готовности LIVE в ответе', () => {
  it('на исправной базе ступень названа', async () => {
    /*
     * Конфигурация по умолчанию: подпись выключена, счетов нет.
     * Ступень обязана быть самой нижней — и обязана быть названа,
     * а не оставлена пустой.
     */
    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4.live.stage).toBe('PAPER_READY');
    expect(body.phase4.live.mainnetRequested).toBe(false);

    await server.close();
  });

  it('молчащая диагностика не даёт ступени вовсе', async () => {
    /*
     * `null`, а не `PAPER_READY`. Ступень — утверждение о состоянии
     * контура; сделать его по непрочитанным данным нельзя, и
     * подставить сюда нижнюю ступень «на всякий случай» тоже:
     * это было бы утверждением, которого никто не проверял.
     */
    phase4Tables = 'missing';

    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4.live.stage).toBeNull();
    expect(body.phase4.live.stageBlockers).toEqual([]);

    await server.close();
  });

  it('ступень не обещает готовности', async () => {
    // На нижней ступени `ready` обязан оставаться ложным.
    const server = await userApp();
    const body = (await server.inject({ method: 'GET', url: '/paper-agent' })).json();

    expect(body.phase4.live.ready).toBe(false);
    expect(body.phase4.live.stageBlockers.length).toBeGreaterThan(0);

    await server.close();
  });
});
