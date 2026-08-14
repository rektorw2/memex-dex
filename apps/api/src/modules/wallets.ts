import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
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
};
