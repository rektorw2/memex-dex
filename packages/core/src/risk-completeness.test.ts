/**
 * Полнота проверок.
 *
 * Главное утверждение, ради которого написан весь набор: неизвестная
 * проверка не считается пройденной. Ошибка в эту сторону выглядит
 * безобиднее всего — «мы ничего плохого не нашли» — и стоит дороже
 * всего: человек покупает токен, про который мы просто не спрашивали.
 */

import { describe, it, expect } from 'vitest';
import {
  assessCompleteness,
  riskState,
  riskConfidence,
  isHiddenByDefault,
  mandatoryChecks,
  EVM_MANDATORY_CHECKS,
  SOLANA_MANDATORY_CHECKS,
  RISK_STALE_AFTER_MS,
  type RiskSignal,
} from './risk-completeness.js';

const NOW = 1_800_000_000_000;

function signal(code: string, status: RiskSignal['status'], over: Partial<RiskSignal> = {}): RiskSignal {
  return {
    code,
    status,
    source: 'goplus',
    checkedAt: NOW - 1_000,
    ...over,
  };
}

/** Полный набор ответов для сети. */
function allPassed(chain: 'ETHEREUM' | 'SOLANA'): RiskSignal[] {
  return mandatoryChecks(chain).map((code) => signal(code, 'passed'));
}

describe('обязательные наборы различаются по сетям', () => {
  it('в EVM нет заморозки счёта', () => {
    // Такого механизма в EVM не существует, и ждать по нему ответа
    // значит не дождаться никогда.
    expect(EVM_MANDATORY_CHECKS).not.toContain('freeze_authority');
  });

  it('в Solana нет прокси и налога на продажу', () => {
    expect(SOLANA_MANDATORY_CHECKS).not.toContain('sell_tax');
    expect(SOLANA_MANDATORY_CHECKS).not.toContain('proxy');
  });

  it('заморозка обязательна в Solana', () => {
    // Одна операция владельца делает токен непродаваемым сразу
    // у всех держателей.
    expect(SOLANA_MANDATORY_CHECKS).toContain('freeze_authority');
  });

  it('проверка сжигания ликвидности обязательна в обеих сетях', () => {
    expect(EVM_MANDATORY_CHECKS).toContain('liquidity_locked');
    expect(SOLANA_MANDATORY_CHECKS).toContain('liquidity_locked');
  });
});

describe('подсчёт полноты', () => {
  it('пустой список — ничего не закрыто', () => {
    const c = assessCompleteness('ETHEREUM', []);

    expect(c.known).toBe(0);
    expect(c.isComplete).toBe(false);
    expect(c.missing).toEqual([...EVM_MANDATORY_CHECKS]);
  });

  it('полный набор закрыт', () => {
    const c = assessCompleteness('SOLANA', allPassed('SOLANA'));

    expect(c.isComplete).toBe(true);
    expect(c.ratio).toBe(1);
  });

  it('unknown не закрывает проверку', () => {
    // Источник ответил, но ответа не дал. Считать это закрытием
    // значит превращать молчание в подтверждение.
    const signals = mandatoryChecks('ETHEREUM').map((code) => signal(code, 'unknown'));
    const c = assessCompleteness('ETHEREUM', signals);

    expect(c.known).toBe(0);
    expect(c.isComplete).toBe(false);
  });

  it('failed закрывает проверку так же, как passed', () => {
    // Провал — это полученный ответ. Незнание — нет.
    const signals = mandatoryChecks('ETHEREUM').map((code) => signal(code, 'failed'));

    expect(assessCompleteness('ETHEREUM', signals).isComplete).toBe(true);
  });

  it('необязательные ответы не увеличивают полноту', () => {
    // Иначе десять неважных ответов маскировали бы отсутствие
    // единственного важного.
    const signals = [
      signal('proxy', 'passed'),
      signal('blacklist', 'passed'),
      signal('deployer_age', 'passed'),
    ];

    expect(assessCompleteness('ETHEREUM', signals).known).toBe(0);
  });

  it('чужая сеть не засчитывается', () => {
    // Ответ про заморозку не закрывает вопрос про налог на продажу.
    const c = assessCompleteness('ETHEREUM', [signal('freeze_authority', 'passed')]);

    expect(c.known).toBe(0);
  });

  it('при двух ответах берётся более поздний', () => {
    const c = assessCompleteness('ETHEREUM', [
      signal('honeypot', 'unknown', { checkedAt: NOW - 10_000 }),
      signal('honeypot', 'passed', { checkedAt: NOW - 1_000 }),
    ]);

    expect(c.known).toBe(1);
  });
});

describe('состояние риска', () => {
  it('одна проверка не даёт низкого риска', () => {
    // Та самая поломка: карточка показывала «Низкий риск 5/100»
    // рядом с «Собираем данные».
    const r = riskState({
      chain: 'ETHEREUM',
      signals: [signal('honeypot', 'passed')],
      score: 5,
      now: NOW,
    });

    expect(r.state).toBe('insufficient_data');
    expect(r.state).not.toBe('low');
    // Числа тоже нет: пять из ста по одной проверке — это не оценка.
    expect(r.score).toBeNull();
  });

  it('полный набор без замечаний даёт низкий риск', () => {
    const r = riskState({
      chain: 'ETHEREUM',
      signals: allPassed('ETHEREUM'),
      score: 5,
      computedAt: NOW - 1_000,
      now: NOW,
    });

    expect(r.state).toBe('low');
    expect(r.score).toBe(5);
  });

  it('honeypot даёт критический риск даже при неполном наборе', () => {
    // Продать нельзя — дальше выяснять нечего.
    const r = riskState({
      chain: 'ETHEREUM',
      signals: [signal('honeypot', 'failed', { reason: 'Продажа отклоняется контрактом' })],
      score: null,
      now: NOW,
    });

    expect(r.state).toBe('critical');
    expect(r.score).toBe(100);
    expect(r.reason).toContain('Продажа');
  });

  it('удалённая ликвидность — тоже критический риск', () => {
    const r = riskState({
      chain: 'SOLANA',
      signals: [signal('liquidity_removed', 'failed')],
      score: 10,
      now: NOW,
    });

    expect(r.state).toBe('critical');
  });

  it('идущая проверка отличается от нехватки данных', () => {
    // Первое пройдёт само, второе — нет, и путать их значит
    // заставлять ждать напрасно.
    const checking = riskState({
      chain: 'ETHEREUM',
      signals: [signal('honeypot', 'passed')],
      score: null,
      isChecking: true,
      now: NOW,
    });

    expect(checking.state).toBe('checking');
    expect(checking.reason).toContain('1 из 5');
  });

  it('отказ источника не превращается в низкий риск', () => {
    const r = riskState({
      chain: 'ETHEREUM',
      signals: [],
      score: null,
      providerFailed: true,
      now: NOW,
    });

    expect(r.state).toBe('provider_error');
    expect(r.score).toBeNull();
  });

  it('давняя проверка помечается, но результат сохраняется', () => {
    // Прятать посчитанное — потеря сведений; выдавать за свежее —
    // обман: ликвидность уводят за минуты.
    const r = riskState({
      chain: 'ETHEREUM',
      signals: allPassed('ETHEREUM'),
      score: 12,
      computedAt: NOW - RISK_STALE_AFTER_MS - 1,
      now: NOW,
    });

    expect(r.state).toBe('stale');
    expect(r.score).toBe(12);
  });

  it('уровни распределяются по баллу', () => {
    const at = (score: number) =>
      riskState({
        chain: 'ETHEREUM',
        signals: allPassed('ETHEREUM'),
        score,
        computedAt: NOW,
        now: NOW,
      }).state;

    expect(at(5)).toBe('low');
    expect(at(45)).toBe('medium');
    expect(at(70)).toBe('high');
    expect(at(90)).toBe('critical');
  });

  it('провалы сортируются: абсолютные первыми', () => {
    const r = riskState({
      chain: 'SOLANA',
      signals: [
        ...allPassed('SOLANA'),
        signal('owner_supply_share', 'failed', { reason: 'Половина у одного адреса' }),
        signal('known_malicious', 'failed', { reason: 'Код совпал с известным скамом' }),
      ],
      score: 90,
      computedAt: NOW,
      now: NOW,
    });

    expect(r.failures[0]!.code).toBe('known_malicious');
  });

  it('в объяснении сказано, чего не хватает', () => {
    const r = riskState({
      chain: 'SOLANA',
      signals: [signal('mint_authority', 'passed')],
      score: 3,
      now: NOW,
    });

    expect(r.reason).toContain('freeze_authority');
    expect(r.reason).toContain('Отсутствие сведений не означает');
  });
});

describe('скрытие и уверенность', () => {
  it('по умолчанию скрывается только подтверждённый критический риск', () => {
    // Незакрытый набор — не повод прятать: это повод не называть
    // токен безопасным.
    expect(isHiddenByDefault('critical')).toBe(true);
    expect(isHiddenByDefault('insufficient_data')).toBe(false);
    expect(isHiddenByDefault('high')).toBe(false);
  });

  it('уверенность растёт с полнотой', () => {
    const of = (known: number) =>
      riskConfidence({ ratio: known / 5, known, total: 5, missing: [], isComplete: known === 5 });

    expect(of(5)).toBe('high');
    expect(of(3)).toBe('medium');
    expect(of(1)).toBe('low');
  });
});
