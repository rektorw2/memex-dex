import { describe, it, expect } from 'vitest';
import {
  checkCode,
  canResend,
  resendAfterSeconds,
  codeExpiresAt,
  looksLikeCode,
  VERIFY_RESULT,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  type PendingCode,
} from './email-verification.js';

const NOW = 1_800_000_000_000;
const HASH = 'a'.repeat(64);

function pending(over: Partial<PendingCode> = {}): PendingCode {
  return {
    codeHash: HASH,
    issuedAt: NOW,
    expiresAt: NOW + CODE_TTL_MS,
    attempts: 0,
    ...over,
  };
}

describe('проверка кода', () => {
  it('верный код проходит', () => {
    expect(checkCode(pending(), HASH, NOW)).toBe(VERIFY_RESULT.ok);
  });

  it('неверный код отклоняется', () => {
    expect(checkCode(pending(), 'b'.repeat(64), NOW)).toBe(VERIFY_RESULT.wrong);
  });

  it('кода нет — отдельная причина', () => {
    // «Не запрашивали письмо» и «код неверен» требуют от человека
    // разного, и одинаковый ответ заставляет гадать.
    expect(checkCode(null, HASH, NOW)).toBe(VERIFY_RESULT.noCode);
  });

  it('истёкший код отклоняется', () => {
    expect(checkCode(pending(), HASH, NOW + CODE_TTL_MS)).toBe(VERIFY_RESULT.expired);
  });

  it('за миллисекунду до истечения ещё годен', () => {
    expect(checkCode(pending(), HASH, NOW + CODE_TTL_MS - 1)).toBe(VERIFY_RESULT.ok);
  });

  it('исчерпанные попытки сжигают код', () => {
    // Не блокировка на время: блокировка означает, что подбор просто
    // идёт медленнее.
    const p = pending({ attempts: MAX_ATTEMPTS });
    expect(checkCode(p, HASH, NOW)).toBe(VERIFY_RESULT.tooManyAttempts);
  });

  it('последняя попытка ещё считается', () => {
    expect(checkCode(pending({ attempts: MAX_ATTEMPTS - 1 }), HASH, NOW)).toBe(VERIFY_RESULT.ok);
  });

  it('исчерпание попыток важнее истечения', () => {
    const p = pending({ attempts: MAX_ATTEMPTS, expiresAt: NOW - 1 });
    expect(checkCode(p, HASH, NOW)).toBe(VERIFY_RESULT.tooManyAttempts);
  });

  it('код другой длины не совпадает', () => {
    expect(checkCode(pending(), 'a'.repeat(63), NOW)).toBe(VERIFY_RESULT.wrong);
  });

  it('различие в последнем символе замечено', () => {
    const almost = 'a'.repeat(63) + 'b';
    expect(checkCode(pending(), almost, NOW)).toBe(VERIFY_RESULT.wrong);
  });

  it('различие в первом символе замечено', () => {
    const almost = 'b' + 'a'.repeat(63);
    expect(checkCode(pending(), almost, NOW)).toBe(VERIFY_RESULT.wrong);
  });
});

describe('повторная отправка письма', () => {
  it('сразу после отправки — нельзя', () => {
    // Иначе форму подтверждения используют как рассыльщик писем
    // на чужой адрес.
    expect(canResend(pending(), NOW)).toBe(false);
  });

  it('после паузы — можно', () => {
    expect(canResend(pending(), NOW + RESEND_COOLDOWN_MS)).toBe(true);
  });

  it('первое письмо не ждёт', () => {
    expect(canResend(null, NOW)).toBe(true);
    expect(resendAfterSeconds(null, NOW)).toBe(0);
  });

  it('остаток ожидания считается в секундах', () => {
    expect(resendAfterSeconds(pending(), NOW)).toBe(RESEND_COOLDOWN_MS / 1000);
    expect(resendAfterSeconds(pending(), NOW + RESEND_COOLDOWN_MS)).toBe(0);
  });
});

describe('форма кода', () => {
  it('шесть цифр принимаются', () => {
    expect(looksLikeCode('123456')).toBe(true);
    expect(looksLikeCode('000000')).toBe(true);
  });

  it('всё остальное отбрасывается до базы', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', '12345a', ' 123456']) {
      expect(looksLikeCode(bad), bad).toBe(false);
    }
  });
});

describe('срок действия', () => {
  it('пятнадцать минут от выдачи', () => {
    expect(codeExpiresAt(NOW)).toBe(NOW + 15 * 60 * 1000);
  });
});
