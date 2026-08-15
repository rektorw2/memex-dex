import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { quoteWithdrawal } from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import * as balances from '../services/balances.js';
import { createWallet, importWallet, listWallets } from '../services/wallet.js';

const chainSchema = z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']);

export const walletRoutes: FastifyPluginAsync = async (app) => {
  app.get('/wallets', { preHandler: [app.authenticate] }, async (req) => {
    return { wallets: await listWallets(req.user.sub) };
  });

  /** Создание кошелька: ключ генерируется на сервере и сразу шифруется. */
  app.post('/wallets', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { chain } = z.object({ chain: chainSchema }).parse(req.body);

    const existing = await prisma.wallet.findFirst({
      where: { userId: req.user.sub, chain, isActive: true },
    });
    if (existing) {
      return reply.code(409).send({
        error: `Кошелёк для сети ${chain} уже создан: ${existing.address}`,
      });
    }

    try {
      const wallet = await createWallet(req.user.sub, chain);
      await prisma.auditLog.create({
        data: {
          actorId: req.user.sub, action: 'wallet.create', entity: 'Wallet',
          entityId: wallet.id, after: { chain, address: wallet.address } as never, ip: req.ip,
        },
      });
      return reply.code(201).send({ wallet });
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'Не удалось создать кошелёк' });
    }
  });

  /**
   * Импорт существующего ключа.
   *
   * Ограничения намеренные: обязательное подтверждение и запрет на
   * повторный импорт того же адреса. Приватный ключ не логируется,
   * не возвращается в ответе и не хранится в открытом виде.
   */
  app.post('/wallets/import', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        chain: chainSchema,
        privateKey: z.string().min(32).max(400),
        /** Явное согласие: пользователь понимает, что отдаёт ключ платформе. */
        acknowledgeCustody: z.literal(true),
      })
      .parse(req.body);

    try {
      const wallet = await importWallet(req.user.sub, body.chain, body.privateKey);

      await prisma.auditLog.create({
        data: {
          actorId: req.user.sub, action: 'wallet.import', entity: 'Wallet',
          entityId: wallet.id,
          // В журнал попадает только адрес — публичная величина.
          after: { chain: body.chain, address: wallet.address } as never,
          ip: req.ip,
        },
      });

      return reply.code(201).send({
        wallet,
        warning:
          'Импортированный ключ теперь хранится на сервере. Если этот кошелёк ' +
          'использовался где-то ещё, переведите средства на новый адрес: ' +
          'ключ, побывавший в двух местах, считается скомпрометированным.',
      });
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'Не удалось импортировать ключ' });
    }
  });

  app.delete('/wallets/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const wallet = await prisma.wallet.findUnique({ where: { id } });
    if (!wallet || wallet.userId !== req.user.sub) {
      return reply.code(404).send({ error: 'Кошелёк не найден' });
    }

    // Запись не удаляется: на неё ссылаются депозиты и история сделок.
    // Деактивация исключает кошелёк из работы, сохраняя прослеживаемость.
    await prisma.wallet.update({ where: { id }, data: { isActive: false } });
    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub, action: 'wallet.deactivate', entity: 'Wallet',
        entityId: id, ip: req.ip,
      },
    });

    return { ok: true, note: 'Кошелёк отключён. История операций сохранена.' };
  });

  // ─────────────────────────── Активы и вывод ──────────────────────────

  /**
   * Активы пользователя с общей стоимостью.
   *
   * Считается по балансам, а не по позициям: позиция — это то, что
   * куплено под учёт средней цены, а на балансе может лежать и то,
   * что пришло депозитом. Показывать в кошельке позиции значило бы
   * скрывать часть средств.
   */
  app.get('/wallets/assets', { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;

    const [balances, deposits, pending] = await Promise.all([
      prisma.balance.findMany({
        where: { userId },
        include: { token: true },
      }),
      prisma.wallet.findMany({
        where: { userId, kind: 'HOT_DEPOSIT', isActive: true },
        select: { id: true, chain: true, address: true },
      }),
      prisma.withdrawal.findMany({
        where: { userId, status: { in: ['REQUESTED', 'AWAITING_2FA', 'MANUAL_REVIEW', 'APPROVED', 'BROADCAST'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    let totalUsd = new P.Decimal(0);
    let lockedUsd = new P.Decimal(0);
    let unpriced = 0;

    const assets = balances
      .filter((b) => b.available.plus(b.locked).gt(0))
      .map((b) => {
        const price = b.token.priceUsd;
        const total = b.available.plus(b.locked);

        if (price && price.gt(0)) {
          totalUsd = totalUsd.plus(total.times(price));
          lockedUsd = lockedUsd.plus(b.locked.times(price));
        } else {
          unpriced++;
        }

        return {
          tokenId: b.tokenId,
          symbol: b.token.symbol,
          name: b.token.name,
          chain: b.token.chain,
          address: b.token.address,
          logoUrl: b.token.logoUrl,
          decimals: b.token.decimals,
          isQuote: b.token.isQuote,
          available: b.available.toString(),
          locked: b.locked.toString(),
          priceUsd: price?.toString() ?? null,
          valueUsd: price && price.gt(0) ? total.times(price).toFixed(2) : null,
        };
      })
      .sort((a, b) => Number(b.valueUsd ?? 0) - Number(a.valueUsd ?? 0));

    return {
      totalUsd: totalUsd.toFixed(2),
      // Заблокированное показываем отдельно: это средства под открытыми
      // ордерами, и вывести их нельзя, пока ордер не снят.
      lockedUsd: lockedUsd.toFixed(2),
      availableUsd: totalUsd.minus(lockedUsd).toFixed(2),
      // Сколько активов осталось без цены — иначе итог молча занижен,
      // и расхождение выглядит как ошибка в расчётах.
      unpricedAssets: unpriced,
      withdrawalFeeBps: env.WITHDRAWAL_FEE_BPS,
      assets,
      depositAddresses: deposits,
      pendingWithdrawals: pending.map((w) => ({
        id: w.id,
        chain: w.chain,
        amount: w.amount.toString(),
        feeAmount: w.feeAmount.toString(),
        toAddress: w.toAddress,
        status: w.status,
        createdAt: w.createdAt,
      })),
    };
  });

  /**
   * Предварительный расчёт вывода.
   *
   * Отдельный запрос, а не расчёт на клиенте: ставка комиссии живёт
   * в настройках сервера, и дублировать её в интерфейсе значит однажды
   * показать одно, а списать другое.
   */
  app.post('/wallets/withdraw/quote', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        tokenId: z.string(),
        amount: z.string(),
        mode: z.enum(['GROSS', 'NET']).default('GROSS'),
      })
      .parse(req.body);

    const balance = await prisma.balance.findUnique({
      where: { userId_tokenId: { userId: req.user.sub, tokenId: body.tokenId } },
      include: { token: true },
    });

    if (!balance) return reply.code(404).send({ error: 'Актив не найден' });

    const quote = quoteWithdrawal({
      amount: body.amount,
      available: balance.available.toString(),
      feeBps: env.WITHDRAWAL_FEE_BPS,
      priceUsd: balance.token.priceUsd?.toString() ?? null,
      mode: body.mode,
    });

    return { ...quote, symbol: balance.token.symbol };
  });

  /**
   * Заявка на вывод.
   *
   * Создаёт заявку и замораживает средства — но не отправляет транзакцию.
   * Отправка требует подписи ключом, а этот путь в системе сознательно
   * не реализован: пока он не готов и не проверен, автоматический вывод
   * означал бы риск потери средств пользователей.
   */
  app.post('/wallets/withdraw', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        tokenId: z.string(),
        amount: z.string(),
        toAddress: z.string().min(20).max(120),
        mode: z.enum(['GROSS', 'NET']).default('GROSS'),
      })
      .parse(req.body);

    const userId = req.user.sub;

    const [balance, user] = await Promise.all([
      prisma.balance.findUnique({
        where: { userId_tokenId: { userId, tokenId: body.tokenId } },
        include: { token: true },
      }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { isFrozen: true } }),
    ]);

    if (!balance) return reply.code(404).send({ error: 'Актив не найден' });
    if (user.isFrozen) return reply.code(403).send({ error: 'Аккаунт заморожен' });

    const quote = quoteWithdrawal({
      amount: body.amount,
      available: balance.available.toString(),
      feeBps: env.WITHDRAWAL_FEE_BPS,
      priceUsd: balance.token.priceUsd?.toString() ?? null,
      mode: body.mode,
    });

    if (quote.error) return reply.code(400).send({ error: quote.error });

    const withdrawal = await serializable(async (tx) => {
      const created = await tx.withdrawal.create({
        data: {
          userId,
          tokenId: body.tokenId,
          chain: balance.token.chain,
          // amount — списываемая сумма целиком, комиссия отдельным полем.
          // Хранить здесь сумму «к отправке» значило бы потерять след
          // удержания в самой записи о выводе.
          amount: new P.Decimal(quote.grossAmount),
          feeAmount: new P.Decimal(quote.feeAmount),
          toAddress: body.toAddress.trim(),
          status: 'REQUESTED',
        },
      });

      // Средства замораживаются сразу: иначе между заявкой и решением
      // человек потратит их на сделку, и одобренный вывод не пройдёт.
      await balances.lock(tx, {
        userId,
        tokenId: body.tokenId,
        amount: quote.grossAmount,
        refId: created.id,
      });

      return created;
    });

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'withdrawal.request',
        entity: 'Withdrawal',
        entityId: withdrawal.id,
        after: {
          amount: quote.grossAmount,
          fee: quote.feeAmount,
          net: quote.netAmount,
          to: body.toAddress,
        } as never,
      },
    });

    logger.info(
      { userId, symbol: balance.token.symbol, gross: quote.grossAmount, fee: quote.feeAmount },
      'заявка на вывод',
    );

    return reply.code(201).send({
      id: withdrawal.id,
      status: withdrawal.status,
      grossAmount: quote.grossAmount,
      feeAmount: quote.feeAmount,
      netAmount: quote.netAmount,
      symbol: balance.token.symbol,
      notice:
        'Заявка принята и средства заморожены. Отправка выполняется после ' +
        'проверки администратором — автоматический вывод пока не включён.',
    });
  });

  /** Отмена собственной заявки, пока она не одобрена. */
  app.delete('/wallets/withdraw/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    return serializable(async (tx) => {
      const w = await tx.withdrawal.findUnique({ where: { id } });
      if (!w || w.userId !== req.user.sub) {
        return reply.code(404).send({ error: 'Заявка не найдена' });
      }
      if (!['REQUESTED', 'AWAITING_2FA', 'MANUAL_REVIEW'].includes(w.status)) {
        return reply.code(400).send({ error: `Нельзя отменить заявку в статусе ${w.status}` });
      }

      await balances.unlock(tx, {
        userId: w.userId,
        tokenId: w.tokenId,
        amount: w.amount,
        refId: w.id,
      });

      await tx.withdrawal.update({
        where: { id },
        data: { status: 'REJECTED', rejectReason: 'Отменена пользователем' },
      });

      return { ok: true };
    });
  });
};
