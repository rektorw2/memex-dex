import { describe, expect, it } from 'vitest';
import {
  FUNDING_DIAGNOSTICS_UNAVAILABLE,
  SIGNING_DIAGNOSTICS_UNAVAILABLE,
  liveReadinessWithDiagnostics,
  phase4SectionsVerdict,
} from './agent-sections.js';

describe('доступность разделов Phase 4', () => {
  it('оба раздела отвечают — статус доступен', () => {
    expect(phase4SectionsVerdict({ funding: 'AVAILABLE', signing: 'AVAILABLE' })).toEqual({
      status: 'AVAILABLE',
      unavailable: [],
      liveBlockers: [],
    });
  });

  it('молчит пополнение — недоступен весь блок', () => {
    expect(phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'AVAILABLE' })).toEqual({
      status: 'UNAVAILABLE',
      unavailable: ['FUNDING'],
      liveBlockers: [FUNDING_DIAGNOSTICS_UNAVAILABLE],
    });
  });

  it('молчит подпись — недоступен весь блок', () => {
    expect(phase4SectionsVerdict({ funding: 'AVAILABLE', signing: 'UNAVAILABLE' })).toEqual({
      status: 'UNAVAILABLE',
      unavailable: ['SIGNING'],
      liveBlockers: [SIGNING_DIAGNOSTICS_UNAVAILABLE],
    });
  });

  it('молчат оба — названы оба', () => {
    const verdict = phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'UNAVAILABLE' });

    expect(verdict.unavailable).toEqual(['FUNDING', 'SIGNING']);
    expect(verdict.liveBlockers).toEqual([
      FUNDING_DIAGNOSTICS_UNAVAILABLE,
      SIGNING_DIAGNOSTICS_UNAVAILABLE,
    ]);
  });

  it('наружу идут имена разделов, а не подробности сбоя', () => {
    /*
     * Проверка формы, а не текста: в вердикте нет ничего, кроме
     * закрытого набора имён. Подставить сюда текст ошибки драйвера
     * можно было бы только через `unavailable`, и он бы здесь
     * не прошёл.
     */
    const verdict = phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'UNAVAILABLE' });

    for (const name of verdict.unavailable) expect(['FUNDING', 'SIGNING']).toContain(name);
  });
});

describe('неотвечающая диагностика не делает LIVE готовым', () => {
  const readyLive = { ready: true, blockers: [] as string[] };

  it('исправная диагностика ничего не меняет', () => {
    const sections = phase4SectionsVerdict({ funding: 'AVAILABLE', signing: 'AVAILABLE' });

    expect(liveReadinessWithDiagnostics(readyLive, sections)).toEqual(readyLive);
  });

  it('молчащий раздел снимает готовность', () => {
    /*
     * Инвариант. «Проверка не ответила» — это не «проверка пройдена».
     * Если бы отказ диагностики оставлял `ready: true`, худший день
     * выглядел бы так: контур сверки лежит, экран говорит «готово»,
     * человек включает LIVE.
     */
    const sections = phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'AVAILABLE' });
    const result = liveReadinessWithDiagnostics(readyLive, sections);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(FUNDING_DIAGNOSTICS_UNAVAILABLE);
  });

  it('прежние блокировки сохраняются и не дублируются', () => {
    const live = { ready: false, blockers: ['LIVE_DISABLED', FUNDING_DIAGNOSTICS_UNAVAILABLE] };
    const sections = phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'UNAVAILABLE' });
    const result = liveReadinessWithDiagnostics(live, sections);

    expect(result.blockers).toEqual([
      'LIVE_DISABLED',
      FUNDING_DIAGNOSTICS_UNAVAILABLE,
      SIGNING_DIAGNOSTICS_UNAVAILABLE,
    ]);
  });

  it('исходный объект не изменяется', () => {
    // Иначе повторный вызов накапливал бы блокировки в общем объекте.
    const live = { ready: true, blockers: [] as string[] };
    liveReadinessWithDiagnostics(
      live,
      phase4SectionsVerdict({ funding: 'UNAVAILABLE', signing: 'UNAVAILABLE' }),
    );

    expect(live).toEqual({ ready: true, blockers: [] });
  });
});
