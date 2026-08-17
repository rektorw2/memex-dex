/**
 * Размер обязательного набора — один источник истины.
 *
 * Проверяется то, что легко сломать правкой в другом файле: если
 * интерфейс знает размер набора сам, при добавлении проверки человек
 * прочитает «Проверено 6 из 5». Поэтому число обязано приходить
 * из ядра и совпадать с длиной самого списка.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  mandatoryChecks,
  requiredChecksCount,
  completedChecksCount,
  riskCompletenessPercent,
  assessCompleteness,
  EVM_MANDATORY_CHECKS,
  SOLANA_MANDATORY_CHECKS,
  type RiskSignal,
} from './risk-completeness.js';

const NOW = 1_800_000_000_000;

function signal(code: string, status: RiskSignal['status'] = 'passed'): RiskSignal {
  return { code, status, source: 'test', checkedAt: NOW };
}

describe('число обязательных проверок берётся из списка', () => {
  it('совпадает с длиной набора EVM', () => {
    expect(requiredChecksCount('ETHEREUM')).toBe(EVM_MANDATORY_CHECKS.length);
    expect(requiredChecksCount('BNB')).toBe(EVM_MANDATORY_CHECKS.length);
    expect(requiredChecksCount('BASE')).toBe(EVM_MANDATORY_CHECKS.length);
  });

  it('совпадает с длиной набора Solana', () => {
    expect(requiredChecksCount('SOLANA')).toBe(SOLANA_MANDATORY_CHECKS.length);
  });

  it('не зашито числом: меняется вместе со списком', () => {
    // Единственная связь между размером и списком — сам список.
    for (const chain of ['ETHEREUM', 'SOLANA'] as const) {
      expect(requiredChecksCount(chain)).toBe(mandatoryChecks(chain).length);
    }
  });

  it('закрытых считается столько же, сколько видит расчёт полноты', () => {
    const signals = [signal('honeypot'), signal('mint_authority')];

    expect(completedChecksCount('ETHEREUM', signals)).toBe(
      assessCompleteness('ETHEREUM', signals).known,
    );
  });

  it('процент и два числа согласованы', () => {
    const signals = mandatoryChecks('SOLANA')
      .slice(0, 2)
      .map((code) => signal(code));

    const c = assessCompleteness('SOLANA', signals);
    const percent = riskCompletenessPercent(c);

    expect(percent).toBe(Math.round((2 / requiredChecksCount('SOLANA')) * 100));
    expect(c.known + c.missing.length).toBe(requiredChecksCount('SOLANA'));
  });

  it('закрытых никогда не больше обязательных', () => {
    // Лишние ответы не могут переполнить набор.
    const signals = [
      ...mandatoryChecks('ETHEREUM').map((c) => signal(c)),
      signal('proxy'),
      signal('blacklist'),
    ];

    expect(completedChecksCount('ETHEREUM', signals)).toBe(requiredChecksCount('ETHEREUM'));
  });
});

describe('в разметке нет размера набора', () => {
  /**
   * Проверка по исходнику.
   *
   * Обещание «интерфейс не знает размер набора» должно быть
   * невыполнимым технически, а не только на словах: иначе первая же
   * правка вернёт литерал обратно, и тест этого не заметит.
   */
  const files = [
    new URL('../../../apps/web/components/radar/RiskMeter.tsx', import.meta.url),
    new URL('../../../apps/web/components/radar/FindCard.tsx', import.meta.url),
  ];

  for (const url of files) {
    it(`${url.pathname.split('/').pop()} не содержит литерала размера`, () => {
      const source = readFileSync(url, 'utf8');

      // Комментарии выбрасываем: в них размер упоминается как пример.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      expect(code).not.toMatch(/из\s+5/);
      expect(code).not.toMatch(/\bиз\s+\{?\s*5\b/);
      // Деление на пятёрку для доли закрытых — тот же литерал
      // в другой одежде.
      expect(code).not.toMatch(/\/\s*5\s*\)/);
    });
  }
});
