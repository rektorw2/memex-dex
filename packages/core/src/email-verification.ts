/**
 * Подтверждение адреса почты.
 *
 * Нужно ровно для одного: пробный период выдаётся один раз
 * на пользователя, и без подтверждения это правило превращается
 * в «один раз на адрес, который не надо подтверждать», то есть
 * ни во что — новых адресов можно придумать сколько угодно.
 *
 * Здесь только правила: длина кода, срок жизни, число попыток,
 * сравнение. Ни отправки писем, ни базы — они проверяются иначе.
 */

/**
 * Длина кода.
 *
 * Шесть цифр — миллион вариантов. Само по себе это немного, поэтому
 * защита держится не на длине, а на сроке жизни и числе попыток:
 * пять попыток за пятнадцать минут дают один шанс из двухсот тысяч,
 * и следующая попытка требует нового письма.
 */
export const CODE_LENGTH = 6;

/** Сколько живёт код. Дольше — дольше окно для подбора. */
export const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Сколько попыток даётся на один код.
 *
 * После исчерпания код сгорает целиком, а не блокируется на время:
 * блокировка на время означает, что подбор просто идёт медленнее.
 */
export const MAX_ATTEMPTS = 5;

/** Сколько ждать между письмами. Защита от рассылки чужими руками. */
export const RESEND_COOLDOWN_MS = 60 * 1000;

export const VERIFY_RESULT = {
  ok: 'OK',
  alreadyVerified: 'ALREADY_VERIFIED',
  noCode: 'NO_CODE',
  expired: 'CODE_EXPIRED',
  wrong: 'CODE_WRONG',
  tooManyAttempts: 'TOO_MANY_ATTEMPTS',
} as const;

export type VerifyResult = (typeof VERIFY_RESULT)[keyof typeof VERIFY_RESULT];

export interface PendingCode {
  /** Хеш кода. Сам код в базе не хранится. */
  codeHash: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
}

/**
 * Годен ли код к проверке.
 *
 * Разделено на причины намеренно: «истёк» и «неверен» требуют
 * от человека разного, и одинаковый ответ на оба заставляет его
 * гадать. Подсказки злоумышленнику здесь нет — он и так знает,
 * сколько времени прошло с момента, когда письмо не приходило ему.
 */
export function checkCode(
  pending: PendingCode | null | undefined,
  candidateHash: string,
  now: number,
): VerifyResult {
  if (!pending) return VERIFY_RESULT.noCode;
  if (pending.attempts >= MAX_ATTEMPTS) return VERIFY_RESULT.tooManyAttempts;
  if (now >= pending.expiresAt) return VERIFY_RESULT.expired;

  // Сравнение по длине сначала: строки разной длины сравнивать
  // побайтово незачем, а посимвольное сравнение разной длины
  // выдаёт длину по времени.
  if (candidateHash.length !== pending.codeHash.length) return VERIFY_RESULT.wrong;

  // Сравнение без раннего выхода: время ответа не должно зависеть
  // от того, сколько символов совпало.
  let diff = 0;
  for (let i = 0; i < candidateHash.length; i++) {
    diff |= candidateHash.charCodeAt(i) ^ pending.codeHash.charCodeAt(i);
  }

  return diff === 0 ? VERIFY_RESULT.ok : VERIFY_RESULT.wrong;
}

/** Можно ли выслать письмо ещё раз. */
export function canResend(pending: PendingCode | null | undefined, now: number): boolean {
  if (!pending) return true;
  return now - pending.issuedAt >= RESEND_COOLDOWN_MS;
}

/** Сколько секунд ждать до следующего письма. */
export function resendAfterSeconds(
  pending: PendingCode | null | undefined,
  now: number,
): number {
  if (canResend(pending, now)) return 0;
  return Math.ceil((pending!.issuedAt + RESEND_COOLDOWN_MS - now) / 1000);
}

/** Срок действия нового кода. */
export function codeExpiresAt(issuedAtMs: number): number {
  return issuedAtMs + CODE_TTL_MS;
}

/**
 * Проверка формы кода до обращения к базе.
 *
 * Ровно шесть цифр. Отбрасывать заведомо негодное здесь дешевле,
 * чем считать хеш и ходить в базу за каждой опечаткой.
 */
export function looksLikeCode(raw: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(raw);
}
