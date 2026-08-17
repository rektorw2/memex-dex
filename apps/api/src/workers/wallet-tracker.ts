import { Prisma as P, type Chain } from '@prisma/client';
import { scoreWallet, summarizeWalletSignal, type WalletTradeOutcome } from '@memex/core';
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
    const rows = await prisma.walletTrade.findMany({
      where: { walletId: w.id, side: 'BUY', tradedAt: { gte: since } },
      select: {
        amountUsd: true, outcomeMultiple: true, poolAgeHours: true, tokenAddress: true,
      },
    });

    const outcomes: WalletTradeOutcome[] = rows.map((r) => ({
      amountUsd: Number(r.amountUsd),
      outcomeMultiple: r.outcomeMultiple != null ? Number(r.outcomeMultiple) : null,
      poolAgeHours: r.poolAgeHours != null ? Number(r.poolAgeHours) : null,
    }));

    const s = scoreWallet(outcomes);

    await prisma.traderWallet.update({
      where: { id: w.id },
      data: {
        tokensBought: new Set(rows.map((r) => r.tokenAddress)).size,
        wins2x: s.wins2x,
        wins5x: s.wins5x,
        rugs: s.rugs,
        volumeUsd: new P.Decimal(s.volumeUsd),
        avgPeakMultiple: s.settled > 0 ? decimalFor(s.avgMultiple, DECIMAL_COLUMN.percent) : null,
        medianEntryHours:
          decimalFor(s.medianEntryHours, DECIMAL_COLUMN.percent),
        score: s.score,
        label: s.label,
      },
    });
    updated++;
  }

  return updated;
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

    if (trades > 0 || settled > 0) {
      logger.debug({ pools, trades, settled, rescored }, 'кошельки: проход завершён');
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
