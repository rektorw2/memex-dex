import crypto from 'node:crypto';
import {
  checkCode,
  canResend,
  resendAfterSeconds,
  codeExpiresAt,
  looksLikeCode,
  verificationEmail,
  maskEmail,
  CODE_LENGTH,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  VERIFY_RESULT,
  type VerifyResult,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { serverNow } from '../lib/clock.js';
import { getMailer, type SendFailure } from './mailer.js';

/**
 * Подтверждение адреса почты.
 *
 * Существует ради пробного периода. Тот выдаётся один раз
 * на пользователя, и без подтверждения адреса это правило стоило бы
 * ровно столько же, сколько стоит придумать новый адрес — то есть
 * нисколько.
 *
 * Код в базе не лежит: хранится хеш. Утечка базы не должна давать
 * возможность подтвердить чужой адрес.
 *
 * Адрес получателя берётся из записи пользователя, найденной
 * по идентификатору из проверенной подписи токена. Из тела запроса
 * адрес не читается нигде и никогда: иначе форма подтверждения
 * превращается в рассыльщик писем на любой адрес, причём отправляем
 * их мы и своей репутацией отправителя.
 */

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Шестизначный код из криптографического источника.
 *
 * `Math.random()` здесь недопустим: он предсказуем, а предсказуемый
 * код подтверждения — это подтверждение чужого адреса без письма.
 */
function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  // Отбрасываем значения, не укладывающиеся в целое число диапазонов,
  // иначе младшие коды выпадали бы чаще старших.
  const limit = Math.floor(0xffffffff / max) * max;

  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < limit) return String(n % max).padStart(CODE_LENGTH, '0');
  }
}

export type IssueFailure =
  | 'ALREADY_VERIFIED'
  | 'TOO_SOON'
  | 'EMAIL_DELIVERY_UNAVAILABLE'
  | 'EMAIL_DELIVERY_FAILED'
  | 'NO_USER';

export type IssueResult =
  | { ok: true; expiresAt: Date; devCode?: string }
  | { ok: false; reason: IssueFailure; retryAfterSeconds?: number; failure?: SendFailure };

/**
 * Выдача кода.
 *
 * Порядок здесь важнее содержания, поэтому шаги названы явно.
 *
 * **Сначала проверяем транспорт.** Если доставка не настроена, код
 * не создаётся вовсе. Создать его и не отправить значило бы занять
 * паузу повторной отправки письмом, которого нет, — человек ждал бы
 * минуту, чтобы получить тот же отказ.
 *
 * **Потом занимаем слот одним запросом к базе.** Условие «паузы нет
 * или она прошла» и запись нового хеша выполняются в одном
 * `updateMany`. Два одновременных запроса не могут оба его пройти:
 * второй увидит уже обновлённую строку и получит отказ. Без этого
 * оба сгенерировали бы по коду, оба отправили бы письмо, и годным
 * оказался бы только тот код, что записался последним, — а человек
 * читал бы первое письмо.
 *
 * **И только потом отправляем.** Если провайдер отказал, слот
 * освобождается — но лишь в том случае, если он всё ещё наш.
 * Проверка по хешу нужна на случай, когда за время отправки пауза
 * успела истечь и слот занял следующий запрос: стирать чужой код
 * нельзя.
 */
export async function issueCode(userId: string, now = serverNow()): Promise<IssueResult> {
  const mailer = getMailer();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerifiedAt: true,
      emailCodeIssuedAt: true,
      emailCodeHash: true,
      emailCodeAttempts: true,
    },
  });

  if (!user) return { ok: false, reason: 'NO_USER' };
  if (user.emailVerifiedAt) return { ok: false, reason: 'ALREADY_VERIFIED' };

  if (!mailer.enabled) {
    logger.error(
      { userId, provider: env.EMAIL_PROVIDER },
      'запрошен код подтверждения, но доставка писем не настроена',
    );
    return { ok: false, reason: 'EMAIL_DELIVERY_UNAVAILABLE' };
  }

  const pending = user.emailCodeHash
    ? {
        codeHash: user.emailCodeHash,
        issuedAt: user.emailCodeIssuedAt?.getTime() ?? 0,
        expiresAt: 0,
        attempts: user.emailCodeAttempts,
      }
    : null;

  if (!canResend(pending, now.getTime())) {
    return {
      ok: false,
      reason: 'TOO_SOON',
      retryAfterSeconds: resendAfterSeconds(pending, now.getTime()),
    };
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(codeExpiresAt(now.getTime()));
  const cooldownEdge = new Date(now.getTime() - RESEND_COOLDOWN_MS);

  // Занятие слота. Условие повторяет проверку выше — и это не лишнее:
  // проверка выше отвечает быстро и без гонки, а условие здесь
  // защищает от гонки и выполняется базой.
  const claimed = await prisma.user.updateMany({
    where: {
      id: userId,
      emailVerifiedAt: null,
      OR: [{ emailCodeIssuedAt: null }, { emailCodeIssuedAt: { lte: cooldownEdge } }],
    },
    data: {
      emailCodeHash: codeHash,
      emailCodeIssuedAt: now,
      emailCodeExpires: expiresAt,
      // Счётчик попыток считается на код, а не на человека.
      emailCodeAttempts: 0,
    },
  });

  if (claimed.count === 0) {
    // Слот занял кто-то другой между проверкой и записью. Письмо
    // отправляет он; нам остаётся сказать, сколько ждать.
    const fresh = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailCodeIssuedAt: true, emailVerifiedAt: true },
    });

    if (fresh?.emailVerifiedAt) return { ok: false, reason: 'ALREADY_VERIFIED' };

    return {
      ok: false,
      reason: 'TOO_SOON',
      retryAfterSeconds: resendAfterSeconds(
        { codeHash: '', issuedAt: fresh?.emailCodeIssuedAt?.getTime() ?? now.getTime(), expiresAt: 0, attempts: 0 },
        now.getTime(),
      ),
    };
  }

  const sent = await mailer.send({
    to: user.email,
    message: verificationEmail({
      code,
      productName: env.PUBLIC_APP_NAME,
      ttlMs: CODE_TTL_MS,
    }),
    // Ключ повтора привязан к коду: повторная попытка отправки того же
    // кода не создаст второе письмо, а новый код получит новый ключ.
    idempotencyKey: `verify-${userId}-${codeHash.slice(0, 32)}`,
  });

  if (!sent.ok) {
    // Освобождаем слот, но только если он всё ещё наш. За время
    // отправки пауза могла истечь, и код мог смениться — стирать
    // чужой нельзя.
    await prisma.user.updateMany({
      where: { id: userId, emailCodeHash: codeHash },
      data: {
        emailCodeHash: null,
        emailCodeIssuedAt: null,
        emailCodeExpires: null,
        emailCodeAttempts: 0,
      },
    });

    logger.error(
      { userId, to: maskEmail(user.email), failure: sent.failure, detail: sent.detail },
      'письмо с кодом не отправлено',
    );

    return {
      ok: false,
      reason: sent.failure === 'DISABLED' ? 'EMAIL_DELIVERY_UNAVAILABLE' : 'EMAIL_DELIVERY_FAILED',
      failure: sent.failure,
      // Паузы нет: письма не было, и заставлять человека ждать
      // не за что.
      retryAfterSeconds: 0,
    };
  }

  logger.info(
    { userId, to: maskEmail(user.email), messageId: sent.id, transport: mailer.name },
    'письмо с кодом отправлено',
  );

  return {
    ok: true,
    expiresAt,
    // Код возвращается только вне production и только когда письма
    // всё равно никуда не уходят. В production этой ветки нет:
    // код существует лишь в письме и в хеше.
    ...(env.NODE_ENV !== 'production' && mailer.name === 'console' ? { devCode: code } : {}),
  };
}

/**
 * Проверка кода.
 *
 * Попытка засчитывается до сравнения. Иначе неудачные попытки можно
 * было бы не считать вовсе: достаточно оборвать соединение сразу
 * после отправки, и счётчик не увеличился бы.
 */
export async function verifyCode(
  userId: string,
  raw: string,
  now = serverNow(),
): Promise<{ result: VerifyResult; verifiedAt?: Date }> {
  if (!looksLikeCode(raw)) return { result: VERIFY_RESULT.wrong };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      emailVerifiedAt: true,
      emailCodeHash: true,
      emailCodeIssuedAt: true,
      emailCodeExpires: true,
      emailCodeAttempts: true,
    },
  });

  if (!user) return { result: VERIFY_RESULT.noCode };
  if (user.emailVerifiedAt) {
    return { result: VERIFY_RESULT.alreadyVerified, verifiedAt: user.emailVerifiedAt };
  }
  if (!user.emailCodeHash) return { result: VERIFY_RESULT.noCode };

  const bumped = await prisma.user.update({
    where: { id: userId },
    data: { emailCodeAttempts: { increment: 1 } },
    select: { emailCodeAttempts: true },
  });

  const result = checkCode(
    {
      codeHash: user.emailCodeHash,
      issuedAt: user.emailCodeIssuedAt?.getTime() ?? 0,
      expiresAt: user.emailCodeExpires?.getTime() ?? 0,
      // Проверяем счётчик до увеличения: попытка, которую мы сейчас
      // разбираем, ещё имеет право состояться.
      attempts: bumped.emailCodeAttempts - 1,
    },
    hashCode(raw),
    now.getTime(),
  );

  if (result !== VERIFY_RESULT.ok) return { result };

  // Код стирается вместе с подтверждением. Оставить его значило бы
  // держать в базе действующий ключ к аккаунту без всякой надобности.
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerifiedAt: now,
      emailCodeHash: null,
      emailCodeIssuedAt: null,
      emailCodeExpires: null,
      emailCodeAttempts: 0,
    },
  });

  logger.info({ userId }, 'адрес почты подтверждён');

  return { result: VERIFY_RESULT.ok, verifiedAt: now };
}

/** Подтверждён ли адрес. Нужен маршрутам, которые от этого зависят. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });

  return user?.emailVerifiedAt != null;
}
