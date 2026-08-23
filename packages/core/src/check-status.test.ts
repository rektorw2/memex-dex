import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkStatus,
  dueForRecheck,
  statusAllowsBuy,
  statusIsShowcaseSafe,
  statusWillResolve,
  CHECK_STATUSES,
  CHECK_STATUS_TEXT,
  CHECK_STALE_AFTER_MS,
  CHECK_RECHECK_AFTER_MS,
  type CheckStatus,
} from './check-status.js';

/**
 * Что мы знаем о токене.
 *
 * Раньше «не проверен», «проверен, данных не хватило» и «источники
 * не ответили» сливались в один `pending`, и по нему нельзя было
 * понять, чинить очередь, провайдера или ничего.
 */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-23T12:00:00Z');
const V = 9;

const base = {
  riskLevel: 'low',
  checkedAt: NOW - HOUR,
  rulesVersion: V,
  currentRulesVersion: V,
  now: NOW,
};

describe('состояние проверки', () => {
  it('проверен, замечаний нет', () => {
    expect(checkStatus(base)).toBe('SAFE');
  });

  it('проверен, замечания есть', () => {
    expect(checkStatus({ ...base, riskLevel: 'medium' })).toBe('WARNING');
  });

  it('никогда не проверяли', () => {
    expect(checkStatus({ ...base, checkedAt: null, riskLevel: null })).toBe('PENDING');
  });

  it('проверка была, но ничего не установила', () => {
    expect(checkStatus({ ...base, riskLevel: 'pending' })).toBe('PENDING');
  });

  it('источники не ответили', () => {
    expect(checkStatus({ ...base, providerError: true })).toBe('PROVIDER_ERROR');
  });

  it('источники ответили, но сказать им нечего', () => {
    expect(checkStatus({ ...base, insufficientData: true })).toBe('INSUFFICIENT_DATA');
  });

  it('вердикт протух по времени', () => {
    expect(checkStatus({ ...base, checkedAt: NOW - CHECK_STALE_AFTER_MS - 1 })).toBe('STALE');
  });

  it('вердикт протух по версии правил', () => {
    // Проверенный час назад по прежним правилам опаснее проверенного
    // вчера по нынешним.
    expect(checkStatus({ ...base, rulesVersion: V - 1 })).toBe('STALE');
  });
});

describe('порядок приоритетов', () => {
  it('блокировка важнее устаревания', () => {
    // Найденное нарушение остаётся нарушением. Отменять установленный
    // факт из-за возраста записи опаснее, чем показать старую
    // блокировку.
    expect(
      checkStatus({
        ...base,
        riskLevel: 'blocked',
        rulesVersion: V - 3,
        checkedAt: NOW - 30 * 24 * HOUR,
      }),
    ).toBe('BLOCKED');
  });

  it('блокировка важнее сбоя источников', () => {
    expect(checkStatus({ ...base, riskLevel: 'blocked', providerError: true })).toBe('BLOCKED');
  });

  it('сбой источников важнее устаревания', () => {
    // Сначала надо дозвониться, потом рассуждать о свежести.
    expect(
      checkStatus({ ...base, providerError: true, checkedAt: NOW - CHECK_STALE_AFTER_MS - 1 }),
    ).toBe('PROVIDER_ERROR');
  });

  it('отсутствие проверки важнее сбоя', () => {
    // Ни разу не проверяли — сбой прошлой попытки говорить не о чем.
    expect(checkStatus({ ...base, checkedAt: null, riskLevel: null, providerError: true })).toBe(
      'PENDING',
    );
  });

  it('устаревание важнее хорошей оценки', () => {
    // Вывод имеет смысл, только если проверка не протухла.
    expect(checkStatus({ ...base, riskLevel: 'verified', rulesVersion: V - 1 })).toBe('STALE');
  });
});

describe('перепроверка отдельно от устаревания', () => {
  it('SAFE в очереди на перепроверку остаётся SAFE', () => {
    /*
     * Ключевое разделение. Очередь всегда идёт с отставанием,
     * и объявлять устаревшим всё, что не успели за сутки, значит
     * опустошить витрину при первой задержке — то есть повторить
     * ошибку, которую мы чиним.
     */
    const at = NOW - CHECK_RECHECK_AFTER_MS - HOUR;

    expect(checkStatus({ ...base, checkedAt: at })).toBe('SAFE');
    expect(dueForRecheck({ ...base, checkedAt: at })).toBe(true);
  });

  it('свежая проверка перепроверки не требует', () => {
    expect(dueForRecheck(base)).toBe(false);
  });

  it('смена версии правил ставит в очередь немедленно', () => {
    expect(dueForRecheck({ ...base, rulesVersion: V - 1 })).toBe(true);
  });

  it('непроверенный в очереди всегда', () => {
    expect(dueForRecheck({ ...base, checkedAt: null })).toBe(true);
  });
});

describe('что разрешает статус', () => {
  it('в строгую витрину попадает только SAFE', () => {
    for (const s of CHECK_STATUSES) {
      expect(statusIsShowcaseSafe(s), s).toBe(s === 'SAFE');
    }
  });

  it('покупка разрешена только после состоявшейся проверки', () => {
    // Незавершённая проверка — это отсутствие сведений, а не сведения
    // об отсутствии проблем.
    expect(statusAllowsBuy('SAFE')).toBe(true);
    expect(statusAllowsBuy('WARNING')).toBe(true);

    for (const s of ['BLOCKED', 'PENDING', 'INSUFFICIENT_DATA', 'PROVIDER_ERROR', 'STALE'] as const) {
      expect(statusAllowsBuy(s), s).toBe(false);
    }
  });

  it('ожидание помогает не всем', () => {
    expect(statusWillResolve('PENDING')).toBe(true);
    expect(statusWillResolve('PROVIDER_ERROR')).toBe(true);
    expect(statusWillResolve('STALE')).toBe(true);

    // Недостаточность данных сама не исправится: источники ответили,
    // им нечего сказать. Крутить индикатор значит обещать невозможное.
    expect(statusWillResolve('INSUFFICIENT_DATA')).toBe(false);
    expect(statusWillResolve('BLOCKED')).toBe(false);
    expect(statusWillResolve('SAFE')).toBe(false);
  });
});

describe('тексты', () => {
  it('у каждого статуса есть свой', () => {
    for (const s of CHECK_STATUSES) expect(CHECK_STATUS_TEXT[s], s).toBeTruthy();
  });

  it('тексты различаются: в этом весь смысл', () => {
    const texts = CHECK_STATUSES.map((s) => CHECK_STATUS_TEXT[s as CheckStatus]);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('часы', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('без явного now берётся системное время', () => {
    // Поддельные часы, а не реальное ожидание: тест на устаревание
    // иначе шёл бы трое суток.
    const { now: _drop, ...withoutNow } = base;

    expect(checkStatus(withoutNow)).toBe('SAFE');

    vi.setSystemTime(NOW + CHECK_STALE_AFTER_MS + 1);
    expect(checkStatus(withoutNow)).toBe('STALE');
  });
});
