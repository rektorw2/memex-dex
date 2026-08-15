import { Prisma as P, type OrderType } from '@prisma/client';
import {
  planAutoExit,
  findExitPreset,
  describePlanChange,
  EXIT_PRESETS,
} from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import * as balances from './balances.js';
import { reservesFunds } from './order-locking.js';

/**
 * План выхода из позиции: ровно один активный на позицию.
 *
 * Смена плана — это две операции подряд, и порядок между ними
 * существенен: сначала снимаются старые ордера и размораживаются
 * токены, только потом ставятся новые. Обратный порядок означал бы,
 * что на мгновение под ордерами заморожено вдвое больше, чем есть,
 * и постановка нового плана отклонилась бы по нехватке средств —
 * причём после того, как старый уже снят.
 *
 * Цели считаются от средней цены входа, а не от текущей: «взять 3×»
 * после роста означает трёхкратный рост от входа. Считать от текущей
 * цены значит менять смысл выбора в зависимости от момента нажатия.
 */

/** Типы ордеров, относящиеся к плану выхода. */
const EXIT_TYPES: OrderType[] = ['TAKE_PROFIT', 'STOP_LOSS'];

export interface ExitPlanState {
  tokenId: string;
  symbol: string;
  quantity: string;
  avgCostUsd: string;
  /** Ключ активного плана. null — плана нет. */
  activePreset: string | null;
  orders: Array<{
    id: string;
    type: string;
    triggerPriceUsd: string | null;
    quantity: string;
    multiple: number | null;
  }>;
}

function bad(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

/** Открытые ордера выхода по позиции. */
async function openExitOrders(userId: string, tokenId: string) {
  return prisma.order.findMany({
    where: {
      userId,
      tokenInId: tokenId,
      side: 'SELL',
      type: { in: EXIT_TYPES },
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
    },
    orderBy: { triggerPrice: 'asc' },
  });
}

/**
 * Определение активного плана по стоящим ордерам.
 *
 * Хранить ключ плана отдельным полем было бы проще, но он разошёлся бы
 * с действительностью: ордер может исполниться или быть снят вручную,
 * и запись в базе осталась бы врать. Ордера — источник истины.
 */
function detectPreset(
  orders: Array<{ type: string; triggerPrice: P.Decimal | null; amountIn: P.Decimal; filledIn: P.Decimal }>,
  avgCostUsd: P.Decimal,
): string | null {
  if (orders.length === 0) return null;
  if (avgCostUsd.lte(0)) return null;

  const targets = orders
    .filter((o) => o.type === 'TAKE_PROFIT' && o.triggerPrice)
    .map((o) => Number(o.triggerPrice!.div(avgCostUsd)));

  if (targets.length === 0) return null;

  for (const preset of EXIT_PRESETS) {
    if (preset.steps.length !== targets.length) continue;

    const expected = preset.steps.map((s) => s.multiple).sort((a, b) => a - b);
    const actual = [...targets].sort((a, b) => a - b);

    // Сравнение с допуском: цена входа усредняется при доборе позиции,
    // и кратность плывёт в третьем знаке.
    const same = expected.every((m, i) => Math.abs(m - actual[i]!) < 0.05);
    if (same) return preset.key;
  }

  return null;
}

export async function getExitPlan(userId: string, tokenId: string): Promise<ExitPlanState> {
  const [position, orders] = await Promise.all([
    prisma.position.findUnique({
      where: { userId_tokenId: { userId, tokenId } },
      include: { token: { select: { symbol: true } } },
    }),
    openExitOrders(userId, tokenId),
  ]);

  if (!position) bad('Позиция не найдена', 404);

  return {
    tokenId,
    symbol: position.token.symbol,
    quantity: position.quantity.toString(),
    avgCostUsd: position.avgCostUsd.toString(),
    activePreset: detectPreset(orders, position.avgCostUsd),
    orders: orders.map((o) => ({
      id: o.id,
      type: o.type,
      triggerPriceUsd: o.triggerPrice?.toString() ?? null,
      quantity: o.amountIn.minus(o.filledIn).toString(),
      multiple:
        o.triggerPrice && position.avgCostUsd.gt(0)
          ? Number(o.triggerPrice.div(position.avgCostUsd))
          : null,
    })),
  };
}

export interface SetPlanResult {
  preset: string;
  cancelled: number;
  created: number;
  orders: Array<{ id: string; type: string; triggerPriceUsd: string; quantity: string }>;
  warnings: string[];
}

export async function setExitPlan(
  userId: string,
  tokenId: string,
  presetKey: string,
): Promise<SetPlanResult> {
  const preset = findExitPreset(presetKey);
  if (!preset) bad('Неизвестный план выхода');

  const [position, existing] = await Promise.all([
    prisma.position.findUnique({
      where: { userId_tokenId: { userId, tokenId } },
      include: { token: { select: { symbol: true, chain: true } } },
    }),
    openExitOrders(userId, tokenId),
  ]);

  if (!position) bad('Позиция не найдена', 404);

  const current = detectPreset(existing, position.avgCostUsd);
  const change = describePlanChange(
    current,
    presetKey,
    existing.length,
    Number(position.quantity),
  );
  if (!change.allowed) bad(change.reason);

  // ─── Шаг 1: снять старое ───────────────────────────────────────────
  // Порядок важен. Пока старые ордера держат токены, новые поставить
  // нельзя: тех же токенов на второй план не хватит.
  let cancelled = 0;
  for (const order of existing) {
    try {
      await serializable(async (tx) => {
        const remaining = order.amountIn.minus(order.filledIn);
        if (remaining.gt(0)) {
          await balances.unlock(tx, {
            userId,
            tokenId: order.tokenInId,
            amount: remaining,
            refId: order.id,
          });
        }
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', rejectReason: 'Смена плана выхода' },
        });
      });
      cancelled++;
    } catch (e: any) {
      // Если хоть один ордер не снялся, дальше идти нельзя: часть
      // токенов осталась заморожена, и новый план встанет неполным.
      logger.error({ err: e?.message, orderId: order.id }, 'ордер выхода не снят');
      bad(
        'Не удалось снять действующий план целиком. Ничего не изменено, повторите попытку',
        409,
      );
    }
  }

  // ─── Шаг 2: поставить новое ────────────────────────────────────────
  if (preset.steps.length === 0) {
    logger.info({ userId, symbol: position.token.symbol, cancelled }, 'план выхода снят');
    return { preset: presetKey, cancelled, created: 0, orders: [], warnings: [] };
  }

  // Свободный остаток, а не вся позиция: часть токенов могла остаться
  // заблокированной под ручной лимиткой, которую план не трогает.
  const balance = await prisma.balance.findUnique({
    where: { userId_tokenId: { userId, tokenId } },
  });
  const available = balance?.available ?? new P.Decimal(0);

  const plan = planAutoExit({
    entryPriceUsd: position.avgCostUsd.toString(),
    quantity: available.toString(),
    steps: preset.steps,
    stopLossPct: preset.stopLossPct,
  });

  const warnings = [...plan.warnings];
  const created: SetPlanResult['orders'] = [];

  // Котировочный токен нужен до создания ордеров: он и есть tokenOut.
  // Раньше здесь ордер создавался с заведомо неверным значением
  // и правился следом — между двумя запросами он существовал
  // в состоянии «продать токен за него же».
  const quote = await prisma.token.findFirst({
    where: { chain: position.token.chain, isQuote: true },
    select: { id: true },
  });
  if (!quote) {
    bad(`В сети ${position.token.chain} не заведён котировочный токен`, 409);
  }

  const place = async (
    type: 'TAKE_PROFIT' | 'STOP_LOSS',
    quantity: string,
    triggerPriceUsd: string,
  ) => {
    const qty = new P.Decimal(quantity);
    if (qty.lte(0)) return;

    const order = await serializable(async (tx) => {
      const o = await tx.order.create({
        data: {
          userId,
          chain: position.token.chain,
          tokenInId: tokenId,
          tokenOutId: quote.id,
          side: 'SELL',
          type,
          source: 'MANUAL',
          status: 'OPEN',
          amountIn: qty,
          triggerPrice: new P.Decimal(triggerPriceUsd),
          slippageBps: 300,
        },
      });
      if (reservesFunds(type)) {
        await balances.lock(tx, { userId, tokenId, amount: qty.toString(), refId: o.id });
      }
      return o;
    });

    created.push({
      id: order.id,
      type,
      triggerPriceUsd,
      quantity: qty.toString(),
    });
  };

  for (const step of plan.steps) {
    await place('TAKE_PROFIT', step.quantity, step.triggerPriceUsd);
  }
  if (plan.stopLoss) {
    await place('STOP_LOSS', plan.stopLoss.quantity, plan.stopLoss.triggerPriceUsd);
  }

  logger.info(
    { userId, symbol: position.token.symbol, preset: presetKey, cancelled, created: created.length },
    'план выхода установлен',
  );

  return { preset: presetKey, cancelled, created: created.length, orders: created, warnings };
}
