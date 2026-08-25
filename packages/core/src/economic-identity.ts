/**
 * Что считать одной экономической сделкой.
 *
 * ─── Что было сломано ───────────────────────────────────────────────
 *
 * Ключ канонической сделки собирался из
 * `chain|wallet|token|side|tradedAt|amount|valueUsd|price`.
 * Суммы и цена входили в саму идентичность, и из этого следовали
 * оба дефекта, видимые на живой странице.
 *
 * Первый: несколько fill'ов одной транзакции — одна миллисекунда,
 * один токен, одна сторона, разные суммы — давали разные ключи,
 * то есть несколько «завершённых сделок». Отсюда повторы одной
 * покупки в подробностях кошелька и раздутые `wins2x`,
 * `avgPeakMultiple` (4130×) и Smart Score.
 *
 * Второй: повторный импорт с другим округлением `price` или
 * `valueUsd` менял ключ и создавал новую запись. Дедупликация
 * по ключу при этом честно не срабатывала — сравнивать было нечего.
 *
 * ─── Почему нельзя просто взять txHash ──────────────────────────────
 *
 * Источников два, и они дают разную идентичность.
 *
 *   Живая лента (`address-tracker/trades`) отдаёт `txHash`.
 *   Это сильная идентичность, и она используется.
 *
 *   История (`portfolio/dex-history`) не отдаёт ни хеша транзакции,
 *   ни идентификатора события — сверено по официальной документации
 *   25.08.2026. Полный список её полей: type, chainIndex,
 *   tokenContractAddress, tokenSymbol, valueUsd, amount, price,
 *   marketCap, pnlUsd, time.
 *
 * Выдумывать хеш нельзя. Поэтому у истории своя, слабее, но
 * детерминированная идентичность — и она устроена так, чтобы
 * округление на неё не влияло.
 */

import { normalizeAddress, type ChainKey } from './token-registry.js';

/** Откуда пришла сделка. Идентичность у источников разная. */
export const TRADE_SOURCES = ['okx_live', 'okx_dex_history'] as const;
export type TradeSource = (typeof TRADE_SOURCES)[number];

// ────────────────────────── Живая лента: сильный ключ ───────────────────────

/**
 * Ключ live-сделки.
 *
 * Хеш транзакции плюс сторона плюс токен. Токен нужен потому, что
 * одна транзакция может задеть несколько токенов: своп — это
 * одновременно продажа одного и покупка другого, и без адреса
 * обе половины схлопнулись бы в одну запись.
 *
 * `logIndex` в ключ не входит: провайдер его не отдаёт. Место под
 * него оставлено — когда отдаст, он встанет сюда и сделает
 * идентичность точной до отдельного перевода внутри транзакции.
 */
export function liveTradeKey(input: {
  chain: ChainKey;
  txHash: string;
  side: 'BUY' | 'SELL';
  tokenAddress: string;
  logIndex?: number | null;
}): string {
  const token = normalizeAddress(input.chain, input.tokenAddress);

  return [
    'okx_live',
    input.chain,
    input.txHash,
    input.side,
    token,
    ...(input.logIndex != null ? [String(input.logIndex)] : []),
  ].join('|');
}

// ──────────────────────── История: ключ группы fill'ов ──────────────────────

/**
 * Ширина окна группировки, миллисекунды.
 *
 * Ноль — точное совпадение отметки времени, и это осознанный выбор,
 * а не осторожность по умолчанию.
 *
 * Документация называет `time` отметкой транзакции. Все переводы
 * одной транзакции получают от провайдера одно и то же значение —
 * ровно это и видно на живой странице: повторы одной покупки стоят
 * с одинаковым временем. Значит точного равенства достаточно,
 * и расширять окно значит рисковать склейкой двух настоящих
 * транзакций без всякой нужды.
 *
 * Параметр оставлен настраиваемым: если у какой-то сети окажется
 * дрожание отметки, окно можно будет расширить, не трогая ключ.
 */
export const DEFAULT_FILL_BUCKET_MS = 0;

/**
 * Ключ группы fill'ов из истории.
 *
 * Ни `amount`, ни `valueUsd`, ни `price` в ключ не входят.
 * Это главное свойство: округление на стороне провайдера меняет
 * суммы, но не меняет того, какой это был перевод.
 */
export function historyTradeKey(input: {
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  side: 'BUY' | 'SELL';
  tradedAt: number;
  bucketMs?: number;
}): string {
  const bucket = input.bucketMs ?? DEFAULT_FILL_BUCKET_MS;

  const stamp =
    bucket > 0
      ? Math.floor(Math.trunc(input.tradedAt) / bucket) * bucket
      : Math.trunc(input.tradedAt);

  return [
    'okx_dex_history',
    input.chain,
    normalizeAddress(input.chain, input.wallet),
    normalizeAddress(input.chain, input.tokenAddress),
    input.side,
    stamp,
  ].join('|');
}

// ─────────────────────────── Сложение fill'ов ───────────────────────────────

export interface TradeFill {
  amount: string;
  valueUsd: string;
  price: string;
  marketCapUsd?: string | null;
  providerPnlUsd?: string | null;
  tradedAt: number;
  tokenSymbol?: string | null;
}

export interface AggregatedTrade {
  amount: string;
  valueUsd: string;
  /** Средневзвешенная по объёму. */
  price: string;
  marketCapUsd: string | null;
  /** Результат по версии провайдера. Диагностика, не наш PnL. */
  providerPnlUsd: string | null;
  tokenSymbol: string | null;
  /** Сколько переводов вошло в сделку. */
  fillCount: number;
  firstFillAt: number;
  lastFillAt: number;
  /**
   * Сложить не удалось — считать такую сделку нельзя.
   *
   * Не «показать ноль» и не «взять первый fill»: неполная группа
   * исключается из статистики до выяснения, а не подменяется
   * правдоподобным числом.
   */
  ambiguous: boolean;
  ambiguityReason: string | null;
}

/** Точность внутреннего сложения. Хватает на восемнадцать знаков токена. */
const SCALE = 24;

function toScaled(value: string): bigint | null {
  const s = (value ?? '').trim();
  if (!s) return null;

  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [whole = '0', frac = ''] = body.split('.');

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (whole === '' && frac === '') return null;

  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const result = BigInt(whole || '0') * 10n ** BigInt(SCALE) + BigInt(padded || '0');

  return negative ? -result : result;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(SCALE);

  const whole = abs / base;
  const frac = (abs % base).toString().padStart(SCALE, '0').replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Сложить переводы одной транзакции в одну сделку.
 *
 * Количество и стоимость складываются, цена считается
 * средневзвешенной по объёму — брать цену первого перевода значило бы
 * приписать всей сделке случайную из нескольких.
 *
 * Складывается в целых числах фиксированной точности, а не
 * в `number`: суммы токенов бывают с восемнадцатью знаками, и на них
 * двоичная плавающая точка теряет разряды молча.
 */
export function aggregateFills(fills: TradeFill[]): AggregatedTrade {
  const empty: AggregatedTrade = {
    amount: '0',
    valueUsd: '0',
    price: '0',
    marketCapUsd: null,
    providerPnlUsd: null,
    tokenSymbol: null,
    fillCount: 0,
    firstFillAt: 0,
    lastFillAt: 0,
    ambiguous: true,
    ambiguityReason: 'EMPTY_GROUP',
  };

  if (fills.length === 0) return empty;

  let amount = 0n;
  let valueUsd = 0n;
  let providerPnl = 0n;
  let hasProviderPnl = false;

  for (const f of fills) {
    const a = toScaled(f.amount);
    const v = toScaled(f.valueUsd);

    // Нечисловая сумма — это не ноль. Группу с такой строкой считать
    // нельзя: она даст заниженный объём, который выглядит настоящим.
    if (a == null || v == null) {
      return { ...empty, fillCount: fills.length, ambiguityReason: 'UNPARSABLE_AMOUNT' };
    }

    amount += a;
    valueUsd += v;

    const pnl = f.providerPnlUsd != null ? toScaled(f.providerPnlUsd) : null;
    if (pnl != null) {
      providerPnl += pnl;
      hasProviderPnl = true;
    }
  }

  const ordered = [...fills].sort((x, y) => x.tradedAt - y.tradedAt);
  const last = ordered.at(-1)!;

  /*
   * Средневзвешенная цена.
   *
   * При нулевом количестве вычислить её нельзя, и подставлять цену
   * первого перевода было бы выдумкой. Такая группа помечается
   * неоднозначной и в статистику не идёт.
   */
  const price =
    amount === 0n
      ? null
      : fromScaled((valueUsd * 10n ** BigInt(SCALE)) / amount);

  return {
    amount: fromScaled(amount),
    valueUsd: fromScaled(valueUsd),
    price: price ?? '0',
    // Капитализация берётся у последнего перевода: она относится
    // к моменту, а не к объёму, и складывать её бессмысленно.
    marketCapUsd: last.marketCapUsd ?? null,
    providerPnlUsd: hasProviderPnl ? fromScaled(providerPnl) : null,
    tokenSymbol: ordered.find((f) => f.tokenSymbol)?.tokenSymbol ?? null,
    fillCount: fills.length,
    firstFillAt: ordered[0]!.tradedAt,
    lastFillAt: last.tradedAt,
    ambiguous: price == null,
    ambiguityReason: price == null ? 'ZERO_TOTAL_AMOUNT' : null,
  };
}

/**
 * Сгруппировать переводы истории по ключу.
 *
 * Возвращает карту «ключ → переводы». Сложение делается отдельно,
 * чтобы группировку можно было проверить саму по себе.
 */
export function groupHistoryFills<T extends TradeFill & {
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  side: 'BUY' | 'SELL';
}>(fills: T[], bucketMs = DEFAULT_FILL_BUCKET_MS): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const f of fills) {
    const key = historyTradeKey({
      chain: f.chain,
      wallet: f.wallet,
      tokenAddress: f.tokenAddress,
      side: f.side,
      tradedAt: f.tradedAt,
      bucketMs,
    });

    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }

  return groups;
}

// ───────────────── Сопоставление истории с живой сделкой ────────────────────

export interface LiveCandidate {
  key: string;
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  side: 'BUY' | 'SELL';
  tradedAt: number;
  /** Совокупный объём live-сделки, если известен. */
  amount?: string | null;
}

export type ReconcileVerdict =
  | { kind: 'matched'; liveKey: string }
  | { kind: 'unmatched' }
  | { kind: 'ambiguous'; candidates: number };

/**
 * Насколько близко по времени историческая группа может стоять
 * к живой сделке, чтобы считаться той же.
 *
 * История и лента заполняются разными путями, и отметка времени
 * у них может разойтись на секунды. Минута — с запасом, но заметно
 * меньше прежних двух: чем шире окно, тем выше шанс поймать соседнюю
 * транзакцию того же кошелька.
 */
export const RECONCILE_WINDOW_MS = 60_000;

/**
 * Найти живую сделку для исторической группы.
 *
 * Три правила, и каждое из них когда-то нарушалось.
 *
 * Первое: совпадение обязано быть однозначным. Два кандидата —
 * это `ambiguous`, а не «возьмём первый». Первый подходящий выбирали
 * прежним `trades.find(...)`, и он же мог достаться второй группе.
 *
 * Второе: занятая live-сделка больше не кандидат. Без этого одна
 * транзакция применялась к учёту столько раз, сколько нашлось
 * похожих событий.
 *
 * Третье: сверяются сеть, кошелёк, токен, сторона и время. Прежнее
 * сопоставление смотрело только на токен, сторону и окно ±2 минуты —
 * то есть могло связать события разных кошельков.
 */
export function reconcileHistoryGroup(
  group: {
    chain: ChainKey;
    wallet: string;
    tokenAddress: string;
    side: 'BUY' | 'SELL';
    tradedAt: number;
  },
  candidates: LiveCandidate[],
  taken: ReadonlySet<string>,
  windowMs: number = RECONCILE_WINDOW_MS,
): ReconcileVerdict {
  const wallet = normalizeAddress(group.chain, group.wallet);
  const token = normalizeAddress(group.chain, group.tokenAddress);

  const fits = candidates.filter(
    (c) =>
      !taken.has(c.key) &&
      c.chain === group.chain &&
      normalizeAddress(c.chain, c.wallet) === wallet &&
      normalizeAddress(c.chain, c.tokenAddress) === token &&
      c.side === group.side &&
      Math.abs(c.tradedAt - group.tradedAt) <= windowMs,
  );

  if (fits.length === 0) return { kind: 'unmatched' };
  if (fits.length > 1) return { kind: 'ambiguous', candidates: fits.length };

  return { kind: 'matched', liveKey: fits[0]!.key };
}

/** Состояние сверки сделки. Хранится в базе и видно в диагностике. */
export const RECONCILIATION_STATES = [
  /** Единственная запись про это событие. */
  'canonical',
  /** Историческая группа подтверждена live-сделкой с хешем. */
  'confirmed',
  /** Совпадений несколько — в статистику не идёт. */
  'ambiguous',
  /** Старая запись, свёрнутая в каноническую. */
  'superseded',
] as const;

export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

/**
 * Состояния, попадающие в расчёт.
 *
 * Отдельным списком, а не условием в каждом запросе: условие,
 * написанное дважды, однажды разойдётся, и одна из двух витрин
 * начнёт считать свёрнутые записи заново.
 */
export const STATS_RECONCILIATION_STATES = ['canonical', 'confirmed'] as const;

/** Учитывается ли сделка в статистике. */
export function countsTowardStats(state: ReconciliationState): boolean {
  return (STATS_RECONCILIATION_STATES as readonly string[]).includes(state);
}
