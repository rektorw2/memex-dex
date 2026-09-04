import { describe, it, expect } from 'vitest';
import {
  classifyMissing,
  compareChainFacts,
  safetyStateForIssue,
  worstSafetyState,
  allowsAutomaticCredit,
  depositPipelineStage,
  reconciliationBackoffMs,
  isPendingTooLong,
  MISSING_CHECKS_BEFORE_ISSUE,
  MISSING_MIN_AGE_MS,
  PENDING_MAX_AGE_MS,
  RECONCILIATION_BACKOFF_MAX_MS,
  type ReconciliationIssueKind,
} from './solana-reconciliation.js';

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

// ─────────────────────────── Исчезновение ────────────────────────────────────

describe('исчезновение транзакции', () => {
  const missing = (over: Partial<Parameters<typeof classifyMissing>[0]> = {}) =>
    classifyMissing({
      consecutiveMissingChecks: MISSING_CHECKS_BEFORE_ISSUE,
      missingSince: NOW - MISSING_MIN_AGE_MS,
      now: NOW,
      wasCredited: false,
      wasFinalized: false,
      ...over,
    });

  it('одна неудачная проверка не поднимает тревогу', () => {
    // Отставший узел не является реорганизацией цепочки.
    expect(missing({ consecutiveMissingChecks: 1, missingSince: NOW }).escalate).toBe(false);
  });

  it('нужного числа проверок мало без выдержки по времени', () => {
    // Три проверки за одну секунду видят одну и ту же секунду.
    expect(missing({ missingSince: NOW - 1_000 }).escalate).toBe(false);
  });

  it('выдержки по времени мало без числа проверок', () => {
    expect(
      missing({
        consecutiveMissingChecks: MISSING_CHECKS_BEFORE_ISSUE - 1,
        missingSince: NOW - MISSING_MIN_AGE_MS * 10,
      }).escalate,
    ).toBe(false);
  });

  it('оба условия вместе поднимают тревогу', () => {
    expect(missing().escalate).toBe(true);
  });

  it('без отметки начала не поднимает тревогу', () => {
    expect(missing({ missingSince: null }).escalate).toBe(false);
  });

  it('у зачисленного события это реорганизация после зачисления', () => {
    expect(missing({ wasCredited: true }).kind).toBe('REORG_AFTER_CREDIT');
  });

  it('у финализированного без проводки — исчезновение финализированной', () => {
    expect(missing({ wasFinalized: true }).kind).toBe('FINALIZED_DISAPPEARED');
  });

  it('у ожидающего — исчезновение ожидающей', () => {
    expect(missing().kind).toBe('PENDING_DISAPPEARED');
  });

  it('зачисление важнее финализации при выборе вида', () => {
    // Оба флага сразу — обычное состояние зачисленного события.
    expect(missing({ wasCredited: true, wasFinalized: true }).kind).toBe('REORG_AFTER_CREDIT');
  });
});

// ──────────────────────────── Сравнение фактов ───────────────────────────────

describe('сравнение с цепочкой', () => {
  const stored = {
    slot: '100',
    blockhash: 'hash-a',
    rawAmount: '1000000',
    destination: 'Dest111',
    mint: null,
  };

  it('полное совпадение не даёт расхождений', () => {
    expect(compareChainFacts(stored, { ...stored })).toEqual([]);
  });

  it('несовпадение суммы', () => {
    expect(compareChainFacts(stored, { ...stored, rawAmount: '999999' }))
      .toContain('AMOUNT_MISMATCH');
  });

  it('несовпадение получателя', () => {
    expect(compareChainFacts(stored, { ...stored, destination: 'Dest222' }))
      .toContain('DESTINATION_MISMATCH');
  });

  it('несовпадение адреса выпуска', () => {
    expect(compareChainFacts(stored, { ...stored, mint: 'EPjF...' }))
      .toContain('MINT_MISMATCH');
  });

  it('null и отсутствие адреса выпуска — одно и то же', () => {
    // Нативный SOL приходит обоими способами; расхождением это не является.
    expect(compareChainFacts({ ...stored, mint: null }, { ...stored, mint: null })).toEqual([]);
  });

  it('несовпадение слота', () => {
    expect(compareChainFacts(stored, { ...stored, slot: '101' })).toContain('SLOT_CHANGED');
  });

  it('несовпадение blockhash', () => {
    expect(compareChainFacts(stored, { ...stored, blockhash: 'hash-b' }))
      .toContain('BLOCKHASH_CHANGED');
  });

  it('неизвестный blockhash не считается другим', () => {
    // Отсутствие значения — «не знаем», а не «не совпало».
    expect(compareChainFacts(stored, { ...stored, blockhash: null })).toEqual([]);
  });

  it('сумма стоит впереди слота', () => {
    const kinds = compareChainFacts(stored, { ...stored, rawAmount: '1', slot: '101' });
    expect(kinds.indexOf('AMOUNT_MISMATCH')).toBeLessThan(kinds.indexOf('SLOT_CHANGED'));
  });
});

// ────────────────────────── Состояние безопасности ───────────────────────────

describe('состояние контура пополнений', () => {
  it('недоступность узла только ухудшает состояние, но не останавливает', () => {
    const state = safetyStateForIssue('CHAIN_UNREACHABLE', false);
    expect(state).toBe('DEGRADED');
    // Сетевой сбой означает «не видим», а не «видим неправильное».
    expect(allowsAutomaticCredit(state)).toBe(true);
  });

  it('противоречие до зачисления останавливает зачисления', () => {
    const state = safetyStateForIssue('AMOUNT_MISMATCH', false);
    expect(state).toBe('PAUSED');
    expect(allowsAutomaticCredit(state)).toBe(false);
  });

  it('то же противоречие после зачисления требует человека', () => {
    expect(safetyStateForIssue('AMOUNT_MISMATCH', true)).toBe('REVIEW_REQUIRED');
  });

  it('реорганизация после зачисления требует человека независимо от флага', () => {
    expect(safetyStateForIssue('REORG_AFTER_CREDIT', false)).toBe('REVIEW_REQUIRED');
  });

  it('проводка без события цепочки требует человека', () => {
    expect(safetyStateForIssue('CREDIT_WITHOUT_CHAIN_EVENT', false)).toBe('REVIEW_REQUIRED');
  });

  it('финализация без проводки не останавливает контур', () => {
    // Деньги ещё не выданы: это отставание, а не расхождение баланса.
    expect(safetyStateForIssue('FINALIZED_WITHOUT_CREDIT', false)).toBe('DEGRADED');
  });

  it('пустой список проблем — здоровое состояние', () => {
    expect(worstSafetyState([])).toBe('HEALTHY');
    expect(allowsAutomaticCredit('HEALTHY')).toBe(true);
  });

  it('худшее состояние выигрывает у остальных', () => {
    expect(worstSafetyState(['DEGRADED', 'REVIEW_REQUIRED', 'HEALTHY'])).toBe('REVIEW_REQUIRED');
    expect(worstSafetyState(['DEGRADED', 'PAUSED'])).toBe('PAUSED');
  });

  it('ни один вид расхождения не остаётся здоровым', () => {
    const kinds: ReconciliationIssueKind[] = [
      'PENDING_DISAPPEARED', 'FINALIZED_DISAPPEARED', 'SLOT_CHANGED', 'BLOCKHASH_CHANGED',
      'AMOUNT_MISMATCH', 'DESTINATION_MISMATCH', 'MINT_MISMATCH', 'CREDIT_WITHOUT_CHAIN_EVENT',
      'FINALIZED_WITHOUT_CREDIT', 'PENDING_TOO_LONG', 'CHAIN_UNREACHABLE',
      'CHAIN_RESPONSE_INVALID', 'REORG_AFTER_CREDIT',
    ];
    // Проблема, не меняющая состояние, была бы проблемой только на бумаге.
    for (const kind of kinds) {
      expect(safetyStateForIssue(kind, false), kind).not.toBe('HEALTHY');
    }
  });

  it('после зачисления ни одно расхождение не остаётся ниже паузы', () => {
    for (const kind of ['SLOT_CHANGED', 'DESTINATION_MISMATCH', 'MINT_MISMATCH'] as const) {
      expect(allowsAutomaticCredit(safetyStateForIssue(kind, true)), kind).toBe(false);
    }
  });
});

// ───────────────────────────── Стадии конвейера ──────────────────────────────

describe('стадии для человека', () => {
  it('подтверждение и ожидание подтверждений — один шаг', () => {
    expect(depositPipelineStage('AWAITING_CONFIRMATIONS')).toBe('CONFIRMING');
    expect(depositPipelineStage('CONFIRMED')).toBe('CONFIRMING');
  });

  it('обнаружение, финализация и зачисление различимы', () => {
    expect(depositPipelineStage('DETECTED')).toBe('DETECTED');
    expect(depositPipelineStage('FINALIZED')).toBe('FINALIZED');
    expect(depositPipelineStage('CREDITED')).toBe('CREDITED');
  });

  it('реорганизация показывается как требующая проверки', () => {
    expect(depositPipelineStage('REORGED')).toBe('REVIEW');
    expect(depositPipelineStage('REVIEW_REQUIRED')).toBe('REVIEW');
  });

  it('незнакомое состояние не выдаётся за успех', () => {
    // Новое состояние в базе не должно превратиться в «Зачислен».
    expect(depositPipelineStage('SOMETHING_NEW')).toBe('REVIEW');
  });
});

// ────────────────────────────── Отступление ──────────────────────────────────

describe('отступление после ошибки', () => {
  it('растёт с номером попытки', () => {
    expect(reconciliationBackoffMs(2, 1)).toBeGreaterThan(reconciliationBackoffMs(1, 1));
  });

  it('не превышает верхнюю границу', () => {
    expect(reconciliationBackoffMs(50, 1)).toBeLessThanOrEqual(RECONCILIATION_BACKOFF_MAX_MS);
  });

  it('джиттер разводит одинаковые попытки', () => {
    // Без джиттера все отступившие процессы вернутся одновременно.
    expect(reconciliationBackoffMs(3, 0)).not.toBe(reconciliationBackoffMs(3, 1));
  });

  it('никогда не вырождается в мгновенный повтор', () => {
    expect(reconciliationBackoffMs(1, 0)).toBeGreaterThan(0);
  });

  it('нулевая и отрицательная попытка не ломают расчёт', () => {
    expect(reconciliationBackoffMs(0, 0.5)).toBeGreaterThan(0);
    expect(reconciliationBackoffMs(-5, 0.5)).toBeGreaterThan(0);
  });
});

describe('зависшее ожидание', () => {
  it('свежее событие зависшим не считается', () => {
    expect(isPendingTooLong(NOW - 1_000, NOW)).toBe(false);
  });

  it('старое событие считается зависшим', () => {
    expect(isPendingTooLong(NOW - PENDING_MAX_AGE_MS, NOW)).toBe(true);
  });
});
