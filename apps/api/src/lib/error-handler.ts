import { ZodError } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Единый разбор ошибок ответа.
 *
 * Вынесено из `buildServer` не ради красоты, а ради проверяемости.
 * Обработчик, объявленный внутри сборки сервера, существует только
 * там: тест, поднимающий один модуль маршрутов, его не получает —
 * и видит `500` там, где боевой сервер отвечает `400`. Такой тест
 * либо признаёт несуществующий дефект, либо подтверждает вчерашнее
 * поведение; оба исхода хуже отсутствия теста.
 */
export function sendError(error: unknown, req: FastifyRequest, reply: FastifyReply) {
  /*
   * Ошибка разбора — это ответ человеку, а не сбой сервера.
   *
   * Незакрытая `ZodError` доходит до общего обработчика Fastify
   * и превращается в пятисотую: человек видит «что-то пошло не так»
   * вместо «проверьте адрес почты», а в журнале появляется запись
   * о внутренней ошибке, которой не было.
   */
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
}
