import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

export type UserRole = 'USER' | 'TRADER' | 'ADMIN';

export interface JwtPayload {
  sub: string;
  role: UserRole;
}

/**
 * Типизация request.user делается через FastifyJWT, а не через FastifyRequest.
 *
 * @fastify/jwt объявляет `user` сам, с типом `string | object | Buffer`.
 * Попытка переопределить это свойство напрямую в интерфейсе FastifyRequest
 * даёт TS2717 («повторное объявление должно иметь тот же тип»), и весь
 * production-билд падает. В dev это не всплывало: tsx компилирует без
 * проверки типов, поэтому ошибка ждала бы первого деплоя.
 *
 * Правильная точка расширения — интерфейс FastifyJWT: плагин сам выводит
 * из него тип request.user.
 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
    if (req.user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Недостаточно прав' });
    }
  });
};

export const authPlugin = fp(plugin);
