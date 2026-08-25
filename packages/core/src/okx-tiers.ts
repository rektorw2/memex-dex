/**
 * Тарификация OKX Market API.
 *
 * ─── Откуда взято ───────────────────────────────────────────────────
 *
 * Таблица перенесена дословно с официальной страницы
 * https://web3.okx.com/onchainos/dev-docs/market/market-api-fee
 * (сверено 25 августа 2026). Ничего не выведено по смыслу и не угадано
 * по имени пути: категория endpoint определяется только этим списком.
 *
 * Это важно, потому что интуиция здесь ошибается. `market/price`
 * и `market/price-info` отличаются одним дефисом, лежат в одной
 * категории «Market» и возвращают похожие на вид данные — а стоят
 * по-разному и списываются из разных квот. Ровно на этой паре
 * и держался весь перерасход: живая цена шла через Premium, хотя
 * для неё есть Basic.
 *
 * ─── Что означают квоты ─────────────────────────────────────────────
 *
 * Basic и Premium — две независимые месячные квоты, а не общая.
 * Исчерпание одной не мешает другой, и складывать их в одно число
 * нельзя: на бесплатном тарифе это две сотни тысяч вызовов
 * с совершенно разной ценой перерасхода ($0.0001 против $0.0002).
 *
 * ─── Чего этот файл не знает ────────────────────────────────────────
 *
 * Сколько вызовов израсходовано на самом деле. OKX не отдаёт остаток
 * квоты через API, поэтому всё, что мы можем, — считать свои вызовы
 * сами. Такой счётчик обнуляется при перезапуске и не видит вызовов
 * из других процессов; выдавать его за официальный баланс нельзя.
 */

export type OkxTier = 'free' | 'basic' | 'premium';

/**
 * Категория каждого известного endpoint.
 *
 * Ключ — путь без строки запроса. Перечислены только те, которые
 * вызывает MEMEX, плюс соседи из той же таблицы, куда мы можем
 * потянуться завтра: неизвестный путь считается Premium (см. ниже),
 * и лишняя строка здесь дешевле неверной оценки.
 */
export const OKX_ENDPOINT_TIER: Readonly<Record<string, OkxTier>> = {
  // ─── Free: не расходуют квоту вовсе ───────────────────────────────
  '/api/v6/dex/market/supported/chain': 'free',
  '/api/v6/dex/market/signal/supported/chain': 'free',
  '/api/v6/dex/index/current-price': 'free',
  '/api/v6/dex/index/historical-price': 'free',
  '/api/v6/dex/balance/supported/chain': 'free',
  '/api/v6/dex/balance/total-value-by-address': 'free',
  '/api/v6/dex/balance/all-token-balances-by-address': 'free',
  '/api/v6/dex/balance/token-balances-by-address': 'free',
  '/api/v6/dex/post-transaction/transactions-by-address': 'free',
  '/api/v6/dex/post-transaction/transaction-detail-by-txhash': 'free',

  // ─── Basic: $0.0001 за вызов сверх квоты ──────────────────────────
  '/api/v6/dex/market/price': 'basic',
  '/api/v6/dex/market/trades': 'basic',
  '/api/v6/dex/market/token/top-liquidity': 'basic',
  '/api/v6/dex/market/token/hot-token': 'basic',
  '/api/v6/dex/market/candles': 'basic',
  '/api/v6/dex/market/token/search': 'basic',
  '/api/v6/dex/market/token/basic-info': 'basic',
  '/api/v6/dex/market/portfolio/token/latest-pnl': 'basic',
  '/api/v6/dex/market/portfolio/dex-history': 'basic',

  // ─── Premium: $0.0002 за вызов сверх квоты ────────────────────────
  '/api/v6/dex/market/price-info': 'premium',
  '/api/v6/dex/market/token/advanced-info': 'premium',
  '/api/v6/dex/market/historical-candles': 'premium',
  '/api/v6/dex/market/token/holder': 'premium',
  '/api/v6/dex/market/signal/list': 'premium',
  '/api/v6/dex/market/leaderboard/list': 'premium',
  '/api/v6/dex/market/portfolio/overview': 'premium',
  '/api/v6/dex/market/portfolio/recent-pnl': 'premium',
  '/api/v6/dex/market/token/top-trader': 'premium',
};

/**
 * Категория пути.
 *
 * Неизвестный путь считается Premium намеренно. Ошибиться можно
 * в обе стороны, и цена ошибок разная: посчитать Premium за Basic
 * значит недооценить расход и проснуться с исчерпанной квотой,
 * посчитать Basic за Premium — всего лишь притормозить фоновую
 * работу чуть раньше нужного.
 */
export function okxTierOf(path: string): OkxTier {
  // Строка запроса и двойные слэши в путях встречаются и в коде,
  // и в самой документации.
  const clean = path.split('?')[0]!.replace(/\/{2,}/g, '/');
  return OKX_ENDPOINT_TIER[clean] ?? 'premium';
}

/** Расходует ли вызов квоту. */
export function okxCountsAgainstQuota(tier: OkxTier): boolean {
  return tier !== 'free';
}

// ────────────────────────────── Тарифные планы ──────────────────────────────

export interface OkxPlanQuota {
  /** Вызовов Basic в месяц. */
  basic: number;
  /** Вызовов Premium в месяц. */
  premium: number;
  /**
   * Доступен ли WebSocket.
   *
   * На бесплатном тарифе — нет, и это официально. Отсюда следует
   * практический вывод, который дороже самой цифры: бесконечные
   * попытки переподключения на Free не «когда-нибудь получатся»,
   * они не получатся никогда, а параллельный REST-опрос при этом
   * тихо расходует Premium.
   */
  websocket: boolean;
  monthlyPriceUsd: number;
}

export const OKX_PLANS = {
  free: { basic: 100_000, premium: 100_000, websocket: false, monthlyPriceUsd: 0 },
  starter: { basic: 2_000_000, premium: 600_000, websocket: true, monthlyPriceUsd: 99 },
  growth: { basic: 5_000_000, premium: 2_000_000, websocket: true, monthlyPriceUsd: 199 },
  scale: { basic: 20_000_000, premium: 10_000_000, websocket: true, monthlyPriceUsd: 399 },
  pro: { basic: 50_000_000, premium: 20_000_000, websocket: true, monthlyPriceUsd: 599 },
} as const satisfies Record<string, OkxPlanQuota>;

export type OkxPlan = keyof typeof OKX_PLANS;

export const OKX_PLAN_NAMES = Object.keys(OKX_PLANS) as OkxPlan[];

export function okxPlanQuota(plan: OkxPlan): OkxPlanQuota {
  return OKX_PLANS[plan];
}

/**
 * Разбор названия плана из настроек.
 *
 * Неизвестное значение читается как бесплатный план. Это самый
 * осторожный выбор: опечатка в переменной окружения приведёт
 * к преждевременному замедлению фоновой работы, а не к молчаливому
 * перерасходу чужих денег.
 */
export function parseOkxPlan(raw: string | null | undefined): OkxPlan {
  const value = (raw ?? '').trim().toLowerCase();
  return (OKX_PLAN_NAMES as string[]).includes(value) ? (value as OkxPlan) : 'free';
}

/**
 * Наибольшее число адресов в одном пакетном запросе.
 *
 * Документация называет сотню явно для `price-info`. Для `price`
 * предела в описании нет, но тело там — массив того же вида, и просить
 * больше документированного максимума соседнего endpoint значит
 * гадать. Сотня и там и там.
 */
export const OKX_MAX_BATCH = 100;

/** Сколько запросов нужно, чтобы обойти столько адресов. */
export function okxBatchCount(addresses: number, batchSize: number = OKX_MAX_BATCH): number {
  return addresses <= 0 ? 0 : Math.ceil(addresses / batchSize);
}
