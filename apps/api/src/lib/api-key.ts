import type { FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from './prisma.js';

/**
 * Проверка ключа программного доступа.
 *
 * Один модуль на все точки входа: правило о том, что ключом нельзя
 * выводить средства, должно существовать в одном месте, а не повторяться
 * в каждом обработчике. Повторённое правило рано или поздно разойдётся.
 */

/**
 * Полный список областей.
 *
 * Здесь нет и не может быть области для вывода средств. Ключ лежит в файле
 * на машине, которую мы не контролируем, его нельзя закрыть вторым
 * фактором и нельзя спросить у владельца подтверждение. Единственная
 * надёжная защита денег — отсутствие самой возможности их отправить,
 * поэтому вывод остаётся только за живой сессией с 2FA.
 */
export const ALL_SCOPES = ['radar:ingest', 'trade:read', 'trade:write'] as const;
export type ApiScope = (typeof ALL_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'radar:ingest': 'Добавлять токены в радар',
  'trade:read': 'Читать позиции, ордера и баланс',
  'trade:write': 'Ставить и отменять ордера',
};

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Счётчики частоты в памяти процесса. */
const hourly = new Map<string, { count: number; windowStart: number }>();

export interface AuthedKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  maxOrderUsd: string | null;
}

function fail(message: string, statusCode: number): never {
  throw Object.assign(new Error(message), { statusCode });
}

/**
 * Достаёт и проверяет ключ из заголовка.
 *
 * requiredScope проверяется здесь же, а не в обработчике: обработчик,
 * забывший проверку, — это дыра, которую не видно при чтении кода.
 */
export async function requireApiKey(
  req: FastifyRequest,
  requiredScope: ApiScope,
): Promise<AuthedKey> {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!raw) fail('Требуется заголовок Authorization: Bearer <ключ>', 401);

  const hash = hashToken(raw);
  const key = await prisma.apiKey.findUnique({
    where: { tokenHash: hash },
    include: { user: { select: { isFrozen: true } } },
  });

  // Сравнение постоянным временем. Поиск по индексу сам по себе не утекает,
  // но пусть проверка будет единообразной.
  const matches =
    key != null &&
    timingSafeEqual(Buffer.from(key.tokenHash, 'hex'), Buffer.from(hash, 'hex'));

  if (!matches || !key.isActive) fail('Ключ недействителен', 401);
  if (key.user.isFrozen) fail('Аккаунт заморожен', 403);

  if (!key.scopes.includes(requiredScope)) {
    // Сообщаем, какой области не хватает: без этого владелец ключа
    // перебирает настройки вслепую.
    fail(
      `Ключу не хватает области доступа «${SCOPE_LABELS[requiredScope]}» (${requiredScope})`,
      403,
    );
  }

  // Окно частоты. Скользящее не нужно: задача — не пустить скрипт
  // в разнос, а не считать точно.
  const now = Date.now();
  const st = hourly.get(key.id);
  if (!st || now - st.windowStart > 3_600_000) {
    hourly.set(key.id, { count: 1, windowStart: now });
  } else if (st.count >= key.maxPerHour) {
    fail(`Превышен лимит: ${key.maxPerHour} запросов в час`, 429);
  } else {
    st.count++;
  }

  // Счётчик использования обновляем не дожидаясь: он справочный,
  // и задерживать ради него ответ на торговый запрос не стоит.
  void prisma.apiKey
    .update({
      where: { id: key.id },
      data: { lastUsedAt: new Date(), usedCount: { increment: 1 } },
    })
    .catch(() => undefined);

  return {
    id: key.id,
    userId: key.userId,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    maxOrderUsd: key.maxOrderUsd?.toString() ?? null,
  };
}

/**
 * Проверка предела суммы сделки для ключа.
 *
 * Отдельно от областей доступа: право ставить ордера и право ставить
 * ордер на любую сумму — разные вещи. Ошибка в скрипте с лишним нулём
 * стоит всего депозита, и предел здесь дешевле любой отладки.
 */
export function assertOrderWithinKeyLimit(key: AuthedKey, valueUsd: number): void {
  if (key.maxOrderUsd == null) return;

  const limit = Number(key.maxOrderUsd);
  if (Number.isFinite(limit) && valueUsd > limit) {
    fail(
      `Сумма $${valueUsd.toFixed(2)} превышает предел ключа $${limit.toFixed(2)}`,
      403,
    );
  }
}
