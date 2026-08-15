/**
 * Решение об автоматической публикации колла.
 *
 * Вынесено в чистую функцию сознательно. Автоматика, которая публикует
 * что-то от вашего имени, должна быть проверяема без базы и без сети:
 * ошибку в пороге здесь видно на тесте, а не через сутки на витрине.
 *
 * Функция ничего не публикует и ничего не пишет — только возвращает
 * решение и его объяснение. Все побочные эффекты остаются в воркере.
 */

export interface AutoRuleConfig {
  isEnabled: boolean;
  /** Считать и записывать в журнал, но не публиковать. */
  isDryRun: boolean;
  /** Пустой список означает «любая поддерживаемая сеть». */
  chains: string[];

  minSmartBuyers: number;
  minSignalStrength: number;
  minSmartVolumeUsd: number;

  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxRiskScore: number;
  maxPoolAgeHours: number;

  maxCallsPerDay: number;
  cooldownMinutes: number;
}

export interface AutoRuleCandidate {
  chain: string;
  symbol: string;
  /** Свод по кошелькам, посчитанный наблюдателем. */
  smartBuyers: number;
  whaleBuyers: number;
  smartVolumeUsd: number;
  signalStrength: number;

  liquidityUsd: number | null;
  volume24hUsd: number | null;
  riskScore: number | null;
  poolAgeHours: number | null;
  priceUsd: number | null;

  /** Уже есть опубликованный колл по этому токену. */
  hasExistingCall: boolean;
  /** Правило уже принимало решение по этой находке. */
  alreadyProcessed: boolean;
}

export interface AutoRuleState {
  /** Публикаций за последние сутки. */
  callsLast24h: number;
  /** Минут с последней публикации; null — публикаций ещё не было. */
  minutesSinceLastFire: number | null;
}

export type AutoRuleOutcome = 'FIRED' | 'DRY_RUN' | 'SKIPPED';

export interface AutoRuleDecision {
  outcome: AutoRuleOutcome;
  /** Человеческое объяснение — попадает в журнал и в интерфейс. */
  reason: string;
  /** Все непройденные условия, а не только первое. */
  failed: string[];
  /** Условия, которые сработали в пользу публикации. */
  passed: string[];
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('ru-RU')}`;
}

/**
 * Проверка одной находки против правила.
 *
 * Порядок проверок важен для читаемости журнала: сначала то, что
 * относится к правилу целиком (выключено, лимит, пауза), потом то,
 * что относится к находке. Иначе в журнале против каждой находки
 * стояло бы «не прошла по ликвидности», хотя правило было выключено.
 */
export function evaluateAutoRule(
  rule: AutoRuleConfig,
  c: AutoRuleCandidate,
  state: AutoRuleState,
): AutoRuleDecision {
  const failed: string[] = [];
  const passed: string[] = [];

  if (!rule.isEnabled) {
    return { outcome: 'SKIPPED', reason: 'Правило выключено', failed: ['выключено'], passed: [] };
  }

  // Повторное решение по той же находке недопустимо: иначе после
  // перезапуска воркера правило опубликовало бы всё заново.
  if (c.alreadyProcessed) {
    return {
      outcome: 'SKIPPED',
      reason: 'Решение по этой находке уже принималось',
      failed: ['уже обработана'],
      passed: [],
    };
  }

  if (c.hasExistingCall) {
    return {
      outcome: 'SKIPPED',
      reason: 'По этому токену уже есть колл',
      failed: ['колл существует'],
      passed: [],
    };
  }

  // Ограничители проверяются до содержательных условий: находка может
  // быть идеальной, но если дневной лимит выбран, публиковать нельзя,
  // и причина отказа именно в этом.
  if (state.callsLast24h >= rule.maxCallsPerDay) {
    return {
      outcome: 'SKIPPED',
      reason: `Дневной лимит исчерпан: ${state.callsLast24h} из ${rule.maxCallsPerDay}`,
      failed: ['дневной лимит'],
      passed: [],
    };
  }

  if (
    state.minutesSinceLastFire != null &&
    state.minutesSinceLastFire < rule.cooldownMinutes
  ) {
    const left = Math.ceil(rule.cooldownMinutes - state.minutesSinceLastFire);
    return {
      outcome: 'SKIPPED',
      reason: `Пауза между публикациями: осталось ${left} мин`,
      failed: ['пауза'],
      passed: [],
    };
  }

  if (rule.chains.length > 0 && !rule.chains.includes(c.chain)) {
    return {
      outcome: 'SKIPPED',
      reason: `Сеть ${c.chain} не входит в правило`,
      failed: ['сеть'],
      passed: [],
    };
  }

  // ─── Основной триггер: покупки размеченных кошельков ────────────────
  if (c.smartBuyers < rule.minSmartBuyers) {
    failed.push(
      `кошельков с историей ${c.smartBuyers}, нужно ${rule.minSmartBuyers}`,
    );
  } else {
    passed.push(`кошельков с историей: ${c.smartBuyers}`);
  }

  if (c.signalStrength < rule.minSignalStrength) {
    failed.push(`сила сигнала ${c.signalStrength}, нужно ${rule.minSignalStrength}`);
  } else {
    passed.push(`сила сигнала ${c.signalStrength}`);
  }

  if (c.smartVolumeUsd < rule.minSmartVolumeUsd) {
    failed.push(
      `объём смарт-покупок ${money(c.smartVolumeUsd)}, нужно ${money(rule.minSmartVolumeUsd)}`,
    );
  } else {
    passed.push(`смарт-покупки на ${money(c.smartVolumeUsd)}`);
  }

  // ─── Страховочные условия ───────────────────────────────────────────
  // Отсутствующее значение трактуется как непройденное условие.
  // Обратная трактовка («нет данных — значит не мешает») означала бы,
  // что токен без метрик проходит фильтр легче, чем токен с плохими.
  if (c.liquidityUsd == null || c.liquidityUsd < rule.minLiquidityUsd) {
    failed.push(
      c.liquidityUsd == null
        ? 'ликвидность неизвестна'
        : `ликвидность ${money(c.liquidityUsd)}, нужно ${money(rule.minLiquidityUsd)}`,
    );
  } else {
    passed.push(`ликвидность ${money(c.liquidityUsd)}`);
  }

  if (c.volume24hUsd == null || c.volume24hUsd < rule.minVolume24hUsd) {
    failed.push(
      c.volume24hUsd == null
        ? 'объём за сутки неизвестен'
        : `объём ${money(c.volume24hUsd)}, нужно ${money(rule.minVolume24hUsd)}`,
    );
  } else {
    passed.push(`объём ${money(c.volume24hUsd)}`);
  }

  if (c.riskScore == null || c.riskScore > rule.maxRiskScore) {
    failed.push(
      c.riskScore == null
        ? 'риск не оценён'
        : `риск ${c.riskScore}, допустимо до ${rule.maxRiskScore}`,
    );
  } else {
    passed.push(`риск ${c.riskScore}`);
  }

  if (c.poolAgeHours != null && c.poolAgeHours > rule.maxPoolAgeHours) {
    failed.push(
      `возраст пула ${c.poolAgeHours.toFixed(1)} ч, допустимо до ${rule.maxPoolAgeHours}`,
    );
  }

  // Без цены колл создать невозможно: она и есть точка входа.
  if (c.priceUsd == null || !(c.priceUsd > 0)) {
    failed.push('цена неизвестна');
  }

  if (failed.length > 0) {
    return {
      outcome: 'SKIPPED',
      reason: `Не прошло: ${failed.join('; ')}`,
      failed,
      passed,
    };
  }

  const reason = `Условия выполнены: ${passed.join('; ')}`;

  return {
    // В режиме наблюдения решение принимается точно так же и пишется
    // в журнал, но публикации не происходит. Это позволяет неделю
    // смотреть на поведение правила, ничем не рискуя.
    outcome: rule.isDryRun ? 'DRY_RUN' : 'FIRED',
    reason: rule.isDryRun ? `[наблюдение] ${reason}` : reason,
    failed,
    passed,
  };
}

// ────────────────────────── Параметры колла ─────────────────────────────────

export interface CallTarget {
  priceUsd: number;
  pct: number;
}

/**
 * Лестница целей и стоп-лосс от цены входа.
 *
 * Доли распределяются так, чтобы в сумме дать ровно 100%: остаток
 * отдаётся последней цели. Без этого при трёх целях по 33% один процент
 * позиции оставался бы висеть навсегда.
 */
export function buildTargets(entryPriceUsd: number, targetPcts: number[]): CallTarget[] {
  const pcts = targetPcts.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (pcts.length === 0 || !(entryPriceUsd > 0)) return [];

  const share = Math.floor(100 / pcts.length);

  return pcts.map((growthPct, i) => ({
    priceUsd: entryPriceUsd * (1 + growthPct / 100),
    pct: i === pcts.length - 1 ? 100 - share * (pcts.length - 1) : share,
  }));
}

export function buildStopLoss(entryPriceUsd: number, stopLossPct: number): number | null {
  if (!(entryPriceUsd > 0)) return null;
  if (!(stopLossPct > 0) || stopLossPct >= 100) return null;
  return entryPriceUsd * (1 - stopLossPct / 100);
}

/**
 * Текст обоснования для автоматически созданного колла.
 *
 * Первой строкой сказано, что колл создан автоматикой. Пользователь,
 * читающий колл, имеет право знать, что за ним не стоит человеческое
 * суждение, — иначе автопубликация выдаёт себя за аналитику.
 */
export function buildThesis(c: AutoRuleCandidate, decision: AutoRuleDecision): string {
  const lines = [
    'Колл создан автоматически по правилу отбора, без ручного разбора проекта.',
    '',
    `Сработало на активности кошельков: ${c.smartBuyers} с подтверждённой историей ` +
      `купили на ${money(c.smartVolumeUsd)}, сила сигнала ${c.signalStrength} из 100.`,
  ];

  if (c.whaleBuyers > 0) {
    lines.push(`Также замечено крупных покупателей: ${c.whaleBuyers}.`);
  }

  lines.push(
    '',
    `Проверено: ${decision.passed.join('; ')}.`,
    '',
    'Оценка кошельков строится на нашей же истории наблюдений и говорит о ' +
      'прошлом результате их покупок, а не о будущем этого токена. ' +
      'Мем-коин может обесцениться до нуля при любых метриках.',
  );

  return lines.join('\n');
}
