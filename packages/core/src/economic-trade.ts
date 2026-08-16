/**
 * Экономическая сделка: что считать сделкой, а что нет.
 *
 * Самая недооценённая часть всего расчёта. Пока каждое событие swap
 * считается сделкой, любая статистика по кошельку неверна — причём
 * неверна незаметно, потому что числа выглядят правдоподобно.
 *
 * Три источника искажения, и все три встречаются постоянно.
 *
 * Маршрутизация. Один обмен через агрегатор порождает три-четыре
 * события: заход в промежуточный токен, обмен, выход. Считая их
 * отдельными сделками, мы получаем кошелёк с втрое большим числом
 * операций и разбавленной статистикой, где две трети «сделок» —
 * это одна и та же покупка.
 *
 * Неторговые поступления. Аирдроп выглядит как приход токена
 * с нулевой ценой входа. Дальше любой рост считается бесконечной
 * прибылью, и кошелёк, получивший бесплатный токен, оказывается
 * гением. То же с переводами между своими адресами: токен «куплен»
 * на одном и «продан» на другом, обе половины врут.
 *
 * Мостовые и биржевые операции. Ввод с биржи — это не покупка,
 * а перемещение уже имеющегося. Считать его входом значит приписать
 * кошельку цену входа, которой не было.
 *
 * Здесь всё это отделяется до того, как числа попадут в расчёт.
 */

export type TradeSide = 'BUY' | 'SELL';

/**
 * Вид операции.
 *
 * Перечень намеренно подробный: «прочее» скрывает ошибки разбора,
 * а отдельный вид позволяет посчитать, сколько именно операций
 * мы не поняли, и увидеть, если их доля вдруг выросла.
 */
export type OperationKind =
  | 'swap'
  | 'transfer'
  | 'airdrop'
  | 'bridge'
  | 'staking'
  | 'liquidity'
  | 'reward'
  | 'mint'
  | 'burn'
  | 'cex'
  | 'failed'
  | 'unknown';

/** Виды, которые участвуют в расчёте результата кошелька. */
export const TRADEABLE_KINDS: OperationKind[] = ['swap'];

export function isTradeable(kind: OperationKind): boolean {
  return TRADEABLE_KINDS.includes(kind);
}

/**
 * Сырое событие от поставщика данных.
 *
 * Намеренно бедное: это то, что можно получить от любого источника,
 * не завися от формата конкретного. Всё, чего здесь нет, вычисляется
 * или приходит отдельно.
 */
export interface RawEvent {
  chain: string;
  wallet: string;
  /** Хеш транзакции или подпись. Ключ склейки маршрутных шагов. */
  txHash: string;
  tokenAddress: string;
  side: TradeSide;
  /** Количество токена. Всегда положительное. */
  tokenAmount: number;
  amountUsd: number | null;
  timestamp: number;
  kind: OperationKind;
  /**
   * Насколько мы уверены в разборе события: 0–1.
   *
   * Нужна потому, что источники разбирают транзакции по-разному,
   * и событие с низкой уверенностью не должно молча влиять
   * на статистику наравне с однозначным.
   */
  parsingConfidence?: number;
  /** Контрагент: адрес пула, моста, биржи. */
  counterparty?: string | null;
  /** Токен считается промежуточным в маршруте агрегатора. */
  isIntermediate?: boolean;
  source?: string;
}

/**
 * Экономическая сделка — результат склейки событий.
 *
 * Одна запись означает одно решение человека: купить или продать
 * конкретный токен. Сколько технических шагов за этим стоит,
 * значения не имеет.
 */
export interface EconomicTrade {
  chain: string;
  wallet: string;
  tokenAddress: string;
  side: TradeSide;
  tokenAmount: number;
  amountUsd: number;
  /** Цена исполнения, выведенная из суммы и количества. */
  priceUsd: number | null;
  timestamp: number;
  txHash: string;
  /** Сколько событий склеилось в эту сделку. */
  legs: number;
  parsingConfidence: number;
  source: string | null;
}

/** Порог, ниже которого сделка считается пылью и в расчёт не идёт. */
export const DUST_USD = 1;

/**
 * Ключ склейки.
 *
 * Сеть, транзакция, кошелёк, токен и направление. Направление
 * входит намеренно: в одной транзакции бывает и покупка, и продажа
 * одного токена (арбитраж внутри блока), и склеивать их в одну
 * запись значит потерять обе.
 */
export function mergeKey(e: {
  chain: string;
  txHash: string;
  wallet: string;
  tokenAddress: string;
  side: TradeSide;
}): string {
  return [e.chain, e.txHash, e.wallet.toLowerCase(), e.tokenAddress.toLowerCase(), e.side].join(
    '|',
  );
}

export interface NormalizeResult {
  trades: EconomicTrade[];
  /** Что и почему отброшено. Нужно, чтобы фильтр можно было проверить. */
  rejected: Record<string, number>;
}

/**
 * Свести поток событий к экономическим сделкам.
 *
 * Порядок важен: сначала отсев неторгового, потом склейка. Обратный
 * порядок склеил бы аирдроп с настоящей покупкой в одной транзакции.
 */
export function normalizeTrades(events: RawEvent[]): NormalizeResult {
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  const groups = new Map<string, RawEvent[]>();

  for (const e of events) {
    if (!isTradeable(e.kind)) {
      reject(e.kind);
      continue;
    }

    // Промежуточный токен маршрута — это техническая деталь обмена,
    // а не то, что кошелёк решил купить.
    if (e.isIntermediate) {
      reject('intermediate');
      continue;
    }

    if (e.amountUsd == null || !Number.isFinite(e.amountUsd)) {
      // Без суммы в долларах сделка не участвует в расчёте: цена
      // входа неизвестна, и любой вывод о прибыли будет выдуман.
      reject('no_usd_value');
      continue;
    }

    if (e.tokenAmount <= 0 || !Number.isFinite(e.tokenAmount)) {
      reject('bad_amount');
      continue;
    }

    const key = mergeKey(e);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const trades: EconomicTrade[] = [];

  for (const list of groups.values()) {
    const first = list[0]!;

    const tokenAmount = list.reduce((s, e) => s + e.tokenAmount, 0);
    const amountUsd = list.reduce((s, e) => s + (e.amountUsd ?? 0), 0);

    if (amountUsd < DUST_USD) {
      reject('dust');
      continue;
    }

    // Уверенность разбора склеенной сделки — минимальная среди частей:
    // одна плохо разобранная нога делает сомнительной всю сделку.
    const confidence = list.reduce((m, e) => Math.min(m, e.parsingConfidence ?? 1), 1);

    trades.push({
      chain: first.chain,
      wallet: first.wallet,
      tokenAddress: first.tokenAddress,
      side: first.side,
      tokenAmount,
      amountUsd,
      priceUsd: tokenAmount > 0 ? amountUsd / tokenAmount : null,
      // Время первой ноги: решение принято в её момент, остальное —
      // исполнение.
      timestamp: Math.min(...list.map((e) => e.timestamp)),
      txHash: first.txHash,
      legs: list.length,
      parsingConfidence: confidence,
      source: first.source ?? null,
    });
  }

  trades.sort((a, b) => a.timestamp - b.timestamp);

  return { trades, rejected };
}

// ──────────────────── Определение вида операции ─────────────────────────────

/**
 * Признаки, по которым событие опознаётся как неторговое.
 *
 * Функция вынесена отдельно от нормализации, потому что источники
 * сообщают вид по-разному: у одного есть поле type, у другого
 * приходится смотреть на контрагента. Здесь собраны признаки,
 * общие для всех.
 */
export interface KindHints {
  /** Вид, если источник его сообщил. */
  providerKind?: string | null;
  /** Транзакция завершилась ошибкой. */
  failed?: boolean;
  /** Контрагент опознан как биржа, мост, роутер. */
  counterpartyType?: 'cex' | 'bridge' | 'router' | 'pool' | 'contract' | null;
  /** Токен пришёл без встречной оплаты. */
  hasNoCounterValue?: boolean;
  /** Отправитель и получатель — связанные адреса одного владельца. */
  isSelfTransfer?: boolean;
}

export function classifyOperation(h: KindHints): OperationKind {
  // Неудавшаяся транзакция не меняла состояния и в статистику
  // не входит ни в каком виде.
  if (h.failed) return 'failed';

  if (h.isSelfTransfer) return 'transfer';

  switch (h.counterpartyType) {
    case 'cex':
      return 'cex';
    case 'bridge':
      return 'bridge';
    case 'pool':
      return 'swap';
    default:
      break;
  }

  const provider = (h.providerKind ?? '').toLowerCase();

  if (provider.includes('airdrop')) return 'airdrop';
  if (provider.includes('bridge')) return 'bridge';
  if (provider.includes('stake')) return 'staking';
  if (provider.includes('liquidity') || provider.includes('lp')) return 'liquidity';
  if (provider.includes('reward') || provider.includes('claim')) return 'reward';
  if (provider.includes('mint')) return 'mint';
  if (provider.includes('burn')) return 'burn';
  if (provider.includes('swap') || provider.includes('trade')) return 'swap';
  if (provider.includes('transfer')) return 'transfer';

  // Токен пришёл, а встречной оплаты не было. Это не покупка:
  // цены входа не существует, и считать её нулём означало бы
  // объявить любой рост бесконечной прибылью.
  if (h.hasNoCounterValue) return 'airdrop';

  return 'unknown';
}
