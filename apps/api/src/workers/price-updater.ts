import { Prisma as P } from '@prisma/client';
import {
  cycleVerdict,
  mergeReports,
  EMPTY_PROVIDER_REPORT,
  type ChainKey,
  type CycleVerdict,
  type OkxCallPurpose,
  type ProviderReport,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { getAdapter } from '../chains/index.js';
import { logger } from '../lib/logger.js';
import { fetchLivePrices } from '../services/okx-market.js';
import { recordOkxSignalLivePeak } from '../services/okx-signal-ath.js';
import { hotTokens } from './hot-tokens.js';
import { okxSlowdown } from '../services/okx-usage.js';

/**
 * Обновление цен.
 *
 * ─── Что было сломано ───────────────────────────────────────────────
 *
 * Прежний воркер брал `where: { isVerified: true }`. Импортёр же
 * заводит токены строкой `isVerified: false` — намеренно, проверка
 * остаётся за человеком. Из этого следует, что вся витрина и весь
 * радар не получали обновления цены никогда: не «редко», как это
 * выглядело снаружи, а вовсе.
 *
 * Единственные цены, которые у них были, писала проверка витрины —
 * раз в сутки, попутно, из сверки источников.
 *
 * Дальше по мелочи, но в ту же сторону: `take: 500` без сортировки
 * означал, что база отдавала один и тот же произвольный срез,
 * а хвост списка не обновлялся, даже будучи проверенным.
 *
 * ─── Как устроено теперь ────────────────────────────────────────────
 *
 * Два цикла вместо одного, потому что вопросов два.
 *
 *   Горячий  — то, на что человек смотрит сию секунду: открытая
 *              карточка, видимый список, свежая находка радара,
 *              открытая позиция. Несколько секунд.
 *
 *   Холодный — всё остальное, по кругу и по возрасту котировки.
 *              Десятки секунд, зато честно доходит до каждого.
 *
 * Разделение важнее частоты. Обновлять полторы тысячи токенов раз
 * в три секунды нельзя ни при каком лимите провайдера, а обновлять
 * открытую карточку раз в минуту бессмысленно.
 */

/**
 * Как часто обновляется открытый график.
 *
 * Пять секунд, а не секунда. Разница в расходе пятикратная,
 * а на глаз почти незаметна: цена мем-коина за пять секунд меняется
 * на доли процента, и график всё равно достраивается локально между
 * ответами сервера.
 *
 * Секунда была выбрана, когда цена шла через Premium `price-info`,
 * и стоила месячной квоты за сутки. Даже на Basic секундный ритм
 * при десятке зрителей — это два с половиной миллиона вызовов
 * в месяц; пятисекундный укладывается в бесплатный план.
 */
export const HOT_INTERVAL_MS = 5_000;

/**
 * Холодный круг.
 *
 * Две минуты, а не тридцать секунд. Расчёт простой и его стоит
 * держать перед глазами: полторы тысячи токенов — это пятнадцать
 * пакетов по сто адресов, то есть два вызова на проход при пачке
 * в двести. Тридцать секунд давали 5 760 вызовов в сутки —
 * 172 800 в месяц при бесплатной квоте Basic в сто тысяч, то есть
 * каталог в одиночку не помещался в план.
 *
 * Две минуты дают 1 440 в сутки и 43 200 в месяц — примерно
 * половину фонового бюджета Basic. Полный круг каталога занимает
 * около пятнадцати минут; это и есть честный срок, который стоит
 * называть, а не «30 секунд».
 */
export const COLD_INTERVAL_MS = 120_000;

/**
 * Сколько токенов берём за холодный проход.
 *
 * Кратно сотне: пакетный запрос цен у OKX принимает ровно сто адресов
 * за вызов, и остаток сверх сотни стоит целого лишнего запроса.
 */
export const COLD_BATCH = 200;

/** Параллелизм поштучного запроса. Публичные RPC отдают 429 уже на 20 rps. */
const RPC_CONCURRENCY = 5;

/** Цена старше этого срока показывается с пометкой. */
export const PRICE_STALE_AFTER_MS = 5 * 60_000;

let hotTimer: NodeJS.Timeout | null = null;
let coldTimer: NodeJS.Timeout | null = null;

/** Проходы не должны накладываться: иначе они конкурируют за лимит. */
let hotRunning = false;
let coldRunning = false;

/**
 * Курсор холодного круга.
 *
 * Хранится в памяти и теряется при перезапуске — это допустимо:
 * порядок задаётся возрастом котировки, и после перезапуска круг
 * начнётся с самых давних, то есть с самых нужных.
 */
let coldCursor: string | null = null;

/** Когда начался текущий полный круг. */
let cycleStartedAt = Date.now();

/** Неудачных проходов подряд. Растит паузу. */
let failures = 0;

/** Сколько холодных тиков было при включённом замедлении. */
let coldSkips = 0;

/**
 * До какого времени провайдера не трогаем.
 *
 * Пауза общая для горячего и холодного циклов, и это принципиально.
 * Провайдер один; если отступит только холодный, горячий продолжит
 * бить в него каждую секунду — то есть отступа не будет вовсе,
 * а будет шторм повторов с двух сторон.
 */
let pausedUntil = 0;

function providerPaused(now: number = Date.now()): boolean {
  return now < pausedUntil;
}

/**
 * Наблюдаемые числа.
 *
 * Счётчики процессные и теряются при перезапуске: это диагностика,
 * а не отчётность. Возраст цен считается по базе отдельно — по нему
 * видно фактическую свежесть, а не наши намерения.
 */
const metrics = {
  providerOk: 0,
  providerMissing: 0,
  providerErrors: 0,
  provider429: 0,
  written: 0,
  skipped: 0,
  backoffs: 0,
  fullCycles: 0,
  lastFullCycleMs: null as number | null,
  lastHotCycleMs: null as number | null,
  lastColdCycleMs: null as number | null,
  pausedUntil: 0,
};

export type PriceMetrics = Readonly<typeof metrics>;

export function priceMetrics(): PriceMetrics {
  return { ...metrics, pausedUntil };
}

/**
 * Учесть проход и, если провайдер отказал, отступить.
 *
 * Отступ назначается здесь, а не в планировщике, потому что горячий
 * и холодный циклы обязаны отступать одинаково и одновременно.
 */
function observeCycle(kind: 'hot' | 'cold', result: CycleResult): void {
  metrics.providerOk += result.report.fetched;
  metrics.providerMissing += result.report.missing;
  metrics.providerErrors += result.report.transient;
  metrics.provider429 += result.report.rateLimited;
  metrics.written += result.written;
  metrics.skipped += result.skipped;

  if (kind === 'hot') metrics.lastHotCycleMs = result.durationMs;
  else metrics.lastColdCycleMs = result.durationMs;

  if (result.verdict.kind === 'backoff') {
    failures++;
    metrics.backoffs++;
    pausedUntil = Date.now() + result.verdict.delayMs;
    metrics.pausedUntil = pausedUntil;

    logger.warn(
      {
        reason: result.verdict.reason,
        delayMs: result.verdict.delayMs,
        honoredRetryAfter: result.verdict.honoredRetryAfter,
        failures,
      },
      'цены: провайдер отказывает, отступаем',
    );
    return;
  }

  // Успешный проход сбрасывает счётчик. Без сброса воркер, переживший
  // получасовой отказ провайдера, ушёл бы в максимальную паузу
  // навсегда.
  if (result.report.requested > 0) failures = 0;
}

interface PriceRow {
  id: string;
  chain: string;
  address: string;
  symbol: string;
}

// ────────────────────────────── Получение цен ───────────────────────────────

/**
 * Цены пачкой.
 *
 * Сначала пакетный запрос OKX: сто токенов за вызов вместо ста
 * вызовов. Чего он не знает — дозапрашиваем поштучно через адаптер
 * сети, с ограниченным параллелизмом.
 */
interface FetchOutcome {
  prices: Map<string, number>;
  report: ProviderReport;
}

async function fetchPrices(
  rows: PriceRow[],
  opts: { rpcFallback?: boolean; purpose?: OkxCallPurpose } = {},
): Promise<FetchOutcome> {
  const prices = new Map<string, number>();
  if (rows.length === 0) return { prices, report: { ...EMPTY_PROVIDER_REPORT } };

  const byKey = new Map(rows.map((r) => [`${r.chain}:${r.address}`, r]));

  /*
   * Basic, а не Premium.
   *
   * Здесь была вся стоимость продукта. Живая цена шла через
   * `price-info`, который относится к Premium (официальная таблица
   * тарифов, сверено 25.08.2026): горячий цикл звал его раз
   * в секунду — восемьдесят шесть тысяч Premium-вызовов в сутки
   * при месячной квоте в сто тысяч.
   *
   * `/api/v6/dex/market/price` отдаёт ровно то, что нужно графику
   * и карточке: последнюю цену и время котировки. Ликвидность,
   * капитализация и держатели живут в отдельной, редкой очереди
   * обогащения — им не нужна секундная свежесть.
   */
  const batched = await fetchLivePrices(
    rows.map((r) => ({ chain: r.chain as ChainKey, address: r.address })),
    opts.purpose ?? 'hot-price',
  ).catch(() => null);

  for (const [key, live] of batched?.prices ?? []) {
    const row = byKey.get(key);
    if (row) prices.set(row.id, live.priceUsd);
  }

  /*
   * Отказ пакетного источника нельзя выдавать за отсутствие
   * котировок. Если провайдер сказал «слишком часто», мы про эти
   * цены ничего не узнали, и дозапрашивать их поштучно — значит
   * добивать его тем же залпом, только медленнее.
   */
  const batchReport: ProviderReport = batched?.report ?? {
    ...EMPTY_PROVIDER_REPORT,
    requested: rows.length,
    transient: rows.length,
  };

  if (batchReport.rateLimited > 0) {
    return { prices, report: batchReport };
  }

  const missing = rows.filter((r) => !prices.has(r.id));

  /*
   * Горячий секундный цикл не делает поштучный RPC-fallback.
   *
   * Один пакет OKX содержит до ста адресов и стоит один запрос.
   * Превратить его отсутствие в пятьдесят отдельных RPC каждую
   * секунду означало бы устроить собственный DDoS публичному узлу.
   * Холодный круг сохраняет fallback: там важнее охват и он идёт
   * раз в десятки секунд.
   */
  if (opts.rpcFallback === false) {
    return { prices, report: batchReport };
  }

  let rpcOk = 0;
  let rpcEmpty = 0;
  let rpcFailed = 0;
  let firstError: string | null = null;

  for (let i = 0; i < missing.length; i += RPC_CONCURRENCY) {
    const slice = missing.slice(i, i + RPC_CONCURRENCY);

    await Promise.all(
      slice.map(async (t) => {
        try {
          const price = await getAdapter(t.chain as never).getPriceUsd(t.address);

          if (price != null && price > 0) {
            prices.set(t.id, price);
            rpcOk++;
          } else {
            // Источник ответил, цены нет. Это сведения, а не сбой.
            rpcEmpty++;
          }
        } catch (e: any) {
          rpcFailed++;
          // Одна строка на проход, а не на токен: двести одинаковых
          // записей об одной и той же беде мешают её увидеть.
          firstError ??= e?.message ?? 'неизвестная ошибка';
        }
      }),
    );
  }

  if (rpcFailed > 0) {
    logger.warn({ failed: rpcFailed, of: missing.length, err: firstError }, 'цены: сбои узла');
  }

  return {
    prices,
    report: mergeReports(batchReport, {
      ...EMPTY_PROVIDER_REPORT,
      requested: missing.length,
      fetched: rpcOk,
      missing: rpcEmpty,
      transient: rpcFailed,
    }),
  };
}

// ─────────────────────────────── Запись ─────────────────────────────────────

/**
 * Записать цену, не затирая более свежую.
 *
 * Условие в `where` обязательно. Горячий и холодный проходы идут
 * одновременно, ответы приходят вразнобой, и запоздавший ответ
 * холодного круга иначе перезаписал бы цену, которую горячий цикл
 * получил секундой позже. Снаружи это выглядело бы как скачок цены
 * назад — самое неприятное, что может показать торговый экран.
 *
 * `updateMany` вместо `update` именно ради условия: проверка
 * и запись происходят одной командой, без чтения на стороне кода.
 */
async function writePrice(id: string, price: number, observedAt: Date): Promise<boolean> {
  const decimal = new P.Decimal(price);

  const { count } = await prisma.token.updateMany({
    where: {
      id,
      OR: [{ priceUpdatedAt: null }, { priceUpdatedAt: { lt: observedAt } }],
    },
    data: { priceUsd: decimal, priceUpdatedAt: observedAt, metricsUpdated: observedAt },
  });

  if (count === 0) return false;

  // Пик по активным коллам — для честной статистики автора.
  await prisma.call
    .updateMany({
      where: {
        tokenId: id,
        status: 'PUBLISHED',
        OR: [{ peakPriceUsd: null }, { peakPriceUsd: { lt: decimal } }],
      },
      data: { peakPriceUsd: decimal },
    })
    .catch(() => undefined);

  // GEMS хранит максимум для каждого отдельного события Signal.
  // Ошибка этой производной статистики не откатывает настоящую цену
  // токена: следующий live-тик попробует продлить пик ещё раз.
  await recordOkxSignalLivePeak(id, price, observedAt).catch(() => undefined);

  return true;
}

export interface CycleResult {
  written: number;
  /** Цена получена, но запись отклонена как устаревшая. */
  skipped: number;
  report: ProviderReport;
  verdict: CycleVerdict;
  durationMs: number;
}

const EMPTY_CYCLE: CycleResult = {
  written: 0,
  skipped: 0,
  report: { ...EMPTY_PROVIDER_REPORT },
  verdict: { kind: 'ok' },
  durationMs: 0,
};

async function applyPrices(
  rows: PriceRow[],
  observedAt: Date,
  failures: number,
  opts: { rpcFallback?: boolean; purpose?: OkxCallPurpose } = {},
): Promise<CycleResult> {
  const startedAt = Date.now();
  const { prices, report } = await fetchPrices(rows, opts);

  let written = 0;
  let skipped = 0;

  /*
   * Частичный успех записывается.
   *
   * Отказ провайдера не должен отменять те цены, которые всё же
   * пришли: выбросить их значит наказать живые токены за молчание
   * мёртвых.
   */
  for (const [id, price] of prices) {
    if (await writePrice(id, price, observedAt)) written++;
    else skipped++;
  }

  return {
    written,
    skipped,
    report,
    verdict: cycleVerdict(report, failures + 1),
    durationMs: Date.now() - startedAt,
  };
}

// ──────────────────────────────── Циклы ─────────────────────────────────────

/**
 * Горячий проход.
 *
 * Кроме открытых карточек сюда входят токены, в которых у кого-то
 * открыта позиция: человек, сидящий в сделке, смотрит на цену чаще
 * всех, даже если карточка закрыта.
 */
export async function updateHotPrices(): Promise<CycleResult> {
  if (providerPaused()) return EMPTY_CYCLE;

  /*
   * Нет зрителей — нет запросов.
   *
   * Это главное свойство горячего цикла и главная причина, по которой
   * простой просмотр списка больше не переводит токены в горячие.
   * Пустое приложение обязано стоить ноль: раньше открытая вкладка
   * GEMS держала первые карточки горячими бесконечно, и «живой
   * продукт» означал секундный Premium-запрос круглые сутки.
   */
  const ids = hotTokens();

  const withPositions = await prisma.position
    .findMany({
      where: { closedAt: null },
      select: { tokenId: true },
      distinct: ['tokenId'],
      take: 100,
    })
    .catch(() => []);

  const all = [...new Set([...ids, ...withPositions.map((p) => p.tokenId)])];
  if (all.length === 0) return EMPTY_CYCLE;

  const rows = await prisma.token.findMany({
    where: { id: { in: all } },
    select: { id: true, chain: true, address: true, symbol: true },
  });

  const result = await applyPrices(rows, new Date(), failures, {
    rpcFallback: false,
    purpose: 'hot-price',
  });
  observeCycle('hot', result);
  return result;
}

/**
 * Холодный проход: следующий кусок круга.
 *
 * Порядок — стабильный по id. Курсор нужен, чтобы круг двигался:
 * без него каждый проход брал бы один и тот же первый срез, а хвост
 * не обновлялся бы никогда. Фактический возраст всего круга виден
 * в `/admin/price-health`; обещать 30 секунд всему каталогу нельзя,
 * когда одна пачка сама содержит двести токенов.
 */
export async function updateColdPrices(): Promise<CycleResult> {
  if (providerPaused()) return EMPTY_CYCLE;

  /*
   * У предела квоты фон замедляется первым.
   *
   * Разница между «каталог обновится позже» и «график перестал
   * работать» — это вся разница между экономией и сломанным
   * продуктом. Пропускаем проходы, а не уменьшаем пачку: половина
   * пачки стоит того же одного запроса.
   */
  const slowdown = okxSlowdown('basic');

  if (slowdown === 0) return EMPTY_CYCLE;
  if (slowdown > 1) {
    coldSkips++;
    if (coldSkips % slowdown !== 0) return EMPTY_CYCLE;
  }

  const rows = await prisma.token.findMany({
    where: {
      isHidden: false,
      isQuote: false,
      ...(coldCursor ? { id: { gt: coldCursor } } : {}),
    },
    orderBy: { id: 'asc' },
    select: { id: true, chain: true, address: true, symbol: true },
    take: COLD_BATCH,
  });

  const wrapped = rows.length < COLD_BATCH;

  // Круг замкнулся — начинаем сначала.
  coldCursor = wrapped ? null : (rows.at(-1)?.id ?? null);

  if (wrapped) {
    // Длительность полного круга: измеряем, а не заявляем.
    metrics.lastFullCycleMs = Date.now() - cycleStartedAt;
    metrics.fullCycles++;
    cycleStartedAt = Date.now();
  }

  if (rows.length === 0) return EMPTY_CYCLE;

  const result = await applyPrices(rows, new Date(), failures, { purpose: 'cold-price' });
  observeCycle('cold', result);
  return result;
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function hotTick(): Promise<void> {
  if (hotRunning) return;
  hotRunning = true;
  try {
    await updateHotPrices();
  } catch (e: any) {
    logger.debug({ err: e?.message }, 'горячий проход цен не удался');
  } finally {
    hotRunning = false;
  }
}

async function coldTick(): Promise<void> {
  if (coldRunning) return;
  coldRunning = true;
  try {
    // Отступ назначается внутри, по отчёту провайдера. Прежде здесь
    // стоял `catch`, который не срабатывал никогда: все ошибки
    // поглощались уровнем ниже, и полный отказ выглядел как успешный
    // проход без котировок.
    await updateColdPrices();
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'холодный проход цен не удался');
  } finally {
    coldRunning = false;
  }
}

export function startPriceUpdater(): void {
  if (hotTimer || coldTimer) return;

  hotTimer = setInterval(() => void hotTick(), HOT_INTERVAL_MS);
  coldTimer = setInterval(() => void coldTick(), COLD_INTERVAL_MS);

  void hotTick();
  void coldTick();

  logger.info('воркер цен запущен: горячий и холодный циклы');
}

export function stopPriceUpdater(): void {
  if (hotTimer) clearInterval(hotTimer);
  if (coldTimer) clearInterval(coldTimer);
  hotTimer = null;
  coldTimer = null;
}

/** Сброс состояния между тестами. */
export function resetPriceUpdaterForTests(): void {
  coldCursor = null;
  failures = 0;
  coldSkips = 0;
  pausedUntil = 0;
  cycleStartedAt = Date.now();
  hotRunning = false;
  coldRunning = false;

  for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) {
    (metrics as Record<string, unknown>)[key] =
      key === 'lastFullCycleMs' || key === 'lastHotCycleMs' || key === 'lastColdCycleMs'
        ? null
        : 0;
  }
}
