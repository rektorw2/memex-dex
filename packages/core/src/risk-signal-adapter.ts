/**
 * Перевод ответов провайдеров в обязательные проверки.
 *
 * Здесь живёт правило, которое легче всего нарушить незаметно:
 * отсутствие негативного флага — это не пройденная проверка.
 *
 * Провайдеры отвечают полями вида `isHoneypot`. Когда поле равно
 * `false`, проверка пройдена. Когда его нет вовсе — а нет его часто:
 * сеть не поддерживается, токен слишком свежий, запрос не дошёл, —
 * поле приходит как `undefined`. И вот тут соблазн: `!isHoneypot`
 * равно `true` и для `false`, и для `undefined`. Одна такая строка
 * превращает «мы не спрашивали» в «мы проверили, всё хорошо».
 *
 * Поэтому перевод делается явно и по одному полю, а `null`
 * и `undefined` дают `unknown`.
 */

import type { ChainKey } from './token-registry.js';
import type { RiskSignal, SignalStatus } from './risk-completeness.js';

/**
 * Что мы получили от источников.
 *
 * Поля намеренно повторяют то, что реально приходит: имена взяты
 * из существующих адаптеров, а не выдуманы. Все необязательны, и это
 * не небрежность — так и есть в жизни.
 */
export interface ProviderFacts {
  isHoneypot?: boolean | null;
  /** Продажа проверена симуляцией и прошла. */
  sellSimulated?: boolean | null;
  sellTaxPct?: number | null;
  buyTaxPct?: number | null;
  mintable?: boolean | null;
  freezable?: boolean | null;
  lpLocked?: boolean | null;
  lpBurnedPct?: number | null;
  top10Pct?: number | null;
  creatorPct?: number | null;
  holderCount?: number | null;
  liquidityUsd?: number | null;
  /** Ликвидность подтверждённо выведена. */
  liquidityRemoved?: boolean | null;
  knownMalicious?: boolean | null;
  deployerRugCount?: number | null;
  /** Кто ответил. Для происхождения значения. */
  source: string;
  /** Когда ответил. */
  checkedAt: number;
}

/** Порог, выше которого доля одного владельца считается провалом. */
export const OWNER_SHARE_FAIL_PCT = 50;
/** Налог на продажу выше этого — провал, а не замечание. */
export const SELL_TAX_FAIL_PCT = 15;
/** Меньше держателей — провал проверки на распределение. */
export const MIN_HOLDERS_PASS = 25;

/**
 * Статус по логическому полю.
 *
 * `true` у поля вида «это ханипот» означает провал, `false` —
 * прохождение, отсутствие — неизвестность. Три исхода, а не два.
 */
function fromNegativeFlag(value: boolean | null | undefined): SignalStatus {
  if (value == null) return 'unknown';
  return value ? 'failed' : 'passed';
}

/** Статус по числу с порогом. Отсутствие числа — неизвестность. */
function fromThreshold(
  value: number | null | undefined,
  fails: (v: number) => boolean,
): SignalStatus {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  return fails(value) ? 'failed' : 'passed';
}

/**
 * Сигналы из ответов провайдеров.
 *
 * Набор зависит от сети: проверка заморозки в EVM не существует,
 * и выдавать по ней `unknown` значило бы вечно держать набор
 * незакрытым. Такие проверки просто не входят в обязательный
 * список этой сети и здесь не порождаются.
 */
export function toRiskSignals(chain: ChainKey, facts: ProviderFacts): RiskSignal[] {
  const base = { source: facts.source, checkedAt: facts.checkedAt };
  const out: RiskSignal[] = [];

  const add = (
    code: string,
    status: SignalStatus,
    value: string | number | boolean | null | undefined,
    reason?: string,
  ) => {
    out.push({ code, status, value: value ?? null, ...base, reason });
  };

  // ─── Общее для всех сетей ────────────────────────────────────────

  // Ханипот. Симуляция продажи — более сильное подтверждение, чем
  // отсутствие флага: она означает, что продать пробовали и вышло.
  const honeypotStatus =
    facts.isHoneypot != null
      ? fromNegativeFlag(facts.isHoneypot)
      : facts.sellSimulated === true
        ? 'passed'
        : 'unknown';

  add(
    'honeypot',
    honeypotStatus,
    facts.isHoneypot,
    honeypotStatus === 'failed' ? 'Продажа отклоняется контрактом' : undefined,
  );

  add(
    'mint_authority',
    fromNegativeFlag(facts.mintable),
    facts.mintable,
    facts.mintable ? 'Владелец может допечатать токены' : undefined,
  );

  // Замок ликвидности: подтверждается либо флагом, либо долей
  // сожжённого. Одно из двух, но не «нет данных — значит заперта».
  const lpStatus: SignalStatus =
    facts.lpLocked != null
      ? facts.lpLocked
        ? 'passed'
        : 'failed'
      : facts.lpBurnedPct != null
        ? facts.lpBurnedPct >= 90
          ? 'passed'
          : 'failed'
        : 'unknown';

  add(
    'liquidity_locked',
    lpStatus,
    facts.lpLocked ?? facts.lpBurnedPct,
    lpStatus === 'failed' ? 'Ликвидность не заперта и не сожжена' : undefined,
  );

  const ownerShare = facts.creatorPct ?? facts.top10Pct;
  add(
    'owner_supply_share',
    fromThreshold(ownerShare, (v) => v > OWNER_SHARE_FAIL_PCT),
    ownerShare,
    ownerShare != null && ownerShare > OWNER_SHARE_FAIL_PCT
      ? `У одного адреса ${ownerShare.toFixed(0)}% предложения`
      : undefined,
  );

  // ─── Только EVM ──────────────────────────────────────────────────
  if (chain !== 'SOLANA') {
    add(
      'sell_tax',
      fromThreshold(facts.sellTaxPct, (v) => v > SELL_TAX_FAIL_PCT),
      facts.sellTaxPct,
      facts.sellTaxPct != null && facts.sellTaxPct > SELL_TAX_FAIL_PCT
        ? `Налог на продажу ${facts.sellTaxPct.toFixed(0)}%`
        : undefined,
    );
  }

  // ─── Только Solana ───────────────────────────────────────────────
  if (chain === 'SOLANA') {
    // Заморозка счёта: одна операция владельца делает токен
    // непродаваемым сразу у всех держателей.
    add(
      'freeze_authority',
      fromNegativeFlag(facts.freezable),
      facts.freezable,
      facts.freezable ? 'Владелец может заморозить счета держателей' : undefined,
    );

    add(
      'holder_count',
      fromThreshold(facts.holderCount, (v) => v < MIN_HOLDERS_PASS),
      facts.holderCount,
      facts.holderCount != null && facts.holderCount < MIN_HOLDERS_PASS
        ? `Держателей всего ${facts.holderCount}`
        : undefined,
    );
  }

  // ─── Необязательные, но решающие при провале ─────────────────────
  //
  // В обязательный набор они не входят: их отсутствие не мешает
  // сделать вывод. Но подтверждённый провал закрывает вопрос сразу.

  if (facts.liquidityRemoved != null) {
    add(
      'liquidity_removed',
      facts.liquidityRemoved ? 'failed' : 'passed',
      facts.liquidityRemoved,
      facts.liquidityRemoved ? 'Ликвидность выведена из пула' : undefined,
    );
  }

  if (facts.knownMalicious != null) {
    add(
      'known_malicious',
      facts.knownMalicious ? 'failed' : 'passed',
      facts.knownMalicious,
      facts.knownMalicious ? 'Контракт совпал с известным скамом' : undefined,
    );
  }

  if (facts.deployerRugCount != null) {
    add(
      'deployer_rug_history',
      facts.deployerRugCount > 0 ? 'failed' : 'passed',
      facts.deployerRugCount,
      facts.deployerRugCount > 0
        ? `Создатель уже увёл ликвидность ${facts.deployerRugCount} раз`
        : undefined,
    );
  }

  return out;
}
