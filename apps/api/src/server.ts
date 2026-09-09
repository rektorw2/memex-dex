import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { sendError } from './lib/error-handler.js';

import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { authPlugin } from './lib/auth-plugin.js';
import { authRoutes } from './modules/auth.js';
import { orderRoutes } from './modules/orders.js';
import { copyRoutes } from './modules/copytrade.js';
import { portfolioRoutes } from './modules/portfolio.js';
import { adminRoutes } from './modules/admin.js';
import { liveIntentRoutes } from './modules/live-intents.js';
import { tokenRoutes } from './modules/tokens.js';
import { walletRoutes } from './modules/wallets.js';
import { radarRoutes } from './modules/radar.js';
import { accessRoutes } from './modules/access.js';
import { automationRoutes } from './modules/automation.js';
import { fundingRoutes } from './modules/funding.js';
import { paymentRoutes } from './modules/payments.js';
import { webhookRoutes } from './modules/webhooks.js';
import { walletIntelRoutes } from './modules/wallets-intel.js';
import { walletFavoriteRoutes } from './modules/wallet-favorites.js';
import { ingestRoutes } from './modules/ingest.js';
import { paperAgentRoutes } from './modules/paper-agent.js';

declare module 'fastify' {
  interface FastifyInstance {
    broadcast?: (event: string, payload: unknown) => void;
  }
}

export async function buildServer() {
  const app = Fastify({
    // В Fastify 5 параметр logger принимает только объект настроек.
    // Готовый экземпляр pino передаётся через loggerInstance — в
    // четвёртой версии это было одно и то же поле, отсюда и ошибка
    // «logger options only accepts a configuration object».
    loggerInstance: logger,
    trustProxy: true,
    // BigInt в JSON: цены токенов и суммы в базовых единицах не влезают в Number.
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  // В разработке пускаем любой источник, в production — только явный список
  // из CORS_ORIGINS. Раньше домен был зашит в код, и любой деплой на чужой
  // домен (railway.app, vercel.app, свой) молча ломал фронтенд:
  // браузер блокировал запросы, а в логах сервера было пусто.
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? env.CORS_ORIGINS : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1m',
    keyGenerator: (req) => (req.user?.sub as string) ?? req.ip,
  });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_TTL } });
  await app.register(websocket);
  await app.register(authPlugin);

  /**
   * Пустое тело при content-type: application/json — не ошибка.
   *
   * Стандартный парсер Fastify отвергает такой запрос с сообщением
   * «Body cannot be empty», хотя у действий без параметров тела и не
   * должно быть: запуск импорта, выход из сессии.
   * Клиент теперь не ставит заголовок без тела, но сервер не обязан
   * зависеть от аккуратности клиента — их может быть несколько.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      // Подпись платёжного webhook считается по исходным байтам.
      // Разбор и повторная сериализация JSON изменили бы пробелы,
      // порядок ключей или запись чисел и сломали проверку подписи.
      if (req.url.startsWith('/api/webhooks/')) return done(null, body);

      const text = body.toString('utf8');
      if (!text || text.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // Единый формат ошибок: клиент не должен парсить пять разных структур.
  // Разбор ошибок вынесен отдельно: тест, поднимающий один модуль
  // маршрутов, обязан получать те же коды, что и боевой сервер.
  app.setErrorHandler(sendError);

  // ─── WebSocket: цены и статусы ордеров ──────────────────────────────────
  // Структурный тип вместо импорта из 'ws': пакета @types/ws в зависимостях
  // нет, а нужны ровно три члена. Тянуть типы всего WebSocket ради этого
  // незачем — и лишняя зависимость в проде тоже не нужна.
  type Socket = {
    readyState: number;
    send: (data: string) => void;
    on: (event: string, cb: () => void) => void;
  };

  const sockets = new Set<Socket>();
  app.get('/ws', { websocket: true }, (socket) => {
    const s = socket as unknown as Socket;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  app.decorate('broadcast', (event: string, payload: unknown) => {
    const msg = JSON.stringify({ event, payload, ts: Date.now() });
    for (const s of sockets) {
      if (s.readyState === 1) s.send(msg);
    }
  });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, mode: env.EXECUTION_MODE, ts: new Date().toISOString() };
  });

  /**
   * Живость агента — отдельно от живости процесса и отдельно от
   * источника сигналов.
   *
   * `/health` отвечает `ok`, пока жива база; воркер при этом может
   * стоять. Здесь три состояния — `healthy / unhealthy / unknown` — и
   * HTTP 200 только за первое. Здоровье доказывает *успешно
   * завершённый* проход, а не начатый: воркер, падающий на каждом
   * проходе, начинает их исправно. Воркер в другом процессе виден
   * только через строку пульса в базе; нет строки — `unknown`, и это
   * тоже 503: отсутствие наблюдения не успех.
   *
   * Источник сигналов — отдельное поле: недоступный OKX останавливает
   * новые входы, но процесс агента жив и сопровождает позиции.
   * Секретов и адресов нет.
   */
  app.get('/health/agent', async (_req, reply) => {
    const { getPaperAgentRuntimeStatus, PAPER_AGENT_WORKER_NAME } = await import('./workers/paper-agent.js');
    const { getOkxSignalIngestStatus, getOkxSignalSourceFacts } = await import('./workers/okx-signal-ingest.js');
    const { signalSourceVerdict } = await import('@memex/core');
    const { agentHealthVerdict, AGENT_HEALTH_STALE_AFTER_MS } = await import('./lib/agent-health.js');
    const { memorySample } = await import('./workers/memory-monitor.js');
    const runtime = getPaperAgentRuntimeStatus();
    const now = Date.now();

    // Пульс читается только для воркера в другом процессе: у встроенного
    // память точнее строки, обновляемой раз в десять секунд.
    let heartbeat: import('./lib/agent-health.js').HeartbeatObservation | null | undefined;
    let heartbeatError: string | null = null;
    if (!env.RUN_WORKERS_IN_API) {
      try {
        const row = await prisma.workerHeartbeat.findUnique({ where: { name: PAPER_AGENT_WORKER_NAME } });
        heartbeat = row ? {
          processId: row.processId,
          startedAt: row.startedAt.toISOString(),
          lastTickStartedAt: row.lastTickStartedAt?.toISOString() ?? null,
          lastTickCompletedAt: row.lastTickCompletedAt?.toISOString() ?? null,
          lastErrorCode: row.lastErrorCode,
          consecutiveFailures: row.consecutiveFailures,
          updatedAt: row.updatedAt.toISOString(),
        } : null;
      } catch (error: any) {
        heartbeatError = error?.code ?? error?.name ?? 'HEARTBEAT_READ_FAILED';
      }
    }

    const verdict = agentHealthVerdict({
      workersInApi: env.RUN_WORKERS_IN_API,
      now,
      staleAfterMs: AGENT_HEALTH_STALE_AFTER_MS,
      inProcess: {
        running: runtime.running,
        refusalReason: runtime.refusalReason,
        lastTickStartedAt: runtime.lastTickStartedAt,
        lastTickCompletedAt: runtime.lastTickCompletedAt,
        consecutiveTickFailures: runtime.consecutiveTickFailures,
        lastErrorCode: runtime.lastErrorCode,
      },
      heartbeat,
      heartbeatError,
    });

    const source = signalSourceVerdict(getOkxSignalSourceFacts());
    const ingest = getOkxSignalIngestStatus();
    const ageMs = (iso: string | null) => (iso ? Math.max(0, now - new Date(iso).getTime()) : null);

    return reply.code(verdict.httpStatus).send({
      ok: verdict.state === 'healthy',
      state: verdict.state,
      reason: verdict.reason,
      message: verdict.message,
      observedVia: verdict.observedVia,
      workersInApi: env.RUN_WORKERS_IN_API,
      staleAfterMs: AGENT_HEALTH_STALE_AFTER_MS,
      // Память этого процесса — для наблюдения за сутки без доступа к Render.
      process: memorySample(),
      agent: env.RUN_WORKERS_IN_API
        ? {
            running: runtime.running,
            refusalReason: runtime.refusalReason,
            lastTickStartedAt: runtime.lastTickStartedAt,
            lastTickStartedAgeMs: ageMs(runtime.lastTickStartedAt),
            lastTickCompletedAt: runtime.lastTickCompletedAt,
            lastTickCompletedAgeMs: ageMs(runtime.lastTickCompletedAt),
            consecutiveTickFailures: runtime.consecutiveTickFailures,
            lastActivityAt: runtime.lastActivityAt,
            queued: runtime.queued,
            processingErrors: runtime.processingErrors,
            heartbeatWriteErrors: runtime.heartbeatWriteErrors,
            lastErrorCode: runtime.lastErrorCode,
            entriesPausedBySource: runtime.entriesPausedBySource,
          }
        : {
            // В этом процессе воркера нет; его локальные поля ничего не значат.
            running: null,
            heartbeat: heartbeat
              ? {
                  processId: heartbeat.processId,
                  startedAt: heartbeat.startedAt,
                  lastTickStartedAt: heartbeat.lastTickStartedAt,
                  lastTickStartedAgeMs: ageMs(heartbeat.lastTickStartedAt),
                  lastTickCompletedAt: heartbeat.lastTickCompletedAt,
                  lastTickCompletedAgeMs: ageMs(heartbeat.lastTickCompletedAt),
                  consecutiveFailures: heartbeat.consecutiveFailures,
                  lastErrorCode: heartbeat.lastErrorCode,
                  updatedAt: heartbeat.updatedAt,
                  updatedAgeMs: ageMs(heartbeat.updatedAt),
                }
              : null,
            heartbeatError,
          },
      // Состояние источника — отдельно от живости процесса.
      source: {
        state: source.available ? 'available' : 'unavailable',
        available: source.available,
        code: source.code,
        transport: source.transport,
        message: source.message,
        lastSignalAt: ingest.lastSignalAt,
        lastSignalAgeMs: ageMs(ingest.lastSignalAt),
        lastRestSuccessAt: ingest.lastRestSuccessAt,
        lastRestSuccessAgeMs: ageMs(ingest.lastRestSuccessAt),
      },
      ts: new Date(now).toISOString(),
    });
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(accessRoutes, { prefix: '/api' });
  await app.register(automationRoutes, { prefix: '/api/v1' });
  await app.register(fundingRoutes, { prefix: '/api/v1' });
  await app.register(paymentRoutes, { prefix: '/api' });
  await app.register(webhookRoutes, { prefix: '/api' });
  await app.register(tokenRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  await app.register(copyRoutes, { prefix: '/api/v1' });
  await app.register(portfolioRoutes, { prefix: '/api/v1' });
  await app.register(walletRoutes, { prefix: '/api/v1' });
  await app.register(radarRoutes, { prefix: '/api/v1' });
  await app.register(walletIntelRoutes, { prefix: '/api/v1' });
  await app.register(walletFavoriteRoutes, { prefix: '/api/v1' });
  await app.register(ingestRoutes, { prefix: '/api/v1' });
  await app.register(paperAgentRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  // Тот же префикс и та же модель авторизации, что у остальных
  // маршрутов: параллельная модель прав однажды разойдётся с этой.
  await app.register(liveIntentRoutes, { prefix: '/api/v1' });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });

  // На бесплатных тарифах отдельный фоновый сервис недоступен, а без
  // воркеров не обновляются цены и не срабатывают лимитки. Импорт
  // динамический: при выключенном флаге модули даже не загружаются.
  let stopWorkers: (() => void) | null = null;
  if (env.RUN_WORKERS_IN_API) {
    /*
     * Набор воркеров — тот же, что у отдельного процесса
     * (`workers/registry.ts`): раньше два списка разошлись, и в бою
     * (Render, воркеры внутри API) не запускалось то, что стояло в
     * standalone. Финансовые воркеры включаются только своими флагами.
     */
    const { startBaseWorkers, startSchemaWorkers, stopWorkers: stopAll, describeWorkers } = await import('./workers/registry.js');
    const baseWorkers = await startBaseWorkers();

    /**
     * Всё, что пишет в таблицы кошельков, запускается только после
     * проверки схемы.
     *
     * Схема здесь наливается вручную, а код катится автоматически,
     * поэтому новый воркер регулярно оказывается в бою раньше нужной
     * колонки. Prisma перечисляет колонки в SELECT явно — запрос
     * к отставшей таблице падает целиком, и вместе с ним падает
     * ответ, к кошелькам отношения не имеющий.
     *
     * Проверка строго на чтение: `db push` на старте боевого процесса
     * был бы молчаливой миграцией в момент наибольшей нагрузки.
     */
    const { guardSchemaOnStartup } = await import('./lib/schema-guard.js');
    const schemaReady = await guardSchemaOnStartup();
    let schemaWorkers: Awaited<ReturnType<typeof startSchemaWorkers>> = [];
    if (schemaReady) {
      schemaWorkers = await startSchemaWorkers();
      app.log.info(describeWorkers([...baseWorkers, ...schemaWorkers]), 'воркеры запущены внутри API');
    } else {
      // Остальное API продолжает работать: недоступность одной
      // подсистемы не повод гасить страницы, которые к ней
      // не обращаются.
      app.log.warn('воркеры кошельков не запущены: схема базы не готова');
    }

    stopWorkers = () => {
      stopAll(schemaWorkers);
      stopAll(baseWorkers);
    };

    app.log.warn(
      'Воркеры запущены внутри процесса API. Для нагрузки выше демонстрационной ' +
        'вынесите их в отдельный сервис: RUN_WORKERS_IN_API=false',
    );
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: останавливаемся`);
    stopWorkers?.();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
