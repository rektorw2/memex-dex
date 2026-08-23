import { describe, it, expect } from 'vitest';
import { crossCheck, type SourceReading } from './cross-source.js';
import { assessRisk, CRITICAL_CODES, type Reason } from './risk-model.js';

/**
 * Отказ сети — факт о сети, а не о токене.
 *
 * Самый дорогой из найденных дефектов. Каждый запрос к источнику
 * оборачивался в `.catch(() => null)`, и «источник ответил, что такого
 * токена нет» становилось неотличимо от «источник не ответил».
 * Дальше правило «ни один источник не знает этот токен» выдавало
 * блокирующую причину весом 100, и токен получал `blocked`
 * за таймаут у DexScreener — до самой следующей смены версии правил.
 */

const saved = (priceUsd: number | null): SourceReading => ({
  source: 'сохранённое значение',
  live: false,
  outcome: priceUsd == null ? 'empty' : 'ok',
  priceUsd,
  liquidityUsd: null,
  volume24hUsd: null,
});

const live = (
  source: string,
  outcome: SourceReading['outcome'],
  priceUsd: number | null = null,
  liquidityUsd: number | null = null,
): SourceReading => ({ source, live: true, outcome, priceUsd, liquidityUsd, volume24hUsd: null });

describe('неответивший источник не обвиняет токен', () => {
  it('сбой всех живых источников не даёт блокирующей причины', () => {
    const v = crossCheck([
      saved(null),
      live('DexScreener', 'error'),
      live('OKX', 'error'),
    ]);

    expect(v.blockers).toEqual([]);
    expect(v.incomplete).toBe(true);
    expect(v.failed).toBe(2);
  });

  it('один пустой ответ выводом не считается', () => {
    /*
     * Тот же дефект в другой форме. Правило «никто не знает токен»
     * писалось на трёх источниках; при одном живом оно означает
     * «один источник не знает», а для свежей находки это норма —
     * DexScreener отстаёт от собственного списка продвигаемых.
     */
    const v = crossCheck([saved(null), live('DexScreener', 'empty'), live('OKX', 'skipped')]);

    expect(v.blockers).toEqual([]);
    expect(v.warnings).toHaveLength(1);
  });

  it('пустой ответ всех источников блокирующую причину даёт', () => {
    // Здесь источники ответили. «Никто не знает этот токен» —
    // сведения, и на них можно опираться.
    const v = crossCheck([
      saved(null),
      live('DexScreener', 'empty'),
      live('OKX', 'empty'),
    ]);

    expect(v.blockers).toHaveLength(1);
    expect(v.incomplete).toBe(false);
  });

  it('один сбой отменяет вывод даже при одном пустом ответе', () => {
    // Полсведений — не сведения: неизвестно, что сказал бы второй.
    const v = crossCheck([saved(null), live('DexScreener', 'empty'), live('OKX', 'error')]);

    expect(v.blockers).toEqual([]);
    expect(v.incomplete).toBe(true);
  });

  it('в сообщении названы те, кто не ответил', () => {
    const v = crossCheck([saved(null), live('DexScreener', 'error'), live('OKX', 'empty')]);

    expect(v.warnings.join(' ')).toContain('DexScreener');
  });
});

describe('ненастроенный источник — наш пробел, а не свойство токена', () => {
  it('в число опрошенных входят только живые источники', () => {
    // Ни пропущенный OKX, ни наша собственная запись в базе
    // источниками не считаются: спросили ровно одного.
    const v = crossCheck([saved(1), live('DexScreener', 'ok', 1), live('OKX', 'skipped')]);

    expect(v.queried).toBe(1);
    expect(v.known).toBe(1);
  });

  it('сохранённое значение всё же участвует в согласованном числе', () => {
    // Присутствие и медиана — разные вопросы. Собственная запись
    // не подтверждает существование токена, но остаётся законным
    // кандидатом на «какое число писать в базу».
    const v = crossCheck([saved(1), live('DexScreener', 'ok', 2), live('OKX', 'skipped')]);

    expect(v.agreed.priceUsd).toBe(1.5);
  });

  it('пропущенный источник не даёт замечания об одиночестве', () => {
    /*
     * Иначе ненастроенный ключ OKX превращался бы в баллы риска
     * каждому токену витрины: собственный пробел записывался бы
     * токену в минус.
     */
    const v = crossCheck([saved(null), live('DexScreener', 'ok', 1, 50_000), live('OKX', 'skipped')]);

    expect(v.warnings).toEqual([]);
  });

  it('пропуск не считается неудачей', () => {
    const v = crossCheck([saved(1), live('OKX', 'skipped')]);

    expect(v.failed).toBe(0);
    expect(v.incomplete).toBe(false);
  });
});

describe('замечание об одиночестве', () => {
  it('срабатывает, когда источники ответили и знает токен один', () => {
    const v = crossCheck([
      saved(null),
      live('DexScreener', 'ok', 1, 50_000),
      live('OKX', 'empty'),
    ]);

    expect(v.warnings).toHaveLength(1);
    expect(v.blockers).toEqual([]);
  });

  it('молчит при неполном опросе', () => {
    // Второй источник мог бы знать токен — мы до него не дозвонились.
    const v = crossCheck([saved(null), live('DexScreener', 'ok', 1, 50_000), live('OKX', 'error')]);

    expect(v.warnings.some((w) => w.includes('только'))).toBe(false);
  });
});

describe('оценка риска при неполном опросе', () => {
  const noReasons: Reason[] = [];

  it('неполный опрос не даёт назвать токен безопасным', () => {
    const r = assessRisk({
      reasons: noReasons,
      securityChecked: true,
      isVerifiedAsset: false,
      providerError: true,
    });

    expect(r.level).toBe('pending');
  });

  it('найденное нарушение сильнее неполного опроса', () => {
    /*
     * Порядок важен. Ханипот остаётся ханипотом, даже если
     * параллельно отвалился DexScreener: факт установлен,
     * и отменять его из-за чужого таймаута нельзя.
     */
    const r = assessRisk({
      reasons: [{ code: 'HONEYPOT', message: 'нельзя продать', weight: 100 }],
      securityChecked: true,
      isVerifiedAsset: false,
      providerError: true,
    });

    expect(r.level).toBe('blocked');
  });

  it('без сбоя оценка считается как обычно', () => {
    const r = assessRisk({
      reasons: noReasons,
      securityChecked: true,
      isVerifiedAsset: false,
      providerError: false,
    });

    expect(r.level).toBe('low');
  });
});

describe('расхождение источников', () => {
  it('код расхождения остаётся критическим', () => {
    // Пересчёт весов не должен был ослабить ни одно правило:
    // трёхкратная разница в цене по-прежнему означает подделанный пул.
    expect(CRITICAL_CODES.has('SOURCE_PRICE_MISMATCH')).toBe(true);
  });

  it('разница в разы блокирует', () => {
    const v = crossCheck([
      saved(null),
      live('DexScreener', 'ok', 1),
      live('OKX', 'ok', 10),
    ]);

    expect(v.blockers.length).toBeGreaterThan(0);
  });

  it('сохранённое значение в сверке не участвует', () => {
    // Иначе проверка сверяла бы свежую котировку с ценой, которую
    // сама же и записала, — то есть измеряла бы время.
    const v = crossCheck([saved(1), live('DexScreener', 'ok', 10)]);

    expect(v.priceSpread).toBeNull();
    expect(v.blockers).toEqual([]);
  });
});
