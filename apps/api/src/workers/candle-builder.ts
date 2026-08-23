import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchOhlcv, isMarketDataSupported } from '../services/market-data.js';

/**
 * Загрузка свечей для графиков.
 *
 * Лимит поставщика — 25 запросов в минуту на все нужды сервиса, а токенов
 * в витрине могут быть сотни. Поэтому свечи обновляются не для всех сразу,
 * а по кругу: за один проход обрабатывается небольшая пачка, приоритет —
 * у токенов, которые дольше всех не обновлялись.
 *
 * Интервалы тоже разделены по частоте: пятиминутки нужны свежими для
 * торговли, дневные меняются раз в сутки и грузятся редко.
 */

const TICK_MS = 20_000;
const BATCH_SIZE = 4;

/**
 * Как часто обновлять свечи каждого интервала.
 *
 * Список обязан совпадать с тем, что интерфейс предлагает выбрать.
 * Раньше здесь было три интервала, а в переключателе пять: `15m`
 * и `4h` не синхронизировались никогда, поэтому вкладка была пуста
 * гарантированно и всегда — не «иногда», как это выглядело.
 *
 * Частота обновления привязана к длине свечи: пятиминутку есть смысл
 * тянуть раз в пять минут, дневную — раз в несколько часов.
 */
const INTERVAL_FRESHNESS_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 30 * 60_000,
  '4h': 2 * 60 * 60_000,
  '1d': 6 * 60 * 60_000,
};

let running = false;
/** Позиция в круговом обходе токенов. */
let cursor = 0;

/**
 * Токены, которые кто-то открыл прямо сейчас.
 *
 * Обычный обход идёт по объёму и берёт триста штук. Токен за их
 * пределами не получил бы свечей никогда — а открывают чаще всего
 * именно такой: пришли по ссылке, по поиску, из радара.
 *
 * Очередь ограничена по размеру: без предела её мог бы раздуть
 * кто угодно, открывая карточки подряд. Порядок — от новых
 * к старым, потому что ждёт человек, открывший последним.
 */
const PRIORITY_LIMIT = 25;
const priority = new Set<string>();

/** Поставить токен в приоритет. Вызывается из маршрута свечей. */
export function requestCandlesSoon(tokenId: string): void {
  // Повторное добавление двигает токен в конец: он снова самый
  // свежий запрос.
  priority.delete(tokenId);
  priority.add(tokenId);

  while (priority.size > PRIORITY_LIMIT) {
    const oldest = priority.values().next().value as string | undefined;
    if (oldest == null) break;
    priority.delete(oldest);
  }
}

/** Сброс очереди между тестами. */
export function resetPriorityForTests(): void {
  priority.clear();
  cursor = 0;
}

/** Сколько токенов ждёт приоритетной загрузки. Для диагностики. */
export function priorityQueueSize(): number {
  return priority.size;
}

export async function syncCandlesBatch(): Promise<number> {
  const wanted = [...priority];

  const [hot, tokens] = await Promise.all([
    wanted.length > 0
      ? prisma.token.findMany({
          where: { id: { in: wanted }, poolAddress: { not: null } },
          select: { id: true, chain: true, symbol: true, poolAddress: true },
        })
      : Promise.resolve([]),

    prisma.token.findMany({
      where: { poolAddress: { not: null }, isHidden: false },
      select: { id: true, chain: true, symbol: true, poolAddress: true },
      orderBy: { volume24hUsd: 'desc' },
      take: 300,
    }),
  ]);

  // Открытые человеком идут первыми и по одному разу: дальше их
  // подхватит обычный круг, если они попадают в топ по объёму.
  for (const t of hot) priority.delete(t.id);

  const seen = new Set(hot.map((t) => t.id));
  const rest = tokens.filter((t) => !seen.has(t.id));

  const candidates = [...hot, ...rest].filter((t) => isMarketDataSupported(t.chain));
  if (candidates.length === 0) return 0;

  let processed = 0;

  // Приоритетные обрабатываются с начала списка, обычные — с позиции
  // кругового обхода. Иначе открытый токен снова оказался бы
  // в очереди за тремя сотнями чужих.
  const start = hot.length > 0 ? 0 : cursor;

  for (let i = 0; i < BATCH_SIZE && i < candidates.length; i++) {
    const token = candidates[(start + i) % candidates.length]!;

    for (const [interval, freshness] of Object.entries(INTERVAL_FRESHNESS_MS)) {
      // Пропускаем интервалы, обновлённые недавно: лимит запросов дороже
      // лишней точности на дневном графике.
      const newest = await prisma.candle.findFirst({
        where: { tokenId: token.id, interval },
        orderBy: { openTime: 'desc' },
        select: { openTime: true },
      });

      if (newest && Date.now() - newest.openTime.getTime() < freshness) continue;

      const candles = await fetchOhlcv(token.chain, token.poolAddress!, interval, 300);
      if (candles.length === 0) continue;

      // Пишем одной транзакцией: частично записанный набор свечей
      // рисует на графике разрывы, которые выглядят как обвал цены.
      await prisma.$transaction(
        candles.map((c) =>
          prisma.candle.upsert({
            where: {
              tokenId_interval_openTime: {
                tokenId: token.id,
                interval,
                openTime: c.openTime,
              },
            },
            create: {
              tokenId: token.id,
              interval,
              openTime: c.openTime,
              open: new P.Decimal(c.open),
              high: new P.Decimal(c.high),
              low: new P.Decimal(c.low),
              close: new P.Decimal(c.close),
              volumeUsd: new P.Decimal(c.volumeUsd || 0),
            },
            // Последняя свеча ещё формируется — её нужно перезаписывать,
            // иначе график замрёт на цене начала текущего интервала.
            update: {
              open: new P.Decimal(c.open),
              high: new P.Decimal(c.high),
              low: new P.Decimal(c.low),
              close: new P.Decimal(c.close),
              volumeUsd: new P.Decimal(c.volumeUsd || 0),
            },
          }),
        ),
      );

      processed++;
      logger.debug({ symbol: token.symbol, interval, count: candles.length }, 'свечи обновлены');
    }
  }

  // Курсор двигается только по обычному кругу: приоритетный проход
  // не должен сдвигать очередь остальных.
  if (hot.length === 0) cursor = (cursor + BATCH_SIZE) % candidates.length;

  return processed;
}

/** Удаление устаревших свечей: без этого таблица растёт бесконечно. */
export async function pruneOldCandles(): Promise<number> {
  const cutoffs: Record<string, number> = {
    '5m': 7 * 24 * 3600_000, // неделя пятиминуток
    '15m': 21 * 24 * 3600_000, // три недели пятнадцатиминуток
    '1h': 90 * 24 * 3600_000, // три месяца часовых
    '4h': 365 * 24 * 3600_000, // год четырёхчасовых
    '1d': 3 * 365 * 24 * 3600_000, // три года дневных
  };

  let deleted = 0;
  for (const [interval, maxAgeMs] of Object.entries(cutoffs)) {
    const res = await prisma.candle.deleteMany({
      where: { interval, openTime: { lt: new Date(Date.now() - maxAgeMs) } },
    });
    deleted += res.count;
  }
  return deleted;
}

export function startCandleBuilder() {
  if (running) return;
  running = true;

  const loop = async () => {
    let ticks = 0;
    while (running) {
      await syncCandlesBatch().catch((e) =>
        logger.error({ err: e?.message }, 'сбой загрузки свечей'),
      );

      // Уборка раз в час, а не каждый проход: удаление по времени —
      // тяжёлый запрос, и гонять его каждые двадцать секунд незачем.
      if (++ticks % 180 === 0) {
        const n = await pruneOldCandles().catch(() => 0);
        if (n > 0) logger.info({ deleted: n }, 'старые свечи удалены');
      }

      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  void loop();
  logger.info('загрузчик свечей запущен');
}

export function stopCandleBuilder() {
  running = false;
}
