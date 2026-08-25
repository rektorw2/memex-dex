/**
 * Свёртка старых дублей экономических сделок.
 *
 * ─── Зачем ──────────────────────────────────────────────────────────
 *
 * Phase 1 починила канонизацию для нового импорта: суммы больше
 * не входят в идентичность, и переводы одной транзакции складываются
 * в одну сделку. Но строки, записанные прежними правилами, лежат
 * в базе как есть — по строке на каждый перевод. Пока их не свернуть,
 * подробности кошелька продолжат показывать одну покупку много раз.
 *
 * ─── Чего этот сервис не делает ─────────────────────────────────────
 *
 * Не удаляет ничего. Старые строки помечаются `superseded` и получают
 * ссылку на каноническую; история остаётся целой, а статистика их
 * больше не считает.
 *
 * ─── Идемпотентность ────────────────────────────────────────────────
 *
 * Повторный запуск обязан давать тот же результат. Отсюда два
 * правила, и оба неочевидны.
 *
 * Первое: уже свёрнутые и неоднозначные строки в выборку не берутся
 * вовсе. Иначе второй проход сложил бы каноническую строку с её же
 * источниками и удвоил объём.
 *
 * Второе: канонические значения считаются от исходных переводов
 * группы, а не от текущего состояния канонической строки. Прибавлять
 * к уже агрегированному — тот же способ удвоить.
 */

import { Prisma as P } from '@prisma/client';
import {
  aggregateFills,
  historyTradeKey,
  STATS_RECONCILIATION_STATES,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface BackfillOptions {
  /** Без него ничего не пишется. */
  apply?: boolean;
  /** Ограничить одним кошельком — для безопасной проверки. */
  wallet?: string;
  chain?: string;
  /** Сколько строк просмотреть максимум. */
  limit?: number;
  /** Размер пачки чтения и транзакции записи. */
  batchSize?: number;
}

export interface BackfillReport {
  scanned: number;
  groups: number;
  /** Групп, где переводов больше одного: их и надо свернуть. */
  multiFillGroups: number;
  /** Строк, которые станут `superseded`. */
  wouldSupersede: number;
  /** Групп, которые сложить не удалось. */
  ambiguousGroups: number;
  walletsAffected: number;
  /** Записано на самом деле. В пробном прогоне всегда ноль. */
  canonicalWritten: number;
  supersededWritten: number;
  durationMs: number;
  applied: boolean;
}

/**
 * Одновременный `--apply` запрещён.
 *
 * Два процесса, сворачивающих одни и те же группы, увидели бы
 * одинаковый набор источников и записали бы каноническую строку
 * дважды — с разными итогами. Блокировка советующая: она защищает
 * от второго запуска, а не от злого умысла.
 */
const LOCK_KEY = 4_120_825;

async function withApplyLock<T>(fn: () => Promise<T>): Promise<T> {
  const rows = await prisma.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
  `;

  if (rows[0]?.locked !== true) {
    throw new Error('BACKFILL_ALREADY_RUNNING');
  }

  try {
    return await fn();
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}

interface Row {
  key: string;
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: string;
  amount: P.Decimal;
  valueUsd: P.Decimal;
  price: P.Decimal;
  marketCapUsd: P.Decimal | null;
  providerPnlUsd: P.Decimal | null;
  tradedAt: Date;
  fillCount: number;
  reconciliation: string;
}

/**
 * Каноническая строка группы выбирается детерминированно.
 *
 * Наименьший ключ по алфавиту. Любой другой выбор — «первая
 * по времени», «самая крупная» — зависел бы от данных, и повторный
 * запуск после нового импорта мог бы выбрать другую строку, оставив
 * две канонические.
 */
function pickCanonical(rows: Row[]): Row {
  return [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0]!;
}

export async function backfillEconomicTrades(
  opts: BackfillOptions = {},
): Promise<BackfillReport> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? 500;

  const report: BackfillReport = {
    scanned: 0,
    groups: 0,
    multiFillGroups: 0,
    wouldSupersede: 0,
    ambiguousGroups: 0,
    walletsAffected: 0,
    canonicalWritten: 0,
    supersededWritten: 0,
    durationMs: 0,
    applied: Boolean(opts.apply),
  };

  const run = async () => {
    const where = {
      // Свёрнутые и неоднозначные строки во второй проход не идут:
      // сложить каноническую с её же источниками значит удвоить объём.
      reconciliation: { in: [...STATS_RECONCILIATION_STATES] },
      ...(opts.wallet ? { walletAddress: opts.wallet } : {}),
      ...(opts.chain ? { chain: opts.chain as never } : {}),
    };

    const wallets = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      /*
       * Пагинация условием `key > cursor`, а не курсором Prisma.
       *
       * Разница принципиальная: проход меняет строки того самого
       * набора, по которому идёт. Строка-курсор к следующей итерации
       * уже помечена `superseded` и в выборку не попадает — курсор
       * Prisma опирается на её присутствие, и при её исчезновении
       * страница съезжает на начало. Проход зациклился бы, каждый
       * раз пересобирая одну и ту же группу.
       *
       * Сравнение по ключу от присутствия строки не зависит.
       */
      const rows: Row[] = await prisma.walletEconomicTrade.findMany({
        where: cursor ? { ...where, key: { gt: cursor } } : where,
        orderBy: { key: 'asc' },
        take: batchSize,
      });

      if (rows.length === 0) break;
      cursor = rows.at(-1)!.key;
      report.scanned += rows.length;

      /*
       * Группировка идёт по новой идентичности.
       *
       * Внутри пачки — а значит группа может оказаться разрезанной
       * границей пачки. Поэтому после группировки берутся все строки
       * группы отдельным запросом: иначе свёртка зависела бы
       * от размера пачки.
       */
      const groupKeys = new Set(
        rows.map((r) =>
          historyTradeKey({
            chain: r.chain as ChainKey,
            wallet: r.walletAddress,
            tokenAddress: r.tokenAddress,
            side: r.side as 'BUY' | 'SELL',
            tradedAt: r.tradedAt.getTime(),
          }),
        ),
      );

      for (const groupKey of groupKeys) {
        const [, , wallet, token, side, stamp] = groupKey.split('|');

        const members: Row[] = await prisma.walletEconomicTrade.findMany({
          where: {
            ...where,
            walletAddress: wallet!,
            tokenAddress: token!,
            side: side!,
            tradedAt: new Date(Number(stamp)),
          },
          orderBy: { key: 'asc' },
        });

        if (members.length === 0) continue;

        report.groups++;
        wallets.add(`${members[0]!.chain}:${wallet}`);

        // Одна строка и правильный ключ — уже канонично, трогать нечего.
        if (members.length === 1 && members[0]!.key === groupKey) continue;

        if (members.length > 1) report.multiFillGroups++;

        const agg = aggregateFills(
          members.map((m) => ({
            amount: m.amount.toString(),
            valueUsd: m.valueUsd.toString(),
            price: m.price.toString(),
            marketCapUsd: m.marketCapUsd?.toString() ?? null,
            providerPnlUsd: m.providerPnlUsd?.toString() ?? null,
            tradedAt: m.tradedAt.getTime(),
            tokenSymbol: m.tokenSymbol,
          })),
        );

        if (agg.ambiguous) report.ambiguousGroups++;

        const canonical = pickCanonical(members);
        const superseded = members.filter((m) => m.key !== canonical.key);
        report.wouldSupersede += superseded.length;

        if (!opts.apply) continue;

        /*
         * Запись одной транзакцией на группу.
         *
         * Свёртка без пометки источников оставила бы удвоенный
         * объём: каноническая строка уже содержит их суммы,
         * и незакрытые источники посчитались бы второй раз.
         */
        await prisma.$transaction(async (tx) => {
          await tx.walletEconomicTrade.update({
            where: { key: canonical.key },
            data: {
              amount: new P.Decimal(agg.amount),
              valueUsd: new P.Decimal(agg.valueUsd),
              price: new P.Decimal(agg.price),
              marketCapUsd: agg.marketCapUsd ? new P.Decimal(agg.marketCapUsd) : null,
              providerPnlUsd: agg.providerPnlUsd ? new P.Decimal(agg.providerPnlUsd) : null,
              fillCount: agg.fillCount,
              firstFillAt: new Date(agg.firstFillAt),
              lastFillAt: new Date(agg.lastFillAt),
              source: 'okx_dex_history',
              reconciliation: agg.ambiguous ? 'ambiguous' : 'canonical',
            },
          });

          if (superseded.length > 0) {
            await tx.walletEconomicTrade.updateMany({
              where: { key: { in: superseded.map((m) => m.key) } },
              data: { reconciliation: 'superseded', supersededBy: canonical.key },
            });
          }
        });

        report.canonicalWritten++;
        report.supersededWritten += superseded.length;
      }

      if (opts.limit != null && report.scanned >= opts.limit) break;
    }

    report.walletsAffected = wallets.size;
  };

  if (opts.apply) await withApplyLock(run);
  else await run();

  report.durationMs = Date.now() - started;

  logger.info(
    { ...report },
    opts.apply ? 'свёртка сделок: выполнена' : 'свёртка сделок: пробный прогон',
  );

  return report;
}
