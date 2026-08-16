import { describe, it, expect } from 'vitest';
import {
  RISK_BANDS,
  riskBand,
  riskLabel,
  riskCodeLabel,
  sortReasonsByWeight,
  timeAgo,
  formatAge,
  exactTime,
  multipleView,
} from './risk-scale.js';

describe('ступени риска', () => {
  it('границы диапазонов не пересекаются и покрывают всю шкалу', () => {
    // Дыра или нахлёст здесь означали бы, что часть токенов
    // получает не тот уровень или не получает никакого.
    let expected = 0;
    for (const b of RISK_BANDS) {
      expect(b.from, `начало ${b.band}`).toBe(expected);
      expected = b.to + 1;
    }
    expect(expected).toBe(101);
  });

  it('каждая ступень несёт три признака, а не только цвет', () => {
    // Около восьми процентов мужчин не различают красный и зелёный.
    for (const b of RISK_BANDS) {
      expect(b.label.length, b.band).toBeGreaterThan(0);
      expect(b.sign.length, b.band).toBeGreaterThan(0);
      expect(b.tone.length, b.band).toBeGreaterThan(0);
    }
  });

  it('значения попадают в верные ступени', () => {
    expect(riskBand(0)?.band).toBe('low');
    expect(riskBand(29)?.band).toBe('low');
    expect(riskBand(30)?.band).toBe('medium');
    expect(riskBand(59)?.band).toBe('medium');
    expect(riskBand(60)?.band).toBe('high');
    expect(riskBand(79)?.band).toBe('high');
    expect(riskBand(80)?.band).toBe('critical');
    expect(riskBand(100)?.band).toBe('critical');
  });

  it('выход за шкалу прижимается к краям', () => {
    expect(riskBand(-5)?.band).toBe('low');
    expect(riskBand(500)?.band).toBe('critical');
  });

  it('отсутствие оценки отличается от нулевой оценки', () => {
    // Ноль означает «причин не нашли», отсутствие — «не оценивали».
    expect(riskBand(null)).toBeNull();
    expect(riskBand(undefined)).toBeNull();
    expect(riskBand(0)).not.toBeNull();
  });

  it('подпись показывает направление шкалы', () => {
    // «Риск 50» не говорит, много это или мало и куда растёт.
    expect(riskLabel(50)).toBe('Средний риск · 50/100');
    expect(riskLabel(85)).toBe('Критический риск · 85/100');
    expect(riskLabel(null)).toBe('Риск не оценён');
  });
});

describe('названия причин', () => {
  it('коды переводятся в человеческие подписи', () => {
    expect(riskCodeLabel('UNLOCKED_LIQUIDITY')).toBe('LP не заблокирован');
    expect(riskCodeLabel('MINT_AUTHORITY_ACTIVE')).toBe('Mint authority активен');
    expect(riskCodeLabel('FEW_HOLDERS')).toBe('Мало держателей');
  });

  it('незнакомый код показывается как есть, а не прячется', () => {
    // Пустая плашка хуже непонятной: по коду хотя бы можно спросить.
    expect(riskCodeLabel('НОВЫЙ_КОД')).toBe('НОВЫЙ_КОД');
  });

  it('причины сортируются по весу, а не по порядку проверки', () => {
    const sorted = sortReasonsByWeight([
      { code: 'YOUNG_POOL', weight: 5 },
      { code: 'HONEYPOT', weight: 100 },
      { code: 'FEW_HOLDERS', weight: 10 },
    ]);
    expect(sorted.map((r) => r.code)).toEqual(['HONEYPOT', 'FEW_HOLDERS', 'YOUNG_POOL']);
  });
});

describe('относительное время', () => {
  const now = new Date('2026-08-16T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('свежее время не притворяется точным', () => {
    expect(timeAgo(ago(10_000), now)).toBe('только что');
  });

  it('минуты', () => {
    expect(timeAgo(ago(4 * 60_000), now)).toBe('4 мин назад');
    expect(timeAgo(ago(59 * 60_000), now)).toBe('59 мин назад');
  });

  it('часы и дни', () => {
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('3 ч назад');
    expect(timeAgo(ago(50 * 3_600_000), now)).toBe('2 д назад');
  });

  it('пустое значение не даёт «Invalid Date»', () => {
    expect(timeAgo(null, now)).toBe('—');
    expect(timeAgo('чепуха', now)).toBe('—');
  });
});

describe('возраст как длительность', () => {
  it('меньше минуты не превращается в 0.0 ч', () => {
    // Именно это и было на карточках: «0.0 ч» выглядит как сбой
    // измерения и подрывает доверие к остальным числам.
    expect(formatAge(0.005)).toBe('<1 мин');
    expect(formatAge(0)).toBe('<1 мин');
  });

  it('минуты, часы, дни', () => {
    expect(formatAge(0.2)).toBe('12 мин');
    expect(formatAge(2)).toBe('2.0 ч');
    expect(formatAge(18)).toBe('18 ч');
    expect(formatAge(72)).toBe('3.0 д');
  });

  it('отсутствие возраста отличается от нулевого', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(undefined)).toBe('—');
  });

  it('точное время используется только когда о нём просят', () => {
    expect(exactTime('2026-08-16T04:06:00Z')).toMatch(/\d{2}:\d{2}/);
    expect(exactTime(null)).toBe('—');
  });
});

describe('показ роста', () => {
  it('отсутствие изменений помечается отдельно', () => {
    // «Пик 1.00× · Сейчас 1.00×» крупным шрифтом занимает лучшее место
    // карточки и не сообщает ничего.
    const v = multipleView(1.0, 1.0);
    expect(v.meaningful).toBe(false);
  });

  it('движение в один процент уже считается изменением', () => {
    expect(multipleView(1.01, 1.01).meaningful).toBe(true);
  });

  it('рост и падение форматируются со знаком', () => {
    expect(multipleView(1.18, 1.32).currentPct).toBe('+18%');
    expect(multipleView(0.68, 1.32).currentPct).toBe('−32%');
  });

  it('упущенный пик виден отдельно от текущего значения', () => {
    // Токен сходил в 3× и вернулся почти к входу: человеку важно
    // понять, что момент упущен, раньше, чем он увидит «3×».
    const v = multipleView(1.05, 3.0);
    expect(v.fadedFromPeak).toBe(true);
    expect(v.peak).toBe('3.00×');
  });

  it('токен около пика упущенным не считается', () => {
    expect(multipleView(2.8, 3.0).fadedFromPeak).toBe(false);
  });

  it('крупная кратность показывается без лишних знаков', () => {
    expect(multipleView(11, 111).peak).toBe('111×');
  });

  it('отсутствие данных не ломает вывод', () => {
    const v = multipleView(null, null);
    expect(v.meaningful).toBe(false);
    expect(v.peak).toBe('—');
  });
});
