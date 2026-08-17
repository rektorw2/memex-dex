/**
 * Избранные кошельки.
 *
 * Отдельный модуль, а не дополнение к wallets-intel: там витрина,
 * общая для всех, здесь — личные данные одного пользователя. Смешение
 * этих двух вещей в одном файле рано или поздно заканчивается тем,
 * что в общий ответ утекает чужое избранное.
 *
 * Три правила, на которых всё держится.
 *
 * Первое. Кошелёк — это сеть плюс нормализованный адрес. Один и тот же
 * набор символов в Ethereum и BNB Chain принадлежит разным владельцам,
 * и склеивать их нельзя. Нормализация делается до обращения к базе:
 * уникальность проверяет она, а сравнивает побайтово.
 *
 * Второе. Добавление и удаление идемпотентны. Двойное нажатие,
 * повторная отправка при плохой связи и одновременный клик с двух
 * вкладок — обычные события, и ни одно из них не должно ни падать,
 * ни создавать вторую запись.
 *
 * Третье. Список отдаётся целиком одним запросом. Проверять
 * избранность построчно значит делать пятьдесят запросов на страницу
 * ленты — и получить их все при каждом обновлении раз в двадцать
 * секунд.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  normalizeAddress,
  summarizePnl,
  buildPositions,
  checkCompleteness,
  scorableTokens,
  type ChainKey,
  type CanonicalTrade,
  type EconomicTrade,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { favorites } from '../lib/prisma-favorites.js';
import { logger } from '../lib/logger.js';

/** Сети, за кошельками которых мы вообще умеем следить. */
const CHAINS = ['SOLANA', 'ETHEREUM', 'BNB', 'BASE'] as const;

const paramsSchema = z.object({
  chain: z.enum(CHAINS),
  address: z.string().min(24).max(128),
});

/**
 * Схема ещё не применена.
 *
 * Проект наливает схему вручную через `db:push`, поэтому новая
 * таблица какое-то время отсутствует. Ронять из-за этого весь раздел
 * нельзя: остальные вкладки к избранному отношения не имеют.
 */
const SCHEMA_MISSING = 'P2021';

function isSchemaMissing(e: any): boolean {
  return e?.code === SCHEMA_MISSING;
}

/** Ответ, когда таблицы ещё нет. Без SQL и без внутренностей Prisma. */
const notReady = {
  available: false,
  requiredAction: 'DATABASE_SCHEMA_UPDATE_REQUIRED',
  favorites: [] as unknown[],
};

export const walletFavoriteRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Избранное текущего пользователя.
   *
   * Одним запросом и целиком: интерфейсу нужен набор ключей, чтобы
   * закрасить звёзды в списке, а не ответ на вопрос про каждую строку
   * по отдельности.
   */
  app.get('/wallets/favorites', { preHandler: [app.authenticate] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;

    try {
      const rows = await favorites.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      if (rows.length === 0) {
        return { available: true, requiredAction: null, favorites: [] };
      }

      // Данные кошельков добираются одним запросом по всему набору,
      // а не по одному на строку: иначе список из полусотни адресов
      // означал бы полсотни обращений к базе.
      const wallets = await prisma.traderWallet.findMany({
        where: {
          OR: rows.map((r: (typeof rows)[number]) => ({
            chain: r.chain as never,
            address: r.walletAddress,
          })),
        },
      });

      const byKey = new Map(
        wallets.map((w: (typeof wallets)[number]) => [`${w.chain}:${w.address}`, w]),
      );

      const pnlByKey = await pnlForWallets(
        rows.map((r: (typeof rows)[number]) => ({
          chain: r.chain as ChainKey,
          address: r.walletAddress,
        })),
      );

      return {
        available: true,
        requiredAction: null,
        favorites: rows.map((r: (typeof rows)[number]) => {
          const key = `${r.chain}:${r.walletAddress}`;
          const w = byKey.get(key);
          const pnl = pnlByKey.get(key);

          return {
            chain: r.chain,
            address: r.walletAddress,
            note: r.note,
            addedAt: r.createdAt.toISOString(),

            // Кошелёк может быть добавлен раньше, чем о нём собрана
            // статистика. Это законное состояние, и отличать его
            // от нулевых показателей обязательно.
            known: w != null,
            score: w?.score ?? null,
            label: w?.label ?? null,
            tokensBought: w?.tokensBought ?? null,
            wins2x: w?.wins2x ?? null,
            lastActiveAt: w?.lastActiveAt?.toISOString() ?? null,

            pnl: pnl ?? {
              state: 'pending',
              realizedUsd: null,
              unrealizedUsd: null,
              closedPositions: null,
              incompleteTokens: null,
              computedAt: null,
            },
          };
        }),
      };
    } catch (e: any) {
      if (isSchemaMissing(e)) return notReady;

      // Наружу не уходит ни объект Prisma, ни текст запроса.
      logger.warn({ code: e?.code }, 'избранное: чтение не удалось');
      throw e;
    }
  });

  /**
   * Добавление.
   *
   * PUT, а не POST: операция идемпотентна, повторное нажатие обязано
   * давать тот же результат без ошибки. Двойной клик и повторная
   * отправка при плохой связи — обычные события.
   */
  app.put('/wallets/favorites/:chain/:address', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'Неизвестная сеть или адрес' });

    const userId = (req.user as { sub: string }).sub;
    const address = normalizeAddress(p.data.chain as ChainKey, p.data.address);

    try {
      // upsert по составному ключу: повторный вызов не создаёт второй
      // записи и не считается ошибкой.
      await favorites.upsert({
        where: {
          userId_chain_walletAddress: {
            userId,
            chain: p.data.chain as never,
            walletAddress: address,
          },
        },
        create: { userId, chain: p.data.chain as never, walletAddress: address },
        update: {},
      });

      return { chain: p.data.chain, address, isFavorite: true };
    } catch (e: any) {
      if (isSchemaMissing(e)) return reply.code(503).send(notReady);
      logger.warn({ code: e?.code }, 'избранное: добавление не удалось');
      throw e;
    }
  });

  /**
   * Удаление.
   *
   * Тоже идемпотентно: удаление отсутствующей записи — не ошибка,
   * а достигнутое состояние. Через deleteMany, потому что delete
   * бросает исключение, когда удалять нечего.
   */
  app.delete('/wallets/favorites/:chain/:address', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'Неизвестная сеть или адрес' });

    const userId = (req.user as { sub: string }).sub;
    const address = normalizeAddress(p.data.chain as ChainKey, p.data.address);

    try {
      await favorites.deleteMany({
        where: { userId, chain: p.data.chain as never, walletAddress: address },
      });

      return { chain: p.data.chain, address, isFavorite: false };
    } catch (e: any) {
      if (isSchemaMissing(e)) return reply.code(503).send(notReady);
      logger.warn({ code: e?.code }, 'избранное: удаление не удалось');
      throw e;
    }
  });

  /**
   * Перенос гостевого избранного в аккаунт.
   *
   * До входа звёзды живут в браузере. Терять их при входе нельзя:
   * человек отмечал кошельки, чтобы к ним вернуться, и вход — это
   * ровно тот момент, когда он ожидает их увидеть.
   *
   * Слияние, а не замена: то, что уже есть в аккаунте, остаётся.
   */
  app.post('/wallets/favorites/merge', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        items: z
          .array(z.object({ chain: z.enum(CHAINS), address: z.string().min(24).max(128) }))
          .max(500),
      })
      .safeParse(req.body);

    if (!body.success) return reply.code(400).send({ error: 'Неверный список' });

    const userId = (req.user as { sub: string }).sub;

    // Дедупликация до записи: один и тот же адрес мог попасть
    // в локальный список дважды, с разным регистром.
    const unique = new Map<string, { chain: ChainKey; address: string }>();
    for (const item of body.data.items) {
      const address = normalizeAddress(item.chain as ChainKey, item.address);
      unique.set(`${item.chain}:${address}`, { chain: item.chain as ChainKey, address });
    }

    try {
      const result = await favorites.createMany({
        data: [...unique.values()].map((i) => ({
          userId,
          chain: i.chain as never,
          walletAddress: i.address,
        })),
        // Уже отмеченное остаётся как было: время добавления
        // не переписывается на сегодняшнее.
        skipDuplicates: true,
      });

      return { merged: result.count, submitted: unique.size };
    } catch (e: any) {
      if (isSchemaMissing(e)) return reply.code(503).send(notReady);
      logger.warn({ code: e?.code }, 'избранное: слияние не удалось');
      throw e;
    }
  });
};

// ────────────────────────────── Показатели ──────────────────────────────────

export interface FavoritePnl {
  state: 'available' | 'pending' | 'incomplete_history';
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  closedPositions: number | null;
  incompleteTokens: number | null;
  computedAt: string | null;
}

/**
 * Результат по каждому кошельку из набора.
 *
 * Считается по каноническим сделкам — тем, у которых точное
 * количество токена взято из истории DEX. Лента отслеживания сюда
 * не идёт: там нет количества купленного, и любое число, выведенное
 * из неё, было бы догадкой.
 *
 * Один запрос на весь набор, а не по одному на кошелёк.
 */
async function pnlForWallets(
  wallets: Array<{ chain: ChainKey; address: string }>,
): Promise<Map<string, FavoritePnl>> {
  const out = new Map<string, FavoritePnl>();
  if (wallets.length === 0) return out;

  const rows = await prisma.walletEconomicTrade
    .findMany({
      where: {
        OR: wallets.map((w) => ({ chain: w.chain as never, walletAddress: w.address })),
      },
      orderBy: [{ tradedAt: 'asc' }, { key: 'asc' }],
    })
    .catch(() => []);

  const byWallet = new Map<string, CanonicalTrade[]>();

  for (const r of rows as any[]) {
    const key = `${r.chain}:${r.walletAddress}`;
    const list = byWallet.get(key) ?? [];

    list.push({
      key: r.key,
      chain: r.chain as ChainKey,
      wallet: r.walletAddress,
      tokenAddress: r.tokenAddress,
      tokenSymbol: r.tokenSymbol,
      side: r.side as 'BUY' | 'SELL',
      amount: r.amount.toString(),
      valueUsd: r.valueUsd.toString(),
      price: r.price.toString(),
      marketCapUsd: r.marketCapUsd?.toString() ?? null,
      providerPnlUsd: r.providerPnlUsd?.toString() ?? null,
      tradedAt: r.tradedAt.getTime(),
    });

    byWallet.set(key, list);
  }

  for (const w of wallets) {
    const key = `${w.chain}:${w.address}`;
    const trades = byWallet.get(key);

    if (!trades || trades.length === 0) {
      // Ни одной канонической сделки — пересчёт ещё не дошёл
      // до этого кошелька. Это не «ноль прибыли».
      out.set(key, {
        state: 'pending',
        realizedUsd: null,
        unrealizedUsd: null,
        closedPositions: null,
        incompleteTokens: null,
        computedAt: null,
      });
      continue;
    }

    const completeness = checkCompleteness(trades);
    const scorable = scorableTokens(completeness);
    const incompleteTokens = completeness.filter((c) => c.incompleteCostBasis).length;

    // В расчёт идут только токены с известной себестоимостью.
    // Продажа без покупки выглядела бы чистой прибылью, и кошелёк
    // с потерянной историей оказался бы тем успешнее, чем больше
    // её потеряно.
    const usable = trades.filter((t) => scorable.has(t.tokenAddress));

    if (usable.length === 0) {
      out.set(key, {
        state: 'incomplete_history',
        realizedUsd: null,
        unrealizedUsd: null,
        closedPositions: null,
        incompleteTokens,
        computedAt: null,
      });
      continue;
    }

    const positions = buildPositions(toEconomic(usable));
    const pnl = summarizePnl(positions);

    out.set(key, {
      state: 'available',
      realizedUsd: pnl.realizedPnlUsd,
      // Нереализованный результат требует свежей цены по каждому
      // открытому токену. Пока её нет — null, а не ноль: ноль
      // означал бы «открытые позиции в нуле», чего мы не измеряли.
      unrealizedUsd: null,
      closedPositions: pnl.closedCount,
      incompleteTokens,
      computedAt: new Date(Math.max(...usable.map((t) => t.tradedAt))).toISOString(),
    });
  }

  return out;
}

function toEconomic(trades: CanonicalTrade[]): EconomicTrade[] {
  return trades.map((t) => ({
    chain: t.chain,
    wallet: t.wallet,
    tokenAddress: t.tokenAddress,
    side: t.side,
    tokenAmount: Number(t.amount),
    amountUsd: Number(t.valueUsd),
    priceUsd: Number(t.price),
    timestamp: t.tradedAt,
    txHash: t.key,
    legs: 1,
    parsingConfidence: 1,
    source: 'okx_dex_history',
  }));
}
