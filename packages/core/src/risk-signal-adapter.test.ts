/**
 * Перевод ответов провайдеров в проверки.
 *
 * Главная проверяемая мысль: отсутствие негативного флага — не
 * пройденная проверка. Ошибка здесь пишется одним знаком отрицания
 * и превращает «мы не спрашивали» в «мы проверили, всё хорошо».
 */

import { describe, it, expect } from 'vitest';
import { toRiskSignals, type ProviderFacts } from './risk-signal-adapter.js';
import { assessCompleteness, riskState } from './risk-completeness.js';

const NOW = 1_800_000_000_000;
const base: ProviderFacts = { source: 'goplus', checkedAt: NOW - 1_000 };

function statusOf(signals: ReturnType<typeof toRiskSignals>, code: string) {
  return signals.find((s) => s.code === code)?.status;
}

describe('неизвестность не превращается в успех', () => {
  it('пустой ответ провайдера даёт unknown по всем проверкам', () => {
    const signals = toRiskSignals('ETHEREUM', base);

    for (const s of signals) expect(s.status).toBe('unknown');
    expect(assessCompleteness('ETHEREUM', signals).isComplete).toBe(false);
  });

  it('отсутствие флага ханипота не считается пройденной проверкой', () => {
    // Именно здесь и живёт ошибка на один знак отрицания.
    expect(statusOf(toRiskSignals('ETHEREUM', base), 'honeypot')).toBe('unknown');
  });

  it('явное false — пройдено', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, isHoneypot: false });
    expect(statusOf(signals, 'honeypot')).toBe('passed');
  });

  it('явное true — провал с объяснением', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, isHoneypot: true });
    const s = signals.find((x) => x.code === 'honeypot')!;

    expect(s.status).toBe('failed');
    expect(s.reason).toContain('Продажа');
  });

  it('успешная симуляция продажи закрывает проверку', () => {
    // Продать пробовали и вышло — это сильнее отсутствия флага.
    const signals = toRiskSignals('ETHEREUM', { ...base, sellSimulated: true });
    expect(statusOf(signals, 'honeypot')).toBe('passed');
  });

  it('null равен отсутствию', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, mintable: null, lpLocked: null });

    expect(statusOf(signals, 'mint_authority')).toBe('unknown');
    expect(statusOf(signals, 'liquidity_locked')).toBe('unknown');
  });
});

describe('замок ликвидности', () => {
  it('флаг важнее доли сожжённого', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, lpLocked: true, lpBurnedPct: 0 });
    expect(statusOf(signals, 'liquidity_locked')).toBe('passed');
  });

  it('сожжено почти всё — пройдено', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, lpBurnedPct: 100 });
    expect(statusOf(signals, 'liquidity_locked')).toBe('passed');
  });

  it('сожжена половина — провал', () => {
    // Половина заперта, половину можно увести. Это не «частично
    // безопасно», а возможность увести.
    const signals = toRiskSignals('ETHEREUM', { ...base, lpBurnedPct: 50 });
    expect(statusOf(signals, 'liquidity_locked')).toBe('failed');
  });
});

describe('наборы по сетям различаются', () => {
  it('в EVM спрашивается налог на продажу и не спрашивается заморозка', () => {
    const codes = toRiskSignals('ETHEREUM', base).map((s) => s.code);

    expect(codes).toContain('sell_tax');
    expect(codes).not.toContain('freeze_authority');
  });

  it('в Solana спрашивается заморозка и не спрашивается налог', () => {
    // Налога на продажу в Solana нет; выдавать по нему unknown
    // значило бы вечно держать набор незакрытым.
    const codes = toRiskSignals('SOLANA', base).map((s) => s.code);

    expect(codes).toContain('freeze_authority');
    expect(codes).toContain('holder_count');
    expect(codes).not.toContain('sell_tax');
  });
});

describe('полный набор закрывает проверки', () => {
  it('EVM без замечаний даёт низкий риск', () => {
    const signals = toRiskSignals('ETHEREUM', {
      ...base,
      isHoneypot: false,
      sellTaxPct: 0,
      mintable: false,
      lpLocked: true,
      creatorPct: 4,
    });

    const r = riskState({
      chain: 'ETHEREUM',
      signals,
      score: 8,
      computedAt: NOW,
      now: NOW,
    });

    expect(r.completeness.isComplete).toBe(true);
    expect(r.state).toBe('low');
  });

  it('Solana без замечаний даёт низкий риск', () => {
    const signals = toRiskSignals('SOLANA', {
      ...base,
      isHoneypot: false,
      mintable: false,
      freezable: false,
      lpBurnedPct: 100,
      creatorPct: 3,
      holderCount: 500,
    });

    const r = riskState({ chain: 'SOLANA', signals, score: 6, computedAt: NOW, now: NOW });

    expect(r.completeness.isComplete).toBe(true);
    expect(r.state).toBe('low');
  });

  it('один ответ из пяти — недостаточно данных, а не низкий риск', () => {
    const signals = toRiskSignals('ETHEREUM', { ...base, isHoneypot: false });

    const r = riskState({ chain: 'ETHEREUM', signals, score: 5, computedAt: NOW, now: NOW });

    expect(r.state).toBe('insufficient_data');
    expect(r.score).toBeNull();
    expect(r.completeness.known).toBe(1);
  });

  it('ханипот при пустых остальных полях даёт критический риск', () => {
    const signals = toRiskSignals('SOLANA', { ...base, isHoneypot: true });

    const r = riskState({ chain: 'SOLANA', signals, score: null, now: NOW });

    expect(r.state).toBe('critical');
  });
});

describe('пороги', () => {
  it('доля владельца выше половины — провал', () => {
    expect(statusOf(toRiskSignals('ETHEREUM', { ...base, creatorPct: 60 }), 'owner_supply_share')).toBe(
      'failed',
    );
  });

  it('доля владельца в пределах нормы — пройдено', () => {
    expect(statusOf(toRiskSignals('ETHEREUM', { ...base, creatorPct: 5 }), 'owner_supply_share')).toBe(
      'passed',
    );
  });

  it('доля создателя важнее доли десяти крупнейших', () => {
    // Десять держателей с половиной предложения — обычное дело
    // на старте; один создатель с половиной — нет.
    const signals = toRiskSignals('ETHEREUM', { ...base, creatorPct: 60, top10Pct: 10 });
    expect(statusOf(signals, 'owner_supply_share')).toBe('failed');
  });

  it('высокий налог на продажу — провал', () => {
    expect(statusOf(toRiskSignals('BNB', { ...base, sellTaxPct: 40 }), 'sell_tax')).toBe('failed');
  });

  it('нечисловое значение не даёт вердикта', () => {
    expect(statusOf(toRiskSignals('BNB', { ...base, sellTaxPct: NaN }), 'sell_tax')).toBe('unknown');
  });
});

describe('происхождение значения', () => {
  it('источник и время сохраняются в каждом сигнале', () => {
    // Без этого нельзя понять, чьи данные разошлись и когда.
    const signals = toRiskSignals('SOLANA', { ...base, source: 'rugcheck', checkedAt: 42 });

    for (const s of signals) {
      expect(s.source).toBe('rugcheck');
      expect(s.checkedAt).toBe(42);
    }
  });
});
