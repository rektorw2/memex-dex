import { Prisma as P, type Order, type Token, type Prisma } from '@prisma/client';
import {
  applyBuy,
  applySell,
  emptyPosition,
  calcPerformanceFee,
  calcSwapFee,
  validateQuote,
  D,
  type PositionState,
} from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { getAdapter } from '../chains/index.js';
import { withPrivateKey, type EncryptedKey } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import * as balances from './balances.js';
import { logger } from '../lib/logger.js';

/**
 * Исполнение ордера — единственная точка, где деньги превращаются в позицию.
 *
 * Порядок строгий и не подлежит перестановке:
 *   1. Котировка у агрегатора
 *   2. Валидация (проскальзывание, price impact) — ДО списания средств
 *   3. Отправка транзакции в сеть
 *   4. Только после подтверждения — запись в БД одной транзакцией:
 *      баланс + ledger + позиция + комиссия + trade
 *
 * Порядок «списали → отправили» неприемлем: упавшая транзакция оставит
 * пользователя без денег и без токенов.
 */

export interface ExecutionResult {
  tradeId: string;
  amountIn: P.Decimal;
  amountOut: P.Decimal;
  priceUsd: P.Decimal;
  realizedPnlUsd: P.Decimal;
  performanceFeeUsd: P.Decimal;
  txSignature: string;
}

function toBaseUnits(amount: P.Decimal, decimals: number): bigint {
  return BigInt(amount.mul(new P.Decimal(10).pow(decimals)).toFixed(0, P.Decimal.ROUND_DOWN));
}

function fromBaseUnits(amount: bigint, decimals: number): P.Decimal {
  return new P.Decimal(amount.toString()).div(new P.Decimal(10).pow(decimals));
}

function toPositionState(row: {
  quantity: P.Decimal;
  avgCostUsd: P.Decimal;
  costBasisUsd: P.Decimal;
  realizedPnlUsd: P.Decimal;
  copiedQuantity: P.Decimal;
} | null): PositionState {
  if (!row) return emptyPosition();
  return {
    quantity: D(row.quantity.toString()),
    avgCostUsd: D(row.avgCostUsd.toString()),
    costBasisUsd: D(row.costBasisUsd.toString()),
    realizedPnlUsd: D(row.realizedPnlUsd.toString()),
    copiedQuantity: D(row.copiedQuantity.toString()),
  };
}

export async function executeOrder(orderId: string): Promise<ExecutionResult> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { tokenIn: true, tokenOut: true, user: true },
  });

  if (!['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(order.status)) {
    throw new Error(`Ордер в статусе ${order.status} не может быть исполнен`);
  }
  if (order.user.isFrozen) throw new Error('Аккаунт заморожен');

  const adapter = getAdapter(order.chain);
  const remainingIn = order.amountIn.minus(order.filledIn);
  if (remainingIn.lte(0)) throw new Error('Ордер уже исполнен полностью');

  // ── 1. Комиссия платформы за своп удерживается до маршрутизации ──────────
  const swapFeeIn = calcSwapFee(remainingIn.toString(), env.PLATFORM_SWAP_FEE_BPS);
  const routedIn = D(remainingIn.toString()).minus(swapFeeIn);

  // ── 2. Котировка ─────────────────────────────────────────────────────────
  const quote = await adapter.quote({
    chain: order.chain,
    tokenIn: order.tokenIn.address,
    tokenOut: order.tokenOut.address,
    amountIn: toBaseUnits(new P.Decimal(routedIn.toString()), order.tokenIn.decimals),
    slippageBps: order.slippageBps,
  });

  // ── 3. Валидация до списания средств ─────────────────────────────────────
  const expectedOut = order.limitPrice
    ? routedIn.div(D(order.limitPrice.toString()))
    : fromBaseUnits(quote.amountOut, order.tokenOut.decimals).toString();

  const verdict = validateQuote({
    expectedOut,
    quotedOut: fromBaseUnits(quote.amountOut, order.tokenOut.decimals).toString(),
    slippageBps: order.slippageBps,
    priceImpactBps: quote.priceImpactBps,
    maxPriceImpactBps: env.MAX_SLIPPAGE_BPS * 5,
  });

  if (!verdict.ok) {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'REJECTED', rejectReason: verdict.reason },
    });
    throw new Error(`Ордер отклонён: ${verdict.reason}`);
  }

  // ── 4. Отправка в сеть ───────────────────────────────────────────────────
  const wallet = await prisma.wallet.findFirst({
    where: { userId: order.userId, chain: order.chain, kind: 'HOT_TRADING', isActive: true },
  });
  if (!wallet) throw new Error(`Нет активного кошелька для сети ${order.chain}`);

  const exec = await adapter.execute({
    quote,
    fromAddress: wallet.address,
    sign: async (payload) => {
      if (!wallet.encryptedKey) throw new Error('У кошелька нет ключа подписи');
      const encrypted: EncryptedKey = {
        ciphertext: Buffer.from(wallet.encryptedKey),
        nonce: Buffer.from(wallet.keyNonce!),
        authTag: Buffer.from(wallet.keyAuthTag!),
        wrappedDek: Buffer.from(wallet.wrappedDek!),
        kmsKeyId: wallet.kmsKeyId ?? '',
      };
      return withPrivateKey(encrypted, async (key) => signPayload(order.chain, payload, key));
    },
  });

  if (exec.status === 'FAILED') {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'REJECTED', rejectReason: exec.error ?? 'транзакция не прошла' },
    });
    throw new Error(`Транзакция не прошла: ${exec.error}`);
  }

  // ── 5. Учёт: одна серializable-транзакция на всё ─────────────────────────
  const amountInDec = fromBaseUnits(exec.amountIn, order.tokenIn.decimals);
  const amountOutDec = fromBaseUnits(exec.amountOut, order.tokenOut.decimals);

  return settleTrade({ order, quote, exec, amountInDec, amountOutDec, swapFeeIn: new P.Decimal(swapFeeIn.toString()) });
}

/** Запись результата сделки в учёт. Вынесено отдельно ради тестируемости. */
async function settleTrade(args: {
  order: Order & { tokenIn: Token; tokenOut: Token };
  quote: { aggregator: string; route: unknown; priceImpactBps: number };
  exec: { txSignature: string; networkFeeUsd: number; blockNumber?: bigint };
  amountInDec: P.Decimal;
  amountOutDec: P.Decimal;
  swapFeeIn: P.Decimal;
}): Promise<ExecutionResult> {
  const { order, quote, exec, amountInDec, amountOutDec, swapFeeIn } = args;
  const isBuy = order.side === 'BUY';

  // Торгуемый токен — тот, что не является валютой котировки.
  const tradedToken = isBuy ? order.tokenOut : order.tokenIn;
  const quoteToken = isBuy ? order.tokenIn : order.tokenOut;

  const quotePriceUsd = new P.Decimal(quoteToken.priceUsd?.toString() ?? '1');
  const tradedQty = isBuy ? amountOutDec : amountInDec;
  const quoteAmount = isBuy ? amountInDec : amountOutDec;
  const valueUsd = quoteAmount.mul(quotePriceUsd);
  const tradedPriceUsd = tradedQty.gt(0) ? valueUsd.div(tradedQty) : new P.Decimal(0);

  const networkFeeUsd = new P.Decimal(exec.networkFeeUsd);
  const swapFeeUsd = swapFeeIn.mul(isBuy ? quotePriceUsd : new P.Decimal(tradedPriceUsd));

  return serializable(async (tx) => {
    // Списываем отданное
    await balances.debit(tx, {
      userId: order.userId,
      tokenId: order.tokenInId,
      amount: amountInDec.plus(swapFeeIn),
      type: 'TRADE_OUT',
      fromLocked: order.type !== 'MARKET',
      refType: 'Order',
      refId: order.id,
    });

    const posRow = await tx.position.findUnique({
      where: { userId_tokenId: { userId: order.userId, tokenId: tradedToken.id } },
    });
    const posState = toPositionState(posRow);

    let realizedPnlUsd = new P.Decimal(0);
    let performanceFeeUsd = new P.Decimal(0);
    let feeInQuoteToken = new P.Decimal(0);
    let newState: PositionState;

    if (isBuy) {
      newState = applyBuy(posState, {
        quantity: tradedQty.toString(),
        priceUsd: tradedPriceUsd.toString(),
        feesUsd: networkFeeUsd.plus(swapFeeUsd).toString(),
        isCopied: order.source === 'COPY_TRADE',
      });
    } else {
      const sell = applySell(posState, {
        quantity: tradedQty.toString(),
        priceUsd: tradedPriceUsd.toString(),
        feesUsd: networkFeeUsd.plus(swapFeeUsd).toString(),
      });
      newState = sell.position;
      realizedPnlUsd = new P.Decimal(sell.realizedPnlUsd.toString());

      // ── Performance fee 10% ────────────────────────────────────────────
      // Берётся только с прибыли копируемой доли и только при выходе.
      const sub = await tx.copySubscription.findFirst({
        where: { followerId: order.userId, status: { in: ['ACTIVE', 'PAUSED'] } },
        orderBy: { createdAt: 'desc' },
      });

      const feeBps = sub?.performanceFeeBps ?? env.PERFORMANCE_FEE_BPS;
      const fee = calcPerformanceFee({
        realizedPnlUsd: sell.realizedPnlUsd,
        copiedShare: sell.copiedShare,
        feeBps,
        leaderShareBps: 7000, // 70% лидеру, 30% платформе
      });

      performanceFeeUsd = new P.Decimal(fee.feeUsd.toString());

      if (performanceFeeUsd.gt(0)) {
        const outPriceUsd = new P.Decimal(
          (isBuy ? quoteToken : order.tokenOut).priceUsd?.toString() ?? '1',
        );
        feeInQuoteToken = outPriceUsd.gt(0)
          ? performanceFeeUsd.div(outPriceUsd)
          : new P.Decimal(0);

        await tx.feeLedger.create({
          data: {
            userId: order.userId,
            type: 'PERFORMANCE',
            status: 'ACCRUED',
            basisPnlUsd: new P.Decimal(fee.basisPnlUsd.toString()),
            feeBps,
            amountUsd: performanceFeeUsd,
            amountToken: feeInQuoteToken,
            feeTokenId: order.tokenOutId,
            subscriptionId: sub?.id ?? null,
            leaderId: sub?.leaderId ?? null,
            leaderShareUsd: new P.Decimal(fee.leaderShareUsd.toString()),
            platformShareUsd: new P.Decimal(fee.platformShareUsd.toString()),
            // Снимок расчёта — чтобы через полгода можно было объяснить
            // пользователю, откуда взялась именно эта сумма.
            calcSnapshot: {
              avgCostUsd: posState.avgCostUsd.toString(),
              exitPriceUsd: tradedPriceUsd.toString(),
              quantitySold: tradedQty.toString(),
              copiedShare: sell.copiedShare.toString(),
              grossPnlUsd: sell.realizedPnlUsd.toString(),
              networkFeeUsd: networkFeeUsd.toString(),
              reason: fee.reason,
            },
          },
        });

        if (sub) {
          await tx.copySubscription.update({
            where: { id: sub.id },
            data: {
              feesPaidUsd: { increment: performanceFeeUsd },
              grossPnlUsd: { increment: realizedPnlUsd },
            },
          });
        }
      }
    }

    // Зачисляем полученное за вычетом performance fee
    const creditAmount = amountOutDec.minus(feeInQuoteToken);
    if (creditAmount.gt(0)) {
      await balances.credit(tx, {
        userId: order.userId,
        tokenId: order.tokenOutId,
        amount: creditAmount,
        type: 'TRADE_IN',
        refType: 'Order',
        refId: order.id,
      });
    }
    if (feeInQuoteToken.gt(0)) {
      await tx.ledgerEntry.create({
        data: {
          userId: order.userId,
          tokenId: order.tokenOutId,
          type: 'FEE_PERFORMANCE',
          amount: feeInQuoteToken.negated(),
          refType: 'Order',
          refId: order.id,
          memo: `Performance fee ${performanceFeeUsd.toFixed(2)} USD`,
        },
      });
    }

    // Обновляем позицию
    await tx.position.upsert({
      where: { userId_tokenId: { userId: order.userId, tokenId: tradedToken.id } },
      create: {
        userId: order.userId,
        tokenId: tradedToken.id,
        quantity: newState.quantity.toString(),
        avgCostUsd: newState.avgCostUsd.toString(),
        costBasisUsd: newState.costBasisUsd.toString(),
        realizedPnlUsd: newState.realizedPnlUsd.toString(),
        copiedQuantity: newState.copiedQuantity.toString(),
        feesPaidUsd: networkFeeUsd.plus(performanceFeeUsd).toString(),
      },
      update: {
        quantity: newState.quantity.toString(),
        avgCostUsd: newState.avgCostUsd.toString(),
        costBasisUsd: newState.costBasisUsd.toString(),
        realizedPnlUsd: newState.realizedPnlUsd.toString(),
        copiedQuantity: newState.copiedQuantity.toString(),
        feesPaidUsd: { increment: networkFeeUsd.plus(performanceFeeUsd) },
        closedAt: newState.quantity.lte(0) ? new Date() : null,
      },
    });

    const trade = await tx.trade.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        chain: order.chain,
        amountIn: amountInDec,
        amountOut: amountOutDec,
        price: amountInDec.gt(0) ? amountOutDec.div(amountInDec) : new P.Decimal(0),
        priceUsd: tradedPriceUsd,
        valueUsd,
        route: quote.route as Prisma.InputJsonValue,
        aggregator: quote.aggregator,
        txSignature: exec.txSignature,
        blockNumber: exec.blockNumber ?? null,
        networkFeeUsd,
        slippageBps: order.slippageBps,
        priceImpactBps: quote.priceImpactBps,
        swapFeeUsd,
        performanceFeeUsd,
        realizedPnlUsd,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });

    const newFilledIn = order.filledIn.plus(amountInDec).plus(swapFeeIn);
    await tx.order.update({
      where: { id: order.id },
      data: {
        filledIn: newFilledIn,
        filledOut: { increment: amountOutDec },
        status: newFilledIn.gte(order.amountIn.mul('0.999')) ? 'FILLED' : 'PARTIALLY_FILLED',
      },
    });

    logger.info(
      {
        orderId: order.id,
        side: order.side,
        valueUsd: valueUsd.toFixed(2),
        pnl: realizedPnlUsd.toFixed(2),
        fee: performanceFeeUsd.toFixed(2),
      },
      'сделка исполнена',
    );

    return {
      tradeId: trade.id,
      amountIn: amountInDec,
      amountOut: amountOutDec,
      priceUsd: tradedPriceUsd,
      realizedPnlUsd,
      performanceFeeUsd,
      txSignature: exec.txSignature,
    };
  });
}

/**
 * Подпись транзакции приватным ключом.
 * TODO(prod): Solana — nacl.sign.detached через @solana/web3.js;
 *             EVM — viem/accounts signTransaction.
 * Ключ доступен только внутри этого вызова и затирается сразу после.
 */
async function signPayload(chain: string, payload: Uint8Array, _key: Buffer): Promise<Uint8Array> {
  if (env.EXECUTION_MODE === 'paper') return payload;
  throw new Error(`signPayload для ${chain} не реализован — подключите библиотеку подписи`);
}
