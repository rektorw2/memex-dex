import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  normalizeEmail,
  emailLooksValid,
  passwordIssue,
  totpIssue,
  PASSWORD_HINT,
  PASSWORD_MAX,
} from '@memex/core';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { hashToken } from '../lib/crypto.js';

/*
 * Схемы приводят вход к сравнимому виду до всякой проверки.
 *
 * `User@Example.com`, ` user@example.com ` и `user@example.com` —
 * один ящик. Без нормализации человек регистрируется одним
 * написанием, входит другим и получает «неверный email или пароль»
 * при верном пароле.
 */
const emailField = z
  .string()
  .transform(normalizeEmail)
  .refine(emailLooksValid, { message: 'Некорректный адрес почты' });

const registerSchema = z.object({
  email: emailField,
  password: z
    .string()
    .refine((v) => passwordIssue(v) == null, { message: PASSWORD_HINT }),
});

const loginSchema = z.object({
  email: emailField,
  // На входе длина не проверяется: старый аккаунт мог быть заведён
  // по прежним правилам, и отказывать ему в доступе из-за новой
  // нижней границы значит запереть человека снаружи.
  password: z.string().min(1).max(PASSWORD_MAX),
  totp: z
    .string()
    .refine((v) => totpIssue(v) == null, { message: 'Код 2FA — ровно шесть цифр' })
    .optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15m' } } }, async (req, reply) => {
    const body = registerSchema.parse(req.body);

    /*
     * Существующий адрес получает явный отказ.
     *
     * Прежде здесь стоял `201 { ok: true }` — сознательная защита
     * от перебора зарегистрированных адресов. Цена оказалась выше
     * пользы: интерфейс читал 201 как успех и показывал «Аккаунт
     * создан» человеку, у которого аккаунт уже есть. Он уходил
     * ждать письма, которого не будет, вместо того чтобы войти.
     *
     * Перебор при этом всё равно возможен: форма входа отвечает
     * по-разному на существующий и несуществующий адрес по времени
     * ответа, а сброс пароля — по самому факту письма. Защитой
     * здесь работает ограничение частоты: пять попыток
     * за пятнадцать минут.
     *
     * Пароль существующего аккаунта не проверяется: регистрация
     * не является скрытым входом.
     */
    const existing = await prisma.user.findUnique({ where: { email: body.email } });

    if (existing) {
      return reply.code(409).send({
        error: 'Аккаунт уже существует — войдите',
        code: 'ACCOUNT_ALREADY_EXISTS',
      });
    }

    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
    });

    try {
      await prisma.user.create({ data: { email: body.email, passwordHash } });
    } catch (e: any) {
      /*
       * Гонка двух одновременных регистраций.
       *
       * Проверка выше и запись — не одна операция, и между ними
       * успевает пройти второй запрос. Последней защитой остаётся
       * уникальное ограничение базы; его нарушение здесь — не сбой,
       * а тот же самый конфликт.
       */
      if (e?.code === 'P2002') {
        return reply.code(409).send({
          error: 'Аккаунт уже существует — войдите',
          code: 'ACCOUNT_ALREADY_EXISTS',
        });
      }
      throw e;
    }

    return reply.code(201).send({ ok: true });
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15m' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // Всегда выполняем проверку хэша, даже если пользователя нет —
    // иначе разница во времени ответа выдаёт существование аккаунта.
    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await argon2.verify(user?.passwordHash ?? dummyHash, body.password).catch(() => false);

    if (!user || !valid) return reply.code(401).send({ error: 'Неверный email или пароль' });
    if (user.isFrozen) return reply.code(403).send({ error: 'Аккаунт заморожен' });

    if (user.totpSecret) {
      if (!body.totp) return reply.code(401).send({ error: 'Требуется код 2FA', need2fa: true });
      if (!authenticator.check(body.totp, user.totpSecret)) {
        return reply.code(401).send({ error: 'Неверный код 2FA' });
      }
    }

    const accessToken = app.jwt.sign({ sub: user.id, role: user.role });
    const refreshToken = crypto.randomBytes(48).toString('base64url');

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: hashToken(refreshToken),
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip,
        expiresAt: new Date(Date.now() + 30 * 864e5),
      },
    });

    return { accessToken, refreshToken, role: user.role, kycStatus: user.kycStatus };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const session = await prisma.session.findUnique({
      where: { refreshHash: hashToken(refreshToken) },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: 'Сессия недействительна' });
    }
    return { accessToken: app.jwt.sign({ sub: session.userId, role: session.user.role }) };
  });

  app.post('/auth/logout', { preHandler: [app.authenticate] }, async (req) => {
    await prisma.session.updateMany({
      where: { userId: req.user.sub, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });

  /** 2FA обязателен для вывода средств — включаем до первой выплаты. */
  app.post('/auth/2fa/setup', { preHandler: [app.authenticate] }, async (req) => {
    const secret = authenticator.generateSecret();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, 'Memex DEX', secret),
    };
  });
};
