/**
 * Токенизированные акции: настоящие и поддельные.
 *
 * Это самый неприятный класс подделок из всех. Обычный скам виден
 * по контракту: активный mint, налог на продажу, незалоченный пул.
 * Подделка под NVDA может быть безупречна технически — сожжённая
 * ликвидность, отозванная эмиссия, нулевые налоги — и при этом
 * не иметь ни малейшего отношения к NVIDIA. Проверка контракта
 * тут не помогает вовсе, потому что обманывают не контрактом.
 *
 * Обманывают именем. И различить настоящий токенизированный актив
 * от поддельного можно ровно одним способом: сверить пару
 * «сеть + адрес» со списком эмитента. Никакие свойства самого токена
 * ответа не дают — их все можно подделать.
 *
 * Отсюда устройство модуля. Список подтверждённых RWA приходит извне
 * (у нас — из OKX) и передаётся сюда как данные. Модуль не ходит
 * в сеть и ничего не кеширует: он отвечает на вопрос «этот адрес есть
 * в списке» и на второй вопрос, куда более важный, — «этот токен
 * притворяется акцией, не будучи ей».
 *
 * Отдельная тонкость про настоящие RWA: у них концентрация владения
 * почти всегда высокая, и это норма. Эмитент держит обеспечение,
 * а не готовит обвал. Применять к ним правила, написанные для
 * мем-коинов, значит блокировать именно те активы, ради безопасности
 * которых всё и затевалось.
 */

import type { ChainKey } from './token-registry.js';
import { normalizeAddress, normalizeSymbol, tokenKey } from './token-registry.js';

// ────────────────────── Тикеры, которые нельзя носить ───────────────────────

/**
 * Тикеры публичных акций и биржевых фондов.
 *
 * Список заведомо неполон и таким останется: акций тысячи, а ловит он
 * то, что подделывают. Полнота недостижима, и гнаться за ней здесь
 * вреднее, чем полезно — каждый добавленный тикер это ещё один шанс
 * заблокировать честный мем-коин, который случайно назвали так же.
 *
 * Поэтому в списке только то, подделка подо что осмысленна: крупные
 * технологические компании, популярные у розничного инвестора бумаги
 * и основные индексные фонды. Мем-коин с тикером трёхбуквенной
 * компании из второго эшелона никого не обманет, а вот заблокировать
 * его этим списком было бы легко.
 */
export const STOCK_TICKERS = new Set([
  // Крупные технологические компании
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOG', 'GOOGL',
  'AMD', 'INTC', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'AVGO', 'QCOM',
  // Популярные у розницы
  'HOOD', 'COIN', 'MSTR', 'PLTR', 'GME', 'AMC', 'SOFI', 'RIVN',
  'LCID', 'NIO', 'BABA', 'DIS', 'UBER', 'ABNB', 'SNAP', 'SNDK',
  // Биржевые фонды и индексы
  'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'ARKK', 'TQQQ',
  // Финансовый сектор
  'JPM', 'BAC', 'GS', 'MS', 'BRK', 'BRKA', 'BRKB',
  // Прочее часто подделываемое
  'IPO', 'WMT', 'KO', 'PEP', 'MCD', 'NKE', 'PFE', 'JNJ',
]);

/**
 * Подтверждённый токенизированный актив.
 *
 * Приходит из списка эмитента. Поле issuer сохраняется, потому что
 * человеку важно видеть, чьё обеспечение стоит за токеном: xStocks
 * и Ondo — разные компании с разными условиями выкупа.
 */
export interface RwaEntry {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  /** xStocks, Ondo и прочие. */
  issuer: string | null;
  /** Тикер базовой бумаги, если отличается от тикера токена. */
  underlying: string | null;
}

/**
 * Список подтверждённых RWA в виде, пригодном для поиска.
 *
 * Строится один раз при обновлении списка, а не при каждой проверке:
 * проверок тысячи, обновлений — несколько в сутки.
 */
export class RwaRegistry {
  private readonly byKey = new Map<string, RwaEntry>();
  private readonly bySymbol = new Map<string, RwaEntry[]>();
  readonly updatedAt: Date;
  readonly size: number;

  constructor(entries: RwaEntry[], updatedAt = new Date()) {
    for (const e of entries) {
      const key = tokenKey(e.chain, e.address);
      this.byKey.set(key, e);

      const sym = normalizeSymbol(e.symbol);
      const list = this.bySymbol.get(sym) ?? [];
      list.push(e);
      this.bySymbol.set(sym, list);

      // Базовая бумага индексируется отдельно: токен tNVDA
      // с underlying NVDA должен находиться по обоим.
      if (e.underlying) {
        const u = normalizeSymbol(e.underlying);
        if (u !== sym) {
          const ul = this.bySymbol.get(u) ?? [];
          ul.push(e);
          this.bySymbol.set(u, ul);
        }
      }
    }
    this.updatedAt = updatedAt;
    this.size = this.byKey.size;
  }

  get(chain: ChainKey, address: string): RwaEntry | null {
    return this.byKey.get(tokenKey(chain, address)) ?? null;
  }

  has(chain: ChainKey, address: string): boolean {
    return this.byKey.has(tokenKey(chain, address));
  }

  /** Подтверждённые токены с таким тикером — во всех сетях. */
  bySymbolAll(symbol: string): RwaEntry[] {
    return this.bySymbol.get(normalizeSymbol(symbol)) ?? [];
  }

  /**
   * Пуст ли список.
   *
   * Отдельный вопрос, потому что пустой список означает не «настоящих
   * RWA не существует», а «мы их не загрузили». Это разные вещи,
   * и вести себя при них надо по-разному.
   */
  get isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}

/** Пустой реестр: список не загружен. */
export const EMPTY_RWA_REGISTRY = new RwaRegistry([]);

// ───────────────────────────── Проверка ─────────────────────────────────────

export interface RwaVerdict {
  /** Подтверждённый токенизированный актив. */
  isGenuineRwa: boolean;
  /** Носит тикер известной бумаги, не будучи подтверждённым. */
  isFakeRwa: boolean;
  /**
   * Проверить не удалось: тикер похож на бумагу, но список подтверждённых
   * не загружен. Не то же самое, что подделка, и не то же самое, что норма.
   */
  isUndetermined: boolean;
  entry: RwaEntry | null;
  reason: string | null;
}

export interface RwaCheckInput {
  chain: ChainKey;
  address: string;
  symbol: string;
  /** Теги из advanced-info: подтверждённый RWA-тег усиливает вывод. */
  tags?: string[];
  /** Признан сообществом по мнению OKX. */
  communityRecognized?: boolean;
}

/** Признаки токенизированного актива в тегах. */
const RWA_TAG_HINTS = ['rwa', 'xstock', 'ondo', 'tokenizedstock', 'stock', 'equity'];

function hasRwaHint(tags: string[] | undefined): boolean {
  if (!tags?.length) return false;
  return tags.some((t) => {
    const lower = t.toLowerCase();
    return RWA_TAG_HINTS.some((h) => lower.includes(h));
  });
}

/**
 * Настоящий это токенизированный актив или подделка под него.
 *
 * Порядок проверок отражает, чему мы доверяем больше. Список эмитента
 * важнее тега: тег ставит агрегатор по своим соображениям, а список
 * ведёт тот, кто выпускает бумагу. Тег без списка — повод не блокировать
 * молча, но и не признавать: такой токен уходит в «не определено».
 */
export function checkRwa(input: RwaCheckInput, registry: RwaRegistry): RwaVerdict {
  const entry = registry.get(input.chain, input.address);

  // Адрес в списке эмитента. Дальше можно не смотреть: это он и есть.
  if (entry) {
    return {
      isGenuineRwa: true,
      isFakeRwa: false,
      isUndetermined: false,
      entry,
      reason: null,
    };
  }

  const sym = normalizeSymbol(input.symbol);
  const claimsStock = STOCK_TICKERS.has(sym) || registry.bySymbolAll(sym).length > 0;

  if (!claimsStock && !hasRwaHint(input.tags)) {
    // Обычный токен, на бумагу не претендует.
    return {
      isGenuineRwa: false,
      isFakeRwa: false,
      isUndetermined: false,
      entry: null,
      reason: null,
    };
  }

  // Претендует на бумагу, но списка у нас нет. Объявлять подделкой
  // нельзя — мы просто не проверили. Объявлять нормой тоже нельзя.
  if (registry.isEmpty) {
    return {
      isGenuineRwa: false,
      isFakeRwa: false,
      isUndetermined: true,
      entry: null,
      reason:
        `Тикер ${input.symbol} совпадает с биржевой бумагой, ` +
        'а список подтверждённых токенизированных активов не загружен — проверить нечем',
    };
  }

  // Список есть, адреса в нём нет. Вот это уже подделка, и утверждать
  // это можно уверенно: настоящий токенизированный NVDA обязан быть
  // в списке своего эмитента.
  // Если настоящий выпуск нам известен, показываем его адрес: человеку
  // нужен не только запрет, но и то, куда идти вместо запрещённого.
  const genuine = registry.bySymbolAll(sym)[0];
  const where = genuine
    ? ` Настоящий выпущен по адресу ${shortAddr(genuine.address)}` +
      (genuine.issuer ? ` (${genuine.issuer})` : '') +
      '.'
    : '';

  return {
    isGenuineRwa: false,
    isFakeRwa: true,
    isUndetermined: false,
    entry: null,
    reason:
      `Токен носит тикер ${input.symbol}, но его контракт отсутствует ` +
      `в списке подтверждённых токенизированных активов.${where}`,
  };
}

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Применимы ли к токену правила концентрации владения.
 *
 * У подтверждённого RWA эмитент держит основную часть выпуска —
 * это обеспечение, а не подготовка к обвалу. Считать это признаком
 * захвата значит блокировать именно те активы, которые надёжнее всего.
 */
export function concentrationRulesApply(verdict: RwaVerdict): boolean {
  return !verdict.isGenuineRwa;
}

/** Разбор записи из ответа OKX rwa/tokens в запись реестра. */
export function parseRwaEntry(
  raw: unknown,
  chainFromIndex: (i: unknown) => ChainKey | null,
): RwaEntry | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const chain = chainFromIndex(r.chainIndex);
  const addr = typeof r.tokenContractAddress === 'string' ? r.tokenContractAddress.trim() : '';
  if (!chain || !addr) return null;

  const symbol = typeof r.tokenSymbol === 'string' ? r.tokenSymbol.trim() : '';
  if (!symbol) return null;

  return {
    chain,
    address: normalizeAddress(chain, addr),
    symbol,
    name: typeof r.tokenName === 'string' ? r.tokenName.trim() : symbol,
    issuer:
      typeof r.issuer === 'string'
        ? r.issuer.trim()
        : typeof r.provider === 'string'
          ? r.provider.trim()
          : null,
    underlying:
      typeof r.underlyingSymbol === 'string'
        ? r.underlyingSymbol.trim()
        : typeof r.stockSymbol === 'string'
          ? r.stockSymbol.trim()
          : null,
  };
}
