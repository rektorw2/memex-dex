import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';

import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { authPlugin } from './lib/auth-plugin.js';
import { authRoutes } from './modules/auth.js';
import { orderRoutes } from './modules/orders.js';
import { callRoutes } from './modules/calls.js';
import { copyRoutes } from './modules/copytrade.js';
import { portfolioRoutes } from './modules/portfolio.js';
import { adminRoutes } from './modules/admin.js';
import { tokenRoutes } from './modules/tokens.js';

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

  // Единый формат ошибок: клиент не должен парсить пять разных структур.
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Некорректные данные запроса',
        details: error.flatten().fieldErrors,
      });
    }

    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;

    if (status >= 500) {
      req.log.error({ err: error }, 'внутренняя ошибка');
      // Наружу не отдаём стек и внутренние сообщения: текст исключения
      // может содержать строку подключения или фрагмент запроса.
      return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
    }
    return reply.code(status).send({ error: err.message ?? 'Ошибка запроса' });
  });

  // ─── WebSocket: цены, статусы ордеров, новые коллы ───────────────────────
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

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(tokenRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  await app.register(callRoutes, { prefix: '/api/v1' });
  await app.register(copyRoutes, { prefix: '/api/v1' });
  await app.register(portfolioRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });

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
    const [{ startLimitWatcher, stopLimitWatcher }, { startPriceUpdater, stopPriceUpdater }, { startCopyExecutor, stopCopyExecutor }] =
      await Promise.all([
        import('./workers/limit-watcher.js'),
        import('./workers/price-updater.js'),
        import('./workers/copy-executor.js'),
      ]);

    startPriceUpdater();
    startLimitWatcher();
    startCopyExecutor();
    stopWorkers = () => {
      stopPriceUpdater();
      stopLimitWatcher();
      stopCopyExecutor();
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
