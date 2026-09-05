import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERIFY_RESULT } from '@memex/core';

/**
 * Подтверждение почты и выдача бесплатного периода.
 *
 * Главный вопрос здесь один: когда именно период выдаётся. Ответ
 * «при успешном подтверждении» звучит одинаково с ответом «в момент
 * перехода», но означает разное. Первый выдал бы период всем
 * существующим пользователям в день выкладки — включая тех, кто уже
 * израсходовал свой, и тех, кто платит.
 */

let verifyResult: { result: string; verifiedAt?: Date };
let activateBehaviour: 'created' | 'existing' | 'already-used' | 'throws';
let activateCalls: number;

vi.mock('./email-verify.js', () => ({
  verifyCode: async () => verifyResult,
}));

vi.mock('./trial.js', () => ({
  activateTrial: async () => {
    activateCalls += 1;
    const trial = {
      id: 't1',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-06T00:00:00Z'),
    };
    if (activateBehaviour === 'throws') throw new Error('база недоступна');
    if (activateBehaviour === 'already-used') return { ok: false, reason: 'ALREADY_USED' };
    return { ok: true, trial, created: activateBehaviour === 'created' };
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../lib/clock.js', () => ({ serverNow: () => new Date('2026-01-01T00:00:00Z') }));

const { verifyEmailAndStartTrial } = await import('./verify-and-trial.js');

beforeEach(() => {
  verifyResult = { result: VERIFY_RESULT.ok, verifiedAt: new Date('2026-01-01T00:00:00Z') };
  activateBehaviour = 'created';
  activateCalls = 0;
});

describe('период выдаётся только при переходе', () => {
  it('верный код при неподтверждённом адресе выдаёт период', async () => {
    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.result).toBe(VERIFY_RESULT.ok);
    expect(res.trialOutcome).toBe('STARTED');
    expect(res.trial?.expiresAt.toISOString()).toBe('2026-01-06T00:00:00.000Z');
  });

  it('период ровно пять суток', () => {
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    const end = new Date('2026-01-06T00:00:00Z').getTime();

    expect(end - start).toBe(5 * 24 * 3_600_000);
  });

  it('уже подтверждённый адрес период не получает', async () => {
    /*
     * Самое важное правило всей задачи.
     *
     * Существующий подтверждённый пользователь не должен получить
     * бесплатный период просто потому, что вышла новая версия. Здесь
     * это проверяется буквально: активация не вызывается ни разу.
     */
    verifyResult = {
      result: VERIFY_RESULT.alreadyVerified,
      verifiedAt: new Date('2025-06-01T00:00:00Z'),
    };

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('NOT_APPLICABLE');
    expect(activateCalls).toBe(0);
    expect(res.trial).toBeNull();
  });

  it('неверный код ничего не выдаёт', async () => {
    verifyResult = { result: VERIFY_RESULT.wrong };

    const res = await verifyEmailAndStartTrial('u1', '000000');

    expect(res.trialOutcome).toBe('NOT_APPLICABLE');
    expect(activateCalls).toBe(0);
  });

  it('истёкший код ничего не выдаёт', async () => {
    verifyResult = { result: VERIFY_RESULT.expired };

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('NOT_APPLICABLE');
    expect(activateCalls).toBe(0);
  });

  it('исчерпанные попытки ничего не выдают', async () => {
    verifyResult = { result: VERIFY_RESULT.tooManyAttempts };

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('NOT_APPLICABLE');
    expect(activateCalls).toBe(0);
  });
});

describe('период не выдаётся дважды', () => {
  it('гонка: запись нашлась готовой — это не новый период', async () => {
    // `created: false` означает, что вставку выиграл другой запрос.
    activateBehaviour = 'existing';

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('ALREADY_USED');
  });

  it('период уже был израсходован — второго нет', async () => {
    // Например, повторная регистрация тем же адресом.
    activateBehaviour = 'already-used';

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('ALREADY_USED');
    expect(res.trial).toBeNull();
    // Подтверждение при этом состоялось.
    expect(res.result).toBe(VERIFY_RESULT.ok);
  });
});

describe('сбой выдачи не создаёт ложного состояния', () => {
  it('подтверждение остаётся в силе', async () => {
    /*
     * Откатывать подтверждение значило бы наказать человека за сбой
     * на нашей стороне: код он ввёл верный, а повторно тот же код
     * уже не примут.
     */
    activateBehaviour = 'throws';

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.result).toBe(VERIFY_RESULT.ok);
    expect(res.verifiedAt).not.toBeNull();
  });

  it('состояние честное: период не выдан, а не «якобы активен»', async () => {
    activateBehaviour = 'throws';

    const res = await verifyEmailAndStartTrial('u1', '123456');

    expect(res.trialOutcome).toBe('PENDING');
    expect(res.trial).toBeNull();
  });
});

describe('контракт модуля', () => {
  it('исход перехода не берётся из «успешного ответа вообще»', () => {
    /*
     * Проверяется текст: выдача должна быть привязана к `ok`, а не
     * к списку «ok или alreadyVerified». Разница в одну строку кода
     * и в бесплатную подписку всем существующим пользователям.
     */
    const source = readFileSync(new URL('./verify-and-trial.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).toContain('result !== VERIFY_RESULT.ok');
    expect(source).not.toContain('alreadyVerified');
  });

  it('в модуле нет ни отправки писем, ни секретов', () => {
    const source = readFileSync(new URL('./verify-and-trial.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/apiKey|RESEND|password|secret/i);
  });
});
