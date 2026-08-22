import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SOLANA_DEPOSIT_ASSETS, TRIAL_DURATION_HOURS } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';

/**
 * Пополнение торгового кошелька.
 *
 * Здесь нет ни одного места, где деньги действительно принимаются.
 * Это сознательно: приём реальных средств заблокирован до тех пор,
 * пока не решён вопрос подписи транзакций (см. `docs/custody.md`).
 * Пока приватные ключи пользователей лежат на сервере, зашифрованные
 * ключом, который тоже управляется сервером, любое пополнение
 * означает, что платформа держит чужие деньги под единственным
 * ключом. Обойти это, заведя ещё один горячий кошелёк, нельзя —
 * это та же проблема под другим именем.
 *
 * Поэтому маршруты ниже отдают адрес, список активов, комиссии
 * и состояния — всё, из чего собирается интерфейс, — и ничего
 * не зачисляют. Признак `FUNDING_ENABLED` по умолчанию выключен,
 * и включать его до решения по подписи нельзя.
 *
 * Оплата подписки сюда не относится вовсе. Это другой денежный
 * поток: за подписку платят платформе, пополнение остаётся деньгами
 * пользователя и в любой момент выводится обратно.
 */
export const fundingRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Способы пополнения и их состояние.
   *
   * Отдаёт правду о готовности каждого способа. Показать в интерфейсе
   * активную кнопку Apple Pay, за которой ничего нет, — худшее
   * из возможных решений: человек нажмёт, спишутся деньги,
   * и объяснять придётся уже постфактум.
   */
  app.get('/funding/methods', { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const ent = await entitlementOfRequest(req);

    return {
      enabled: env.FUNDING_ENABLED,
      trialHours: TRIAL_DURATION_HOURS,
      canDeposit: ent.capabilities.has('WALLET_DEPOSIT'),
      methods: [
        {
          id: 'solana_transfer',
          title: 'Перевод в сети Solana',
          /** Готов к работе, как только снимется блок по подписи. */
          status: env.FUNDING_ENABLED ? 'available' : 'disabled',
          reason: env.FUNDING_ENABLED ? null : 'CUSTODY_REVIEW_PENDING',
          network: 'solana',
          assets: SOLANA_DEPOSIT_ASSETS.map((a) => ({
            symbol: a.symbol,
            mint: a.mint,
            decimals: a.decimals,
            minAmount: a.minAmount,
            minConfirmations: a.minConfirmations,
          })),
        },
        {
          id: 'apple_pay',
          title: 'Apple Pay',
          // Не «скоро будет», а «нужен посредник». У OKX нет
          // публичного API покупки за фиат: раздел Payments — это
          // расчёты между агентами в криптовалюте, а не ввод денег
          // с карты. Собственный приём карт означал бы лицензию,
          // KYC и хранение платёжных данных.
          status: 'unavailable',
          reason: 'ONRAMP_PROVIDER_NOT_SELECTED',
          network: 'solana',
          assets: [],
        },
        {
          id: 'google_pay',
          title: 'Google Pay',
          status: 'unavailable',
          reason: 'ONRAMP_PROVIDER_NOT_SELECTED',
          network: 'solana',
          assets: [],
        },
      ],
    };
  });

  /**
   * Адрес для пополнения в сети Solana.
   *
   * Отдаётся вместе с сетью и списком активов, а не отдельной
   * строкой. Адрес без указания сети — самый частый способ потерять
   * перевод: тот же набор символов человек отправляет из другого
   * кошелька в другой сети, и деньги исчезают без возможности вернуть.
   */
  app.get('/funding/solana/address', { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'WALLET_DEPOSIT', reply)) return reply;

    const wallet = await prisma.wallet.findFirst({
      where: { userId: req.user.sub, chain: 'SOLANA', isActive: true },
      select: { address: true },
    });

    if (!wallet) {
      return reply.code(404).send({ error: 'Кошелёк Solana не создан', code: 'NO_WALLET' });
    }

    return {
      network: 'solana',
      address: wallet.address,
      /** Строка для QR-кода. Тот же адрес, без схемы и параметров. */
      qrPayload: wallet.address,
      assets: SOLANA_DEPOSIT_ASSETS.map((a) => ({
        symbol: a.symbol,
        mint: a.mint,
        minAmount: a.minAmount,
        minConfirmations: a.minConfirmations,
      })),
      warnings: [
        'Отправляйте только в сети Solana. Переводы из других сетей будут потеряны.',
        'Отправляйте только SOL или USDC-SPL. Другие токены не зачисляются.',
      ],
      /** Пока выключено, адрес показывается только для проверки. */
      creditingEnabled: env.FUNDING_ENABLED,
    };
  });

  /**
   * История пополнений.
   *
   * Показывает и незачисленные: перевод, застрявший в ожидании
   * подтверждений, беспокоит человека сильнее, чем зачисленный,
   * и не показать его значит оставить наедине с догадками.
   */
  app.get('/funding/deposits', { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const q = z.object({ limit: z.coerce.number().max(100).default(50) }).parse(req.query);

    const rows = await prisma.deposit.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });

    return {
      deposits: rows.map((d) => ({
        id: d.id,
        chain: d.chain,
        amount: d.amount.toString(),
        // Подпись показывается целиком: по ней человек находит перевод
        // в обозревателе и убеждается сам, а не верит нам на слово.
        txSignature: d.txSignature,
        confirmations: d.confirmations,
        state: d.isCredited ? 'credited' : 'pending',
        createdAt: d.createdAt,
        creditedAt: d.creditedAt,
      })),
    };
  });
};
