import { Prisma as P, type Chain } from '@prisma/client';
import {
  scoreWallet,
  summarizeWalletSignal,
  foldTokenOutcomes,
  walletPerformanceSummary,
  assertSummaryInvariants,
  SCORE_VERSION,
  type ChainKey,
  type WalletPerformanceSummary,
  type WalletTradeOutcome,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchPoolTrades } from '../services/market-data.js';
import { decimalFor, DECIMAL_COLUMN } from '../lib/decimal.js';

/**
 * Наблюдение за кошельками: кто покупает наши находки и что из этого выходит.
 *
 * Метки «смарт-мани» невозможно ниоткуда скачать — это производный набор
 * данных, и все, у кого он есть, построили его сами по одной и той же схеме:
 * собрать сделки, дождаться исхода токена, приписать исход покупателю.
 * Здесь ровно она.
 *
 * Данные берутся из ленты сделок пула: это единственный бесплатный источник,
 * отдающий адрес контрагента вместе с суммой. У него есть жёсткое свойство,
 * определяющее весь дизайн: истории задним числом нет. Видно примерно три
 * сотни последних сделок, и всё, что не было записано вовремя, потеряно
 * навсегда. Поэтому пулы опрашиваются по кругу постоянно, а база кошельков
 * наполняется не мгновенно, а по мере работы системы.
 *
 * Второе следствие того же ограничения: полезность растёт со временем.
 * В первые сутки список кошельков почти пуст, и это нормально — оценка
 * требует минимум пяти сделок с известным исходом на кошелёк.
 */

const TICK_MS = 90_000;
const STALE_RESCORE_BATCH = 100;

/**
 * Пулов за проход. Лимит GeckoTerminal — 25 запросов в минуту на всё
 * приложение, и его уже делят обновление цен, свечи и сканер радара.
 * Больше пяти здесь означает 429 у остальных воркеров.
 */
const POOLS_PER_TICK = 5;

/** Сделки мельче отбрасываются: это шум ботов и пыль от арбитража. */
const MIN_TRADE_USD = 300;

/**
 * Исход подводится не раньше этого срока после покупки.
 *
 * Оценивать покупку сразу бессмысленно: через минуту после входа
 * кратность равна единице у кого угодно, и все кошельки выглядели бы
 * одинаково посредственно.
 */
const SETTLE_AFTER_HOURS = 24;

/** Сделки старше этого срока в оценке уже не участвуют. */
const MAX_TRADE_AGE_DAYS = 45;

let timer: NodeJS.Timeout | null = null;
let running = false;

// ───────────────────────────── Сбор сделок ──────────────────────────────────

interface PricePoint {
  t: number;
  p: number | null;
  m: number | null;
}

function readPoints(raw: unknown): PricePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is PricePoint => !!x && typeof x === 'object' && typeof (x as any).t === 'number')
    .sort((a, b) => a.t - b.t);
}

/**
 * Капитализация в момент времени по сохранённому ряду наблюдений.
 * Берётся ближайшая точка не позже запрошенного момента: интерполяция
 * тут создала бы значения, которых мы не наблюдали.
 */
function mcapAt(points: PricePoint[], ts: number): number | null {
  let found: number | null = null;
  for (const pt of points) {
    if (pt.t > ts) break;
    if (pt.m != null && Number.isFinite(pt.m) && pt.m > 0) found = pt.m;
  }
  return found;
}

export async function collectTrades(): Promise<{ pools: number; trades: number }> {
  // Берём отслеживаемые находки, у которых давно не смотрели сделки.
  const events = await prisma.radarEvent.findMany({
    where: { isTracking: true, poolAddress: { not: null } },
    orderBy: { walletsCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: POOLS_PER_TICK,
    select: {
      id: true, chain: true, address: true, poolAddress: true,
      firstSeenAt: true, poolAgeHours: true, pricePoints: true,
    },
  });

  if (events.length === 0) return { pools: 0, trades: 0 };

  let saved = 0;

  for (const ev of events) {
    const trades = await fetchPoolTrades(ev.chain, ev.poolAddress!, MIN_TRADE_USD);

    if (trades.length === 0) {
      // Отметку времени ставим независимо от результата: иначе пул без
      // сделок опрашивался бы в каждом проходе и вытеснял остальные.
      await prisma.radarEvent.update({
        where: { id: ev.id },
        data: { walletsCheckedAt: new Date() },
      });
      continue;
    }

    const points = readPoints(ev.pricePoints);
    // Возраст пула в момент запуска отслеживания — база для пересчёта
    // возраста на момент каждой сделки.
    const baseAgeHours = ev.poolAgeHours != null ? Number(ev.poolAgeHours) : null;
    const baseTs = ev.firstSeenAt.getTime();

    for (const t of trades) {
      // Продажи записываем тоже: без них нельзя отличить кошелёк,
      // который держал до роста, от того, кто вышел в первый час.
      const tradedTs = t.tradedAt.getTime();

      const poolAgeHours =
        baseAgeHours != null ? baseAgeHours + (tradedTs - baseTs) / 3_600_000 : null;

      // Хеш транзакции — ключ идемпотентности: одна и та же сделка
      // приходит в нескольких проходах, пока не уйдёт из ленты.
      // Проверяем до создания кошелька, иначе в базе копились бы
      // кошельки без единой записанной сделки.
      if (!t.txHash) continue;

      try {
        const wallet = await prisma.traderWallet.upsert({
          where: { chain_address: { chain: ev.chain, address: t.wallet } },
          create: { chain: ev.chain, address: t.wallet, lastActiveAt: t.tradedAt },
          update: { lastActiveAt: t.tradedAt },
          select: { id: true },
        });

        await prisma.walletTrade.create({
          data: {
            walletId: wallet.id,
            chain: ev.chain,
            tokenAddress: ev.address,
            radarEventId: ev.id,
            side: t.side,
            amountUsd: new P.Decimal(t.amountUsd),
            priceUsd: t.priceUsd != null ? new P.Decimal(t.priceUsd) : null,
            mcapAtTradeUsd: (() => {
              const m = mcapAt(points, tradedTs);
              return m != null ? new P.Decimal(m) : null;
            })(),
            poolAgeHours: decimalFor(poolAgeHours, DECIMAL_COLUMN.percent),
            txHash: t.txHash,
            tradedAt: t.tradedAt,
          },
        });
        saved++;
      } catch {
        // Нарушение уникальности по (walletId, txHash) — сделка уже
        // записана в прошлом проходе. Это ожидаемо, а не ошибка.
      }
    }

    await refreshEventSignal(ev.id, ev.chain, ev.address);
  }

  return { pools: events.length, trades: saved };
}

/**
 * Пересчёт свода по кошелькам для одной находки.
 *
 * Результат кладётся прямо в RadarEvent. Денормализация здесь оправдана:
 * лента показывает до полусотни карточек, и считать сигнал отдельным
 * запросом на каждую значило бы полсотни агрегаций на открытие страницы.
 */
async function refreshEventSignal(
  eventId: string,
  chain: Chain,
  tokenAddress: string,
): Promise<void> {
  const since = new Date(Date.now() - 48 * 3_600_000);

  const rows = await prisma.walletTrade.findMany({
    where: { chain, tokenAddress, side: 'BUY', tradedAt: { gte: since } },
    select: {
      amountUsd: true,
      tradedAt: true,
      wallet: { select: { label: true, score: true } },
    },
  });

  const now = Date.now();
  const signal = summarizeWalletSignal(
    rows.map((r) => ({
      label: r.wallet.label as 'smart' | 'whale' | 'early' | 'none',
      score: r.wallet.score,
      amountUsd: Number(r.amountUsd),
      hoursAgo: (now - r.tradedAt.getTime()) / 3_600_000,
    })),
  );

  await prisma.radarEvent.update({
    where: { id: eventId },
    data: {
      smartBuyers: signal.smartCount,
      smartBuyVolumeUsd: new P.Decimal(signal.smartVolumeUsd),
      whaleBuyers: signal.whaleCount,
      walletSignalScore: signal.strength,
      walletsCheckedAt: new Date(),
    },
  });
}

// ──────────────────────────── Подведение исходов ────────────────────────────

/**
 * Проставляет каждой покупке её исход: во сколько раз выросла
 * капитализация ПОСЛЕ входа.
 *
 * Считается по максимуму наблюдений строго после момента сделки. Брать
 * пик за всё время нельзя: если токен вырос до покупки и упал после,
 * такой расчёт записал бы покупку на вершине в успешные.
 */
export async function settleOutcomes(): Promise<number> {
  const cutoff = new Date(Date.now() - SETTLE_AFTER_HOURS * 3_600_000);

  const trades = await prisma.walletTrade.findMany({
    where: {
      side: 'BUY',
      outcomeMultiple: null,
      tradedAt: { lt: cutoff },
      radarEventId: { not: null },
    },
    orderBy: { tradedAt: 'asc' },
    take: 400,
    select: {
      id: true, tradedAt: true, mcapAtTradeUsd: true, radarEventId: true,
    },
  });

  if (trades.length === 0) return 0;

  // Ряды наблюдений тянем по одному разу на находку, а не на сделку:
  // на популярный пул приходятся десятки сделок с одним и тем же рядом.
  const eventIds = [...new Set(trades.map((t) => t.radarEventId!))];
  const events = await prisma.radarEvent.findMany({
    where: { id: { in: eventIds } },
    select: { id: true, pricePoints: true, mcapAtSignalUsd: true },
  });
  const byId = new Map(events.map((e) => [e.id, e]));

  let settled = 0;

  for (const t of trades) {
    const ev = byId.get(t.radarEventId!);
    if (!ev) continue;

    const points = readPoints(ev.pricePoints);
    const tradedTs = t.tradedAt.getTime();

    // База — капитализация на момент сделки. Если её не записали
    // (сделка пришла раньше первого наблюдения), берём ближайшую
    // последующую: это занижает результат, но не выдумывает его.
    let base = t.mcapAtTradeUsd != null ? Number(t.mcapAtTradeUsd) : null;
    if (base == null || base <= 0) {
      base = points.find((p) => p.t >= tradedTs && p.m != null && p.m > 0)?.m ?? null;
    }
    if (base == null || base <= 0) continue;

    const after = points.filter((p) => p.t > tradedTs && p.m != null && p.m > 0);
    if (after.length === 0) continue;

    const peak = Math.max(...after.map((p) => p.m!));

    await prisma.walletTrade.update({
      where: { id: t.id },
      data: {
        outcomeMultiple: decimalFor(peak / base, DECIMAL_COLUMN.percent),
        outcomeAt: new Date(),
      },
    });
    settled++;
  }

  return settled;
}

// ───────────────────────────── Пересчёт оценок ──────────────────────────────

/**
 * Сводка кошелька из наблюдаемых покупок.
 *
 * Вынесено отдельно, чтобы одна и та же логика работала и в фоновом
 * проходе, и в полном пересчёте, и в тестах. Раньше расчёт жил внутри
 * `rescoreWallets`, и проверить его можно было только через базу.
 */
export async function summarizeWallet(
  walletId: string,
  since: Date,
): Promise<{ summary: WalletPerformanceSummary; label: string }> {
  const rows = await prisma.walletTrade.findMany({
    where: { walletId, side: 'BUY', tradedAt: { gte: since } },
    select: {
      chain: true,
      tokenAddress: true,
      amountUsd: true,
      outcomeMultiple: true,
      poolAgeHours: true,
      mcapAtTradeUsd: true,
      priceUsd: true,
      tradedAt: true,
    },
  });

  /*
   * Независимое наблюдение цены и капитализации тех же токенов.
   *
   * По нему сверяется подразумеваемое предложение — способ отличить
   * ошибку единиц измерения от честного раннего входа, не полагаясь
   * на один абсолютный порог. Находка радара получена другим путём
   * и в другой момент, поэтому годится как вторая точка зрения.
   *
   * Один запрос на весь кошелёк, а не на каждую сделку: токенов
   * у кошелька десятки, сделок — сотни. Связь идёт по паре
   * «сеть и адрес», а не по `radarEventId`: тот заполнен лишь
   * у сделок, найденных через радар, а капитализация нужна и для
   * остальных.
   */
  const tokenKeys = [...new Set(rows.map((r) => `${r.chain}|${r.tokenAddress}`))];

  const references =
    tokenKeys.length === 0
      ? []
      : await prisma.radarEvent.findMany({
          where: {
            OR: tokenKeys.map((k) => {
              const [chain, address] = k.split('|');
              return { chain: chain as never, address: address! };
            }),
          },
          select: { chain: true, address: true, priceUsd: true, mcapAtSignalUsd: true },
        });

  const referenceOf = new Map(references.map((e) => [`${e.chain}|${e.address}`, e]));

  /*
   * Покупки сворачиваются в исходы по токенам.
   *
   * Здесь и была ошибка: `scoreWallet` получал список покупок,
   * а `tokensBought` считался по уникальным токенам. Десять покупок
   * одного токена давали до десяти побед при одном купленном —
   * то есть долю попаданий больше единицы.
   */
  const outcomes = foldTokenOutcomes(
    rows.map((r) => {
      const reference = referenceOf.get(`${r.chain}|${r.tokenAddress}`);

      return {
      chain: r.chain as ChainKey,
      tokenAddress: r.tokenAddress,
      amountUsd: Number(r.amountUsd),
      poolAgeHours: r.poolAgeHours != null ? Number(r.poolAgeHours) : null,
      tradedAt: r.tradedAt.getTime(),
      outcomeMultiple: r.outcomeMultiple != null ? Number(r.outcomeMultiple) : null,
      mcapAtTradeUsd: r.mcapAtTradeUsd != null ? Number(r.mcapAtTradeUsd) : null,
      priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
      referencePriceUsd: reference?.priceUsd != null ? Number(reference.priceUsd) : null,
      referenceMcapUsd:
        reference?.mcapAtSignalUsd != null ? Number(reference.mcapAtSignalUsd) : null,
      };
    }),
  );

  /*
   * Оценка считается тем же движком, но на исходах по токенам.
   *
   * `scoreWallet` сам по себе исправен: он делит победы на своё
   * `settled` и отказывается ставить оценку на малой выборке.
   * Ломало его то, чем его кормили.
   */
  const scorable = outcomes.filter((o) => o.status === 'scorable');

  const scored = scoreWallet(
    scorable.map((o): WalletTradeOutcome => ({
      amountUsd: o.buyVolumeUsd,
      outcomeMultiple: o.peakMultiple,
      poolAgeHours: o.entryHours,
    })),
  );

  const summary = walletPerformanceSummary({ outcomes, score: scored.score });

  /*
   * Невозможная сводка не записывается.
   *
   * Проверка стоит здесь, а не в интерфейсе: число, доехавшее
   * до базы, потом выглядит на экране обычным. Доля попаданий
   * в 400% читается как «очень хороший кошелёк», а не как
   * «расчёт сломан».
   */
  const broken = assertSummaryInvariants(summary);

  if (broken.length > 0) {
    logger.warn({ walletId, broken }, 'кошельки: сводка нарушает инварианты, оценка не выставлена');
    return { summary: { ...summary, score: null }, label: scored.label };
  }

  return { summary, label: scored.label };
}

/**
 * Записать сводку в кошелёк. Одно место записи на все проходы.
 *
 * ─── Почему записывается весь контракт ──────────────────────────────
 *
 * Прежде сохранялись только победы, крупные победы, rug и число
 * купленных токенов, а знаменатель доли попаданий не сохранялся вовсе.
 * Чтение восстанавливало его выражением `max(wins2x, rugs)` — и теряло
 * всё, что лежит между rug и удвоением. Десять оценённых токенов, из
 * них одна победа, один rug и восемь обычных, превращались в выборку
 * из одного и долю попаданий 100% вместо 10%.
 *
 * Восстановить знаменатель из победителей нельзя в принципе: победы
 * являются его подмножеством, а подмножество не определяет множество.
 * Поэтому знаменатель, разбиение исходов, версия правил и настоящее
 * время расчёта пишутся сюда целиком — и читаются как есть.
 *
 * Одним `update`, то есть одним оператором: сводка обязана попасть
 * в базу целиком либо не попасть вовсе. Половина новых полей рядом
 * со старыми победами — это то же расхождение знаменателей, только
 * записанное в базу.
 */
async function saveWalletSummary(
  walletId: string,
  summary: WalletPerformanceSummary,
  label: string,
): Promise<void> {
  await prisma.traderWallet.update({
    where: { id: walletId },
    data: {
      // Смысл поля не изменился, изменился способ подсчёта:
      // это число разных токенов, и оно же — основа знаменателя.
      tokensBought: summary.observedTokens,
      wins2x: summary.wins2x,
      wins5x: summary.wins5x,
      rugs: summary.rugs,
      volumeUsd: new P.Decimal(summary.buyVolumeUsd),
      avgPeakMultiple:
        summary.avgPeakMultiple != null
          ? decimalFor(summary.avgPeakMultiple, DECIMAL_COLUMN.percent)
          : null,
      medianEntryHours: decimalFor(summary.medianEntryHours, DECIMAL_COLUMN.percent),
      score: summary.score,
      label,

      /*
       * Знаменатель и разбиение исходов.
       *
       * `hitRate` отдельной колонкой не хранится намеренно: он
       * однозначно выводится из `wins2x` и `scorableOutcomes`,
       * а третья копия того же факта — это третий знаменатель,
       * который однажды разойдётся с двумя первыми. Ровно с этого
       * весь дефект и начался.
       */
      scorableOutcomes: summary.scorableOutcomes,
      pendingOutcomes: summary.pendingOutcomes,
      ambiguousOutcomes: summary.ambiguousOutcomes,

      // Подпись расчёта: чем посчитано и когда. Без неё чтение
      // не может отличить пересчитанную строку от старой.
      scoreVersion: summary.scoreVersion,
      scoreComputedAt: summary.computedAt != null ? new Date(summary.computedAt) : null,
      scoreConfidence: summary.confidence,
      scoreCoverage: summary.coverage,
      scoreReason: summary.reason,
    },
  });
}

export async function rescoreWallets(limit = 200): Promise<number> {
  const since = new Date(Date.now() - MAX_TRADE_AGE_DAYS * 864e5);

  // Пересчитываем те кошельки, у которых с прошлого раза появились
  // новые подведённые исходы.
  const candidates = await prisma.traderWallet.findMany({
    where: { trades: { some: { outcomeAt: { gt: since } } } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  if (candidates.length === 0) return 0;

  let updated = 0;

  for (const w of candidates) {
    const { summary, label } = await summarizeWallet(w.id, since);
    await saveWalletSummary(w.id, summary, label);
    updated++;
  }

  return updated;
}

/**
 * Довести строки прежней версии до текущего контракта без ручного CLI.
 *
 * Кандидаты из OKX часто ещё не имеют ни одной наблюдаемой покупки.
 * Их можно массово и честно пометить `empty`; запускать отдельный
 * запрос на каждый из десятков тысяч таких адресов бессмысленно.
 * Кошельки со сделками пересчитываются обычным точным путём пачкой.
 */
export async function rescoreStaleWallets(limit = STALE_RESCORE_BATCH): Promise<number> {
  const stale = { OR: [{ scoreVersion: null }, { scoreVersion: { lt: SCORE_VERSION } }] };
  const computedAt = new Date();

  const empty = await prisma.traderWallet.updateMany({
    where: { ...stale, trades: { none: {} } },
    data: {
      tokensBought: 0,
      wins2x: 0,
      wins5x: 0,
      rugs: 0,
      volumeUsd: new P.Decimal(0),
      avgPeakMultiple: null,
      medianEntryHours: null,
      score: null,
      label: 'none',
      scorableOutcomes: 0,
      pendingOutcomes: 0,
      ambiguousOutcomes: 0,
      scoreVersion: SCORE_VERSION,
      scoreComputedAt: computedAt,
      scoreConfidence: 'none',
      scoreCoverage: 'empty',
      scoreReason: 'Нет наблюдаемых покупок',
    },
  });

  const since = new Date(Date.now() - MAX_TRADE_AGE_DAYS * 864e5);
  const candidates = await prisma.traderWallet.findMany({
    where: { ...stale, trades: { some: {} } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const wallet of candidates) {
    const { summary, label } = await summarizeWallet(wallet.id, since);
    await saveWalletSummary(wallet.id, summary, label);
  }

  return empty.count + candidates.length;
}

export interface RescoreAllResult {
  scanned: number;
  updated: number;
  scoreCleared: number;
  invariantViolations: number;
  /** Строк, ещё не пересчитанных новыми правилами, на входе прохода. */
  staleFound: number;
  /**
   * Строк, у которых пересчёт не изменил ни одного значимого поля.
   *
   * Мера идемпотентности, наблюдаемая снаружи: второй прогон подряд
   * обязан дать `unchanged === scanned`. Без такого счётчика проверить
   * это можно было бы только сравнением дампов базы.
   */
  unchanged: number;
}

/**
 * Значимые поля сводки — те, по которым судят об идемпотентности.
 *
 * Время расчёта сюда не входит: оно меняется при каждом пересчёте
 * по определению, и включать его значило бы объявить любой повторный
 * прогон изменяющим.
 */
function summaryDiffers(
  stored: {
    tokensBought: number;
    wins2x: number;
    wins5x: number;
    rugs: number;
    scorableOutcomes: number | null;
    pendingOutcomes: number | null;
    ambiguousOutcomes: number | null;
    score: number | null;
    scoreVersion: number | null;
  },
  next: WalletPerformanceSummary,
): boolean {
  return (
    stored.tokensBought !== next.observedTokens ||
    stored.wins2x !== next.wins2x ||
    stored.wins5x !== next.wins5x ||
    stored.rugs !== next.rugs ||
    stored.scorableOutcomes !== next.scorableOutcomes ||
    stored.pendingOutcomes !== next.pendingOutcomes ||
    stored.ambiguousOutcomes !== next.ambiguousOutcomes ||
    stored.score !== next.score ||
    stored.scoreVersion !== next.scoreVersion
  );
}

/**
 * Полный пересчёт всех кошельков.
 *
 * Нужен отдельно от фонового прохода. Тот берёт только тех, у кого
 * недавно появился новый подведённый исход, — а кошелёк с давним
 * Smart Score 100, посчитанным по прежним правилам, нового исхода
 * может не получить никогда. Сохранённая оценка так и осталась бы
 * на экране, хотя правила давно изменились.
 *
 * Идемпотентен: повторный запуск на тех же данных даёт тот же
 * результат. По умолчанию ничего не пишет.
 */
export async function rescoreAllWallets(
  opts: { apply?: boolean; batchSize?: number; limit?: number } = {},
): Promise<RescoreAllResult> {
  const since = new Date(Date.now() - MAX_TRADE_AGE_DAYS * 864e5);
  const batchSize = opts.batchSize ?? 200;

  const result: RescoreAllResult = {
    scanned: 0,
    updated: 0,
    scoreCleared: 0,
    invariantViolations: 0,
    staleFound: 0,
    unchanged: 0,
  };

  let cursor: string | null = null;

  for (;;) {
    const batch: {
      id: string;
      score: number | null;
      tokensBought: number;
      wins2x: number;
      wins5x: number;
      rugs: number;
      scorableOutcomes: number | null;
      pendingOutcomes: number | null;
      ambiguousOutcomes: number | null;
      scoreVersion: number | null;
    }[] = await prisma.traderWallet.findMany({
      // Курсор по id, а не смещение: пересчёт идёт долго, и записи,
      // добавленные во время обхода, сдвинули бы окно.
      //
      // Курсор Prisma здесь безопасен, в отличие от свёртки сделок:
      // проход обновляет строки, но не выводит их из набора — ни один
      // кошелёк не перестаёт быть кошельком, и строка-курсор остаётся
      // на месте до конца обхода.
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        score: true,
        tokensBought: true,
        wins2x: true,
        wins5x: true,
        rugs: true,
        scorableOutcomes: true,
        pendingOutcomes: true,
        ambiguousOutcomes: true,
        scoreVersion: true,
      },
    });

    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;

    for (const w of batch) {
      result.scanned++;

      // Пустая версия — строка от прежних правил. Считаем до пересчёта,
      // иначе после записи отличить её будет уже нечем.
      if (w.scoreVersion == null) result.staleFound++;

      const { summary, label } = await summarizeWallet(w.id, since);

      if (assertSummaryInvariants(summary).length > 0) result.invariantViolations++;

      // Оценка была и пропала: выборки не хватает по новым правилам.
      if (w.score != null && summary.score == null) result.scoreCleared++;

      if (!summaryDiffers(w, summary)) result.unchanged++;

      if (opts.apply) {
        await saveWalletSummary(w.id, summary, label);
        result.updated++;
      }
    }

    if (opts.limit != null && result.scanned >= opts.limit) break;
  }

  return result;
}

// ───────────────────────── Сводка по одному токену ──────────────────────────

/**
 * Кто из размеченных кошельков покупал этот токен.
 * Используется страницей токена и карточкой находки.
 */
export async function walletActivityForToken(
  chain: Chain,
  tokenAddress: string,
  hours = 48,
) {
  const since = new Date(Date.now() - hours * 3_600_000);

  const trades = await prisma.walletTrade.findMany({
    where: { chain, tokenAddress, side: 'BUY', tradedAt: { gte: since } },
    orderBy: { tradedAt: 'desc' },
    take: 200,
    include: {
      wallet: {
        select: {
          address: true, label: true, score: true, wins2x: true,
          tokensBought: true, avgPeakMultiple: true, knownAs: true,
        },
      },
    },
  });

  return trades;
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { pools, trades } = await collectTrades();
    const settled = await settleOutcomes();
    const rescored = settled > 0 ? await rescoreWallets() : 0;
    const migrated = await rescoreStaleWallets();

    if (trades > 0 || settled > 0 || migrated > 0) {
      logger.debug({ pools, trades, settled, rescored, migrated }, 'кошельки: проход завершён');
    }
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'кошельки: ошибка прохода');
  } finally {
    running = false;
  }
}

export function startWalletTracker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  logger.info('наблюдение за кошельками запущено');
}

export function stopWalletTracker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
