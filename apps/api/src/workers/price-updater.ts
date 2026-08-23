import { Prisma as P } from '@prisma/client';
import {
  cycleVerdict,
  mergeReports,
  EMPTY_PROVIDER_REPORT,
  type ChainKey,
  type CycleVerdict,
  type ProviderReport,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { getAdapter } from '../chains/index.js';
import { logger } from '../lib/logger.js';
import { fetchPriceInfo } from '../services/okx-market.js';
import { hotTokens } from './hot-tokens.js';

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

/** Открытая карточка получает новый тик раз в секунду. */
export const HOT_INTERVAL_MS = 1_000;

/** Холодный круг: щадящий к провайдеру и всё же заметно живой. */
export const COLD_INTERVAL_MS = 30_000;

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
  opts: { rpcFallback?: boolean } = {},
): Promise<FetchOutcome> {
  const prices = new Map<string, number>();
  if (rows.length === 0) return { prices, report: { ...EMPTY_PROVIDER_REPORT } };

  const byKey = new Map(rows.map((r) => [`${r.chain}:${r.address}`, r]));

  const batched = await fetchPriceInfo(
    rows.map((r) => ({ chain: r.chain as ChainKey, address: r.address })),
    { fresh: true },
  ).catch(() => null);

  for (const [key, info] of batched?.prices ?? []) {
    const row = byKey.get(key);
    const price = info?.priceUsd;
    if (row && typeof price === 'number' && price > 0) prices.set(row.id, price);
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
  opts: { rpcFallback?: boolean } = {},
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

  const result = await applyPrices(rows, new Date(), failures, { rpcFallback: false });
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

  const result = await applyPrices(rows, new Date(), failures);
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
