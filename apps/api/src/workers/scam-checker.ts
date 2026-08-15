import { Prisma as P } from '@prisma/client';
import { checkScam, type ScamSignals } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchSecurityFacts } from '../services/token-intel.js';
import { fetchTokenPair, isDexScreenerSupported } from '../services/dexscreener.js';
import { fetchOkxTokenDetail, isOkxConfigured, isOkxSupported } from '../services/okx.js';

/**
 * Проверка токенов витрины на очевидные ловушки.
 *
 * Раньше этой проверки не было вовсе: импортёр считал риск по ликвидности,
 * объёму и возрасту пула, а данные о самом контракте — активный mint,
 * возможность заморозки, налог на продажу — до терминала не доходили.
 * В результате в списке оказывались токены, которые нельзя продать,
 * и отличить их от обычных было нечем.
 *
 * Источники складываются, а не заменяют друг друга:
 *
 *   GoPlus       — свойства контракта. Единственный источник, который
 *                  отвечает на вопрос «можно ли продать».
 *   DexScreener  — счётчики покупок и продаж. Ловит ханипоты, которые
 *                  проверка контракта пропустила: продать формально
 *                  можно, но за сутки никто не смог.
 *   OKX Web3     — независимое подтверждение цены и ликвидности,
 *                  если ключи настроены.
 *
 * Ни один источник не считается истиной сам по себе. Отсутствие данных
 * трактуется как «не проверено», а не как «всё чисто» — иначе токен,
 * который не удалось проверить, выглядел бы надёжнее проверенного
 * и найденного плохим.
 */

const TICK_MS = 45_000;
/**
 * Токенов за проход. Ограничитель — GoPlus: у него порядка 30 запросов
 * в минуту без ключа, и делить его больше не с кем.
 */
const BATCH = 8;
/** Перепроверка не чаще раза в сутки: свойства контракта меняются редко. */
const RECHECK_HOURS = 24;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface CheckResult {
  checked: number;
  blocked: number;
  warned: number;
  ok: number;
}

export async function checkBatch(limit = BATCH): Promise<CheckResult> {
  const stale = new Date(Date.now() - RECHECK_HOURS * 3_600_000);

  const tokens = await prisma.token.findMany({
    where: {
      isQuote: false,
      isHidden: false,
      OR: [{ scamCheckedAt: null }, { scamCheckedAt: { lt: stale } }],
    },
    // Непроверенные вперёд: у них вердикта нет вообще, и в терминале
    // они висят без пометки.
    orderBy: [{ scamCheckedAt: { sort: 'asc', nulls: 'first' } }, { volume24hUsd: 'desc' }],
    take: limit,
  });

  if (tokens.length === 0) return { checked: 0, blocked: 0, warned: 0, ok: 0 };

  const result: CheckResult = { checked: 0, blocked: 0, warned: 0, ok: 0 };

  for (const token of tokens) {
    try {
      const [security, pair, okx] = await Promise.all([
        fetchSecurityFacts(token.chain, token.address).catch(() => null),
        isDexScreenerSupported(token.chain)
          ? fetchTokenPair(token.chain, token.address).catch(() => null)
          : Promise.resolve(null),
        isOkxConfigured() && isOkxSupported(token.chain)
          ? fetchOkxTokenDetail(token.chain, token.address).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Ликвидность берём наибольшую из известных: разные источники
      // видят разные пулы, и заниженное значение привело бы к блокировке
      // токена, у которого ликвидность на самом деле есть.
      const liquidityUsd = maxOf([
        token.liquidityUsd != null ? Number(token.liquidityUsd) : null,
        pair?.liquidityUsd ?? null,
        okx?.liquidityUsd ?? null,
      ]);

      const volume24hUsd = maxOf([
        token.volume24hUsd != null ? Number(token.volume24hUsd) : null,
        pair?.volume24hUsd ?? null,
        okx?.volume24hUsd ?? null,
      ]);

      const poolAgeHours = pair?.pairCreatedAt
        ? (Date.now() - pair.pairCreatedAt.getTime()) / 3_600_000
        : null;

      const signals: ScamSignals = {
        isHoneypot: security?.isHoneypot ?? null,
        mintable: security?.mintable ?? null,
        freezable: security?.freezable ?? null,
        ownerCanModify: security?.ownerCanModify ?? null,
        buyTaxPct: security?.buyTaxPct ?? null,
        sellTaxPct: security?.sellTaxPct ?? null,
        lpLocked: security?.lpLocked ?? null,
        top10Pct: security?.top10Pct ?? null,
        creatorPct: security?.creatorPct ?? null,
        holderCount: security?.holderCount ?? null,
        liquidityUsd,
        volume24hUsd,
        buys24h: pair?.buys24h ?? null,
        sells24h: pair?.sells24h ?? null,
        poolAgeHours,
        // Проверенным считается только тот случай, когда источник
        // действительно ответил хоть по одному свойству контракта.
        securityChecked: Boolean(security?.source),
      };

      const decision = checkScam(signals);

      await prisma.token.update({
        where: { id: token.id },
        data: {
          scamVerdict: decision.verdict,
          scamReasons: {
            blockers: decision.blockers,
            warnings: decision.warnings,
            sources: {
              goplus: Boolean(security?.source),
              dexscreener: Boolean(pair),
              okx: Boolean(okx),
            },
          } as unknown as P.InputJsonValue,
          scamCheckedAt: new Date(),
          riskScore: decision.score,

          buys24h: pair?.buys24h ?? null,
          sells24h: pair?.sells24h ?? null,

          // Данные, которых у GeckoTerminal нет или они хуже.
          ...(security?.isHoneypot != null ? { isHoneypot: security.isHoneypot } : {}),
          ...(security?.holderCount != null ? { holders: security.holderCount } : {}),
          ...(security?.top10Pct != null
            ? { topHolderPct: new P.Decimal(security.top10Pct) }
            : {}),
          // Логотип не перезаписываем, если он уже есть: админ мог
          // поставить свой.
          ...(pair?.logoUrl && !token.logoUrl ? { logoUrl: pair.logoUrl } : {}),
          ...(pair && (pair.websites.length > 0 || pair.socials.length > 0)
            ? {
                socials: {
                  websites: pair.websites,
                  socials: pair.socials,
                } as unknown as P.InputJsonValue,
              }
            : {}),
          ...(liquidityUsd != null ? { liquidityUsd: new P.Decimal(liquidityUsd) } : {}),
          ...(volume24hUsd != null ? { volume24hUsd: new P.Decimal(volume24hUsd) } : {}),
        },
      });

      result.checked++;
      if (decision.verdict === 'BLOCK') result.blocked++;
      else if (decision.verdict === 'WARN') result.warned++;
      else result.ok++;

      if (decision.verdict === 'BLOCK') {
        logger.info(
          { symbol: token.symbol, chain: token.chain, reason: decision.blockers[0] },
          'токен заблокирован в витрине',
        );
      }
    } catch (e: any) {
      // Сбой на одном токене не должен останавливать проход: следующий
      // может быть как раз тем, который надо заблокировать.
      logger.warn({ err: e?.message, symbol: token.symbol }, 'проверка токена не удалась');

      // Отметку времени ставим всё равно, иначе токен, который стабильно
      // роняет проверку, будет вечно занимать место в очереди.
      await prisma.token
        .update({ where: { id: token.id }, data: { scamCheckedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  if (result.blocked > 0 || result.warned > 0) {
    logger.info(result, 'проверка витрины: проход завершён');
  }

  return result;
}

function maxOf(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  return known.length > 0 ? Math.max(...known) : null;
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await checkBatch();
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'проверка витрины: ошибка прохода');
  } finally {
    running = false;
  }
}

export function startScamChecker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  logger.info('проверка витрины запущена');
}

export function stopScamChecker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
