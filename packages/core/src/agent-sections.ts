/**
 * Разделы экрана `/agent` и их доступность.
 *
 * Экран собирается из четырёх источников, и они неравноценны:
 *
 *   • данные PAPER — обязательные. Это счёт, позиции и решения
 *     агента; без них показывать нечего;
 *   • диагностика пополнения, диагностика подписи и готовность LIVE
 *     — дополнительные. Ни одна из них не участвует в бумажной
 *     торговле.
 *
 * Раньше разницы не было, и любой сбой в дополнительном источнике
 * уносил ответ целиком: человек с бумажным счётом видел пустой экран
 * из-за диагностики контура, которым не пользовался.
 *
 * Здесь описано только правило. Как именно ловится сбой — дело
 * адаптера; сюда приходит уже готовый ответ «раздел отвечает» или
 * «раздел не отвечает».
 */

export type SectionAvailability = 'AVAILABLE' | 'UNAVAILABLE';

export interface Phase4SectionsInput {
  /** Диагностика приёма депозитов. */
  funding: SectionAvailability;
  /** Диагностика контура подписи. */
  signing: SectionAvailability;
}

export interface Phase4SectionsVerdict {
  status: SectionAvailability;
  /**
   * Какие разделы не отвечают — именами разделов и ничем больше.
   *
   * Ни текста ошибки, ни имени таблицы, ни кода драйвера: это видит
   * обычный человек, а подробности сбоя рассказывают постороннему
   * о внутреннем устройстве и ничем ему не помогают.
   */
  unavailable: string[];
  /** Блокировки LIVE, которые добавляет неотвечающая диагностика. */
  liveBlockers: string[];
}

export const FUNDING_DIAGNOSTICS_UNAVAILABLE = 'FUNDING_DIAGNOSTICS_UNAVAILABLE';
export const SIGNING_DIAGNOSTICS_UNAVAILABLE = 'SIGNING_DIAGNOSTICS_UNAVAILABLE';

export function phase4SectionsVerdict(input: Phase4SectionsInput): Phase4SectionsVerdict {
  const unavailable: string[] = [];

  if (input.funding === 'UNAVAILABLE') unavailable.push('FUNDING');
  if (input.signing === 'UNAVAILABLE') unavailable.push('SIGNING');

  return {
    status: unavailable.length === 0 ? 'AVAILABLE' : 'UNAVAILABLE',
    unavailable,
    liveBlockers: [
      ...(input.funding === 'UNAVAILABLE' ? [FUNDING_DIAGNOSTICS_UNAVAILABLE] : []),
      ...(input.signing === 'UNAVAILABLE' ? [SIGNING_DIAGNOSTICS_UNAVAILABLE] : []),
    ],
  };
}

/**
 * Готовность LIVE с учётом молчащей диагностики.
 *
 * Главное правило всего файла и единственное, ради которого он
 * отделён от адаптера: **неотвечающая проверка не считается
 * пройденной**. Отказ диагностики означает, что о состоянии контура
 * ничего не известно, а «неизвестно» — это не «готово».
 *
 * Обратное поведение выглядит безобидно ровно до того дня, когда
 * молчание совпадёт с попыткой включить LIVE.
 */
export function liveReadinessWithDiagnostics(
  live: { ready: boolean; blockers: string[] },
  sections: Phase4SectionsVerdict,
): { ready: boolean; blockers: string[] } {
  if (sections.status === 'AVAILABLE') return live;

  const blockers = [...live.blockers];
  for (const blocker of sections.liveBlockers) {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  }

  return { ready: false, blockers };
}
