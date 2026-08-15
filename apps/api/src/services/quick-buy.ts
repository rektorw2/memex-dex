import { Prisma as P, type Chain } from '@prisma/client';
import {
  planAutoExit,
  parseTokenRefs,
  candidateChains,
  assessToken,
  type ExitStep,
} from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { supportedChains } from '../chains/index.js';
import { fetchPoolForToken } from '../services/market-data.js';
import { placeOrderForUser } from './order-intake.js';
import * as balances from './balances.js';
import { reservesFunds } from './order-locking.js';

/**
 * Покупка по адресу с автоматической постановкой выхода.
 *
 * Один вызов делает три вещи: находит токен по вставленному адресу,
 * покупает на заданную сумму и сразу выставляет тейк-профит на купленное
 * количество.
 *
 * Порядок именно такой и не может быть другим: количество токена, которое
 * нужно продать, известно только после исполнения покупки. Ставить выход
 * заранее, оценив количество по текущей цене, значит промахнуться ровно
 * на величину проскальзывания — а на тонком пуле это единицы процентов.
 *
 * Тейк ставится сразу после покупки, а не откладывается на потом, потому
 * что в момент роста решение принимается хуже всего. Заранее заданный
 * выход — единственное, что отличает план от надежды.
 */

export interface QuickBuyInput {
  /** Адрес токена или ссылка на него. */
  addressOrLink: string;
  /** Сумма покупки в котировочной валюте. */
  amountIn: string;
  /** Идентификатор котировочного токена (USDC и т.п.). */
  quoteTokenId: string;
  /** Сеть. Если не задана — определяется по адресу. */
  chain?: Chain | null;
  steps?: ExitStep[];
  stopLossPct?: number | null;
  slippageBps?: number;
}

export interface QuickBuyResult {
  token: { id: string; symbol: string; chain: string; address: string };
  buy: { orderId: string; status: string; quantity: string; entryPriceUsd: string };
  exits: Array<{ orderId: string; multiple: number; triggerPriceUsd: string; quantity: string }>;
  stopLossOrderId: string | null;
  warnings: string[];
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Поиск или заведение токена по вставленному адресу.
 *
 * Адрес EVM живёт сразу в нескольких сетях, поэтому при отсутствии явного
 * указания перебираются кандидаты: где найдётся пул, та сеть и верна.
 */
async function resolveToken(input: QuickBuyInput) {
  const refs = parseTokenRefs(input.addressOrLink, 1);
  if (refs.length === 0) bad('В строке не найден адрес токена');

  const ref = refs[0]!;
  const supported = supportedChains() as unknown as string[];
  const chains = input.chain ? [input.chain as string] : candidateChains(ref, supported);

  if (chains.length === 0) bad('Сеть не поддерживается');

  // Сначала смотрим в своей базе: токен мог быть заведён радаром
  // или прошлой покупкой, и лишний запрос к источнику ни к чему.
  const known = await prisma.token.findFirst({
    where: { address: ref.address, chain: { in: chains as Chain[] } },
  });
  if (known) return known;

  for (const chain of chains) {
    const pool = await fetchPoolForToken(chain as Chain, ref.address);
    if (!pool) continue;

    const ageHours = pool.poolCreatedAt
      ? (Date.now() - pool.poolCreatedAt.getTime()) / 3_600_000
      : null;
    const risk = assessToken({
      liquidityUsd: pool.liquidityUsd,
      volume24hUsd: pool.volume24hUsd,
      ageHours,
    });

    return prisma.token.create({
      data: {
        chain: chain as Chain,
        address: ref.address,
        symbol: pool.symbol,
        name: pool.name,
        decimals: pool.decimals,
        logoUrl: pool.logoUrl ?? null,
        poolAddress: pool.poolAddress,
        source: 'quick-buy',
        priceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : null,
        liquidityUsd: pool.liquidityUsd != null ? new P.Decimal(pool.liquidityUsd) : null,
        volume24hUsd: pool.volume24hUsd != null ? new P.Decimal(pool.volume24hUsd) : null,
        fdvUsd: pool.fdvUsd != null ? new P.Decimal(pool.fdvUsd) : null,
        riskScore: risk.score,
        metricsUpdated: new Date(),
      },
    });
  }

  bad(
    chains.length > 1
      ? `Пул не найден ни в одной из сетей: ${chains.join(', ')}`
      : `Пул не найден в сети ${chains[0]}`,
  );
}

export async function quickBuy(userId: string, input: QuickBuyInput): Promise<QuickBuyResult> {
  const token = await resolveToken(input);

  if (token.isHoneypot) {
    bad('Токен помечен как honeypot — покупка заблокирована');
  }

  const quote = await prisma.token.findUnique({ where: { id: input.quoteTokenId } });
  if (!quote) bad('Котировочный токен не найден');
  if (quote.chain !== token.chain) {
    bad(`Котировочный токен из сети ${quote.chain}, а токен из ${token.chain}`);
  }

  // ─── Покупка ──────────────────────────────────────────────────────────
  const buy = await placeOrderForUser(userId, {
    chain: token.chain,
    tokenInId: quote.id,
    tokenOutId: token.id,
    side: 'BUY',
    type: 'MARKET',
    amountIn: input.amountIn,
    slippageBps: input.slippageBps ?? 300,
    source: 'MANUAL',
  });

  const filled = await prisma.order.findUniqueOrThrow({
    where: { id: buy.order.id },
    select: { status: true, filledIn: true, filledOut: true },
  });

  const warnings: string[] = [];

  if (filled.status !== 'FILLED' && filled.status !== 'PARTIALLY_FILLED') {
    // Покупка не прошла — выход ставить не от чего.
    return {
      token: { id: token.id, symbol: token.symbol, chain: token.chain, address: token.address },
      buy: {
        orderId: buy.order.id,
        status: filled.status,
        quantity: '0',
        entryPriceUsd: '0',
      },
      exits: [],
      stopLossOrderId: null,
      warnings: ['Покупка не исполнена, автовыход не поставлен'],
    };
  }

  const quantity = filled.filledOut;
  const quotePriceUsd = quote.priceUsd ?? new P.Decimal(1);

  // Фактическая цена входа, а не котировка на момент нажатия кнопки:
  // из-за проскальзывания они расходятся, и считать цели от котировки
  // значит ставить их не там, где рассчитывал человек.
  const entryPriceUsd = quantity.gt(0)
    ? filled.filledIn.times(quotePriceUsd).div(quantity)
    : new P.Decimal(0);

  // ─── План выхода ──────────────────────────────────────────────────────
  const plan = planAutoExit({
    entryPriceUsd: entryPriceUsd.toString(),
    quantity: quantity.toString(),
    steps: input.steps,
    stopLossPct: input.stopLossPct ?? null,
  });

  warnings.push(...plan.warnings);

  const exits: QuickBuyResult['exits'] = [];
  let stopLossOrderId: string | null = null;

  for (const step of plan.steps) {
    try {
      const order = await createExitOrder(userId, token, quote, {
        type: 'TAKE_PROFIT',
        quantity: step.quantity,
        triggerPriceUsd: step.triggerPriceUsd,
        slippageBps: input.slippageBps ?? 300,
      });
      exits.push({
        orderId: order.id,
        multiple: step.multiple,
        triggerPriceUsd: step.triggerPriceUsd,
        quantity: step.quantity,
      });
    } catch (e: any) {
      // Неудача с выходом не отменяет покупку: она уже исполнена.
      // Но молчать нельзя — позиция осталась без плана выхода.
      warnings.push(`Цель ${step.multiple}× не поставлена: ${e?.message ?? 'ошибка'}`);
      logger.warn({ err: e?.message, tokenId: token.id }, 'тейк не поставлен');
    }
  }

  if (plan.stopLoss) {
    try {
      const order = await createExitOrder(userId, token, quote, {
        type: 'STOP_LOSS',
        quantity: plan.stopLoss.quantity,
        triggerPriceUsd: plan.stopLoss.triggerPriceUsd,
        slippageBps: input.slippageBps ?? 300,
      });
      stopLossOrderId = order.id;
    } catch (e: any) {
      warnings.push(`Стоп-лосс не поставлен: ${e?.message ?? 'ошибка'}`);
    }
  }

  if (exits.length === 0 && plan.steps.length > 0) {
    warnings.push('Позиция открыта, но ни одна цель не поставлена — закройте её вручную');
  }

  logger.info(
    { userId, symbol: token.symbol, exits: exits.length, entryPriceUsd: entryPriceUsd.toString() },
    'быстрая покупка с автовыходом',
  );

  return {
    token: { id: token.id, symbol: token.symbol, chain: token.chain, address: token.address },
    buy: {
      orderId: buy.order.id,
      status: filled.status,
      quantity: quantity.toString(),
      entryPriceUsd: entryPriceUsd.toString(),
    },
    exits,
    stopLossOrderId,
    warnings,
  };
}

/**
 * Ордер на выход из позиции.
 *
 * Создаётся напрямую, а не через placeOrderForUser: тот резервирует
 * средства по своей формуле для входящего токена, а здесь продаётся
 * уже имеющийся токен, и заблокировать нужно ровно то количество,
 * которое посчитал план.
 */
async function createExitOrder(
  userId: string,
  token: { id: string; chain: Chain },
  quote: { id: string },
  opts: {
    type: 'TAKE_PROFIT' | 'STOP_LOSS';
    quantity: string;
    triggerPriceUsd: string;
    slippageBps: number;
  },
) {
  const qty = new P.Decimal(opts.quantity);
  if (qty.lte(0)) throw new Error('нулевое количество');

  return serializable(async (tx) => {
    const order = await tx.order.create({
      data: {
        userId,
        chain: token.chain,
        // Выход — это продажа токена за котировочный.
        tokenInId: token.id,
        tokenOutId: quote.id,
        side: 'SELL',
        type: opts.type,
        source: 'MANUAL',
        status: 'OPEN',
        amountIn: qty,
        // Цена срабатывания — в долларах за токен: так её сравнивает
        // воркер отложенных ордеров.
        triggerPrice: new P.Decimal(opts.triggerPriceUsd),
        slippageBps: opts.slippageBps,
      },
    });

    // Стоп не резервирует: он покрывает ту же позицию, что и цель,
    // и бронь под оба означала бы двести процентов позиции.
    if (reservesFunds(opts.type)) {
      await balances.lock(tx, {
        userId,
        tokenId: token.id,
        amount: qty.toString(),
        refId: order.id,
      });
    }

    return order;
  });
}
