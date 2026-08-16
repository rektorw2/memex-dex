import { Prisma as P } from '@prisma/client';
import {
  checkScam,
  checkSanity,
  crossCheck,
  judgeRoundTrip,
  checkAuthenticity,
  assessRisk,
  DEFAULT_RISK_CONFIG,
  type ScamSignals,
  type SourceReading,
  type Reason,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchSecurityFacts } from '../services/token-intel.js';
import { fetchTokenPair, isDexScreenerSupported } from '../services/dexscreener.js';
import { fetchJupiterToken } from '../services/jupiter.js';
import {
  fetchOkxTokenDetail,
  checkRoundTrip,
  isOkxConfigured,
  isOkxSupported,
} from '../services/okx.js';

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

/**
 * Версия набора правил.
 *
 * Увеличивается при каждом изменении логики проверки. Токены, у которых
 * записана меньшая версия, перепроверяются вне очереди, независимо
 * от времени последней проверки.
 *
 * Без этого механизма новое правило не действовало на уже проверенные
 * токены целые сутки: у них стояла свежая отметка времени, и очередь
 * до них не доходила. Подделки под NVDA так и остались в витрине после
 * добавления проверки, которая их ловит.
 *
 * История версий:
 *   1 — контракт (GoPlus), счётчики сделок, поведение пула
 *   2 — подделки под известные тикеры, клоны, правдоподобность чисел
 *   3 — сверка источников между собой, замер выхода через агрегатор
 */
const RULES_VERSION = 4;

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
      OR: [
        { scamCheckedAt: null },
        // Устаревшие правила важнее устаревшего времени: токен, проверенный
        // час назад по прежним правилам, опаснее проверенного вчера
        // по нынешним.
        { scamRulesVersion: { lt: RULES_VERSION } },
        { scamCheckedAt: { lt: stale } },
      ],
    },
    orderBy: [
      { scamRulesVersion: 'asc' },
      { scamCheckedAt: { sort: 'asc', nulls: 'first' } },
      { volume24hUsd: 'desc' },
    ],
    take: limit,
  });

  if (tokens.length === 0) return { checked: 0, blocked: 0, warned: 0, ok: 0 };

  const result: CheckResult = { checked: 0, blocked: 0, warned: 0, ok: 0 };

  // Одноимённые токены считаются одним запросом на всю пачку: три NVDA
  // с разными адресами — это не совпадение, а рассылка шаблона, и увидеть
  // её можно только глядя на витрину целиком, а не на токен по отдельности.
  const clones = await countClones(tokens.map((t) => t.symbol));

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

      const poolAgeHours = pair?.pairCreatedAt
        ? (Date.now() - pair.pairCreatedAt.getTime()) / 3_600_000
        : null;

      // ─── Сверка источников ────────────────────────────────────────
      // Раньше здесь брался максимум из известных значений, и это было
      // ошибкой: достаточно одному источнику ошибиться в большую
      // сторону, чтобы завышенное число прошло дальше. Ровно так
      // в витрину попал токен с ликвидностью в три с половиной
      // миллиарда долларов на Base.
      //
      // Теперь источники проверяют друг друга. У настоящего токена они
      // видят один пул и сообщают близкие числа; расхождение в разы
      // означает, что как минимум один читает подделку.
      const readings: SourceReading[] = [
        {
          source: 'GeckoTerminal',
          priceUsd: token.priceUsd != null ? Number(token.priceUsd) : null,
          liquidityUsd: token.liquidityUsd != null ? Number(token.liquidityUsd) : null,
          volume24hUsd: token.volume24hUsd != null ? Number(token.volume24hUsd) : null,
        },
      ];

      if (isDexScreenerSupported(token.chain)) {
        readings.push({
          source: 'DexScreener',
          priceUsd: pair?.priceUsd ?? null,
          liquidityUsd: pair?.liquidityUsd ?? null,
          volume24hUsd: pair?.volume24hUsd ?? null,
        });
      }

      if (isOkxConfigured() && isOkxSupported(token.chain)) {
        readings.push({
          source: 'OKX',
          priceUsd: okx?.priceUsd ?? null,
          liquidityUsd: okx?.liquidityUsd ?? null,
          volume24hUsd: okx?.volume24hUsd ?? null,
        });
      }

      const cross = crossCheck(readings, { poolAgeHours });

      // Дальше в расчёт идут согласованные значения — медиана,
      // а не максимум.
      const liquidityUsd = cross.agreed.liquidityUsd;
      const volume24hUsd = cross.agreed.volume24hUsd;

      // Сигналы собираются для наглядности и журнала; решение
      // принимается по кодам причин ниже.
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


      // ─── Подделки и клоны ─────────────────────────────────────────
      // Проверка контракта этот класс не ловит вовсе: у токена может
      // быть всё в порядке с эмиссией и налогами, и при этом он
      // называется NVDA и выдаёт себя за акцию NVIDIA.
      const clone = clones.get(token.symbol.toUpperCase()) ?? {
        count: 1,
        maxLiquidity: null,
      };

      // Подлинность определяется совпадением адреса, а не тикером.
      // Прежняя проверка блокировала любой токен с символом NVDA,
      // включая настоящий, если бы он появился.
      const auth = checkAuthenticity(
        token.chain as ChainKey,
        token.address,
        token.symbol,
      );

      // Jupiter знает про Solana то, чего не знает никто: собственные
      // метки banned и isSus по итогам их аудита.
      const jup =
        token.chain === 'SOLANA'
          ? await fetchJupiterToken(token.address).catch(() => null)
          : null;

      const sanity = checkSanity({
        liquidityUsd,
        volume24hUsd,
        fdvUsd: token.fdvUsd != null ? Number(token.fdvUsd) : null,
        priceChange24h: token.priceChange24h != null ? Number(token.priceChange24h) : null,
      });

      // ─── Сбор причин с кодами ─────────────────────────────────────
      const reasons: Reason[] = [];
      const cfg = DEFAULT_RISK_CONFIG;

      if (auth.isImpersonation) {
        reasons.push({ code: 'FAKE_SYMBOL', message: auth.reason!, weight: 100 });
      }

      if (jup?.isBanned) {
        reasons.push({
          code: 'JUPITER_BANNED',
          message: 'Jupiter исключил токен из реестра',
          weight: 100,
        });
      }
      if (jup?.isSuspicious) {
        reasons.push({
          code: 'JUPITER_SUSPICIOUS',
          message: 'Аудит Jupiter пометил токен как подозрительный',
          weight: 100,
        });
      }

      if (security?.isHoneypot === true) {
        reasons.push({
          code: 'HONEYPOT',
          message: 'Продажа заблокирована контрактом',
          weight: 100,
        });
      }
      if (security?.sellTaxPct != null && security.sellTaxPct >= cfg.maxSellTaxPct) {
        reasons.push({
          code: 'HIGH_SELL_TAX',
          message: `Налог на продажу ${security.sellTaxPct.toFixed(0)}%`,
          weight: 100,
        });
      }
      if (security?.freezable === true) {
        reasons.push({
          code: 'FREEZE_AUTHORITY_ACTIVE',
          message: 'Токен можно заморозить на вашем кошельке',
          weight: 100,
        });
      }
      if (security?.creatorPct != null && security.creatorPct > cfg.maxCreatorPct) {
        reasons.push({
          code: 'CREATOR_CONTROLS_SUPPLY',
          message: `У создателя ${security.creatorPct.toFixed(0)}% предложения`,
          weight: 100,
        });
      }
      if (liquidityUsd != null && liquidityUsd > 0 && liquidityUsd < cfg.minLiquidityUsd) {
        reasons.push({
          code: 'LOW_LIQUIDITY',
          message: `Ликвидность $${Math.round(liquidityUsd).toLocaleString('ru-RU')} — выйти без обвала нельзя`,
          weight: 100,
        });
      }
      for (const s of sanity) {
        reasons.push({ code: 'IMPLAUSIBLE_METRICS', message: s, weight: 100 });
      }
      for (const b of cross.blockers) {
        reasons.push({ code: 'SOURCE_PRICE_MISMATCH', message: b, weight: 100 });
      }

      // ─── Повышающие риск ──────────────────────────────────────────
      if (security?.mintable === true || jup?.mintAuthorityActive === true) {
        reasons.push({
          code: 'MINT_AUTHORITY_ACTIVE',
          message: 'Эмиссию можно допечатать',
          weight: 30,
        });
      }
      if (security?.lpLocked === false) {
        reasons.push({
          code: 'UNLOCKED_LIQUIDITY',
          message: 'Ликвидность не залочена',
          weight: 20,
        });
      }
      if (security?.ownerCanModify === true) {
        reasons.push({
          code: 'OWNER_CAN_MODIFY',
          message: 'Владелец может менять правила контракта',
          weight: 15,
        });
      }
      if (
        security?.sellTaxPct != null &&
        security.sellTaxPct > cfg.elevatedSellTaxPct &&
        security.sellTaxPct < cfg.maxSellTaxPct
      ) {
        reasons.push({
          code: 'ELEVATED_SELL_TAX',
          message: `Налог на продажу ${security.sellTaxPct.toFixed(0)}%`,
          weight: 10,
        });
      }

      const top10 = jup?.topHoldersPct ?? security?.top10Pct ?? null;
      if (top10 != null && top10 > cfg.highConcentrationPct) {
        reasons.push({
          code: 'HIGH_HOLDER_CONCENTRATION',
          message: `У топ-10 держателей ${top10.toFixed(0)}% предложения`,
          weight: top10 > cfg.criticalConcentrationPct ? 30 : 15,
        });
      }

      const holders = jup?.holderCount ?? security?.holderCount ?? null;
      if (holders != null && holders < cfg.minHolders) {
        reasons.push({
          code: 'FEW_HOLDERS',
          message: `Держателей всего ${holders}`,
          weight: 10,
        });
      }

      if (
        volume24hUsd != null &&
        liquidityUsd != null &&
        liquidityUsd > 0 &&
        volume24hUsd / liquidityUsd > cfg.maxVolumeToLiquidity
      ) {
        reasons.push({
          code: 'SUSPICIOUS_VOLUME',
          message: `Оборот в ${Math.round(volume24hUsd / liquidityUsd)} раз выше ликвидности`,
          weight: 20,
        });
      }

      const buys = pair?.buys24h ?? null;
      const sells = pair?.sells24h ?? null;
      if (buys != null && sells != null && buys + sells >= cfg.minTradesForRatio) {
        if (sells === 0 || buys / sells > cfg.maxBuySellRatio) {
          reasons.push({
            code: 'ONE_SIDED_TRADING',
            message:
              sells === 0
                ? `${buys} покупок и ни одной продажи за сутки`
                : `Покупок в ${(buys / sells).toFixed(0)} раз больше, чем продаж`,
            weight: sells === 0 ? 35 : 25,
          });
        }
      }

      if (poolAgeHours != null && poolAgeHours < cfg.youngPoolHours) {
        reasons.push({
          code: 'YOUNG_POOL',
          message: `Пулу ${poolAgeHours.toFixed(1)} ч — история не сложилась`,
          weight: 10,
        });
      }

      if (clone.count > 1) {
        const minor =
          liquidityUsd != null &&
          clone.maxLiquidity != null &&
          liquidityUsd * 10 < clone.maxLiquidity;

        reasons.push({
          code: minor ? 'MINOR_CLONE' : 'DUPLICATE_SYMBOL',
          message: minor
            ? `Ещё ${clone.count - 1} токен(ов) с этим тикером, и этот не крупнейший`
            : `Токенов с тикером ${token.symbol}: ${clone.count}`,
          weight: minor ? 30 : 10,
        });
      }

      for (const w of cross.warnings) {
        reasons.push({ code: 'SINGLE_SOURCE', message: w, weight: 15 });
      }

      if (!security?.source) {
        reasons.push({
          code: 'SECURITY_DATA_UNAVAILABLE',
          message: 'Проверка контракта недоступна',
          weight: 25,
        });
      }



      // ─── Замер выхода через агрегатор OKX ──────────────────────────
      //
      // Самая сильная проверка и самая дорогая: два запроса на токен.
      // Применяется только к тем, у кого нет критических причин —
      // тратить лимит на уже заблокированный токен незачем.
      let roundTrip: ReturnType<typeof judgeRoundTrip> | null = null;
      const hasCriticalSoFar = reasons.some((r) => r.weight >= 100);

      if (!hasCriticalSoFar && isOkxConfigured() && isOkxSupported(token.chain)) {
        const rt = await checkRoundTrip(token.chain, token.address).catch(() => null);

        if (rt) {
          roundTrip = judgeRoundTrip(rt);

          if (roundTrip.verdict === 'BLOCK') {
            reasons.push({
              code: rt.canSell ? 'CANNOT_SELL_ALL' : 'SELL_FAILED',
              message: roundTrip.reason,
              weight: 100,
            });
          } else if (roundTrip.verdict === 'WARN') {
            reasons.push({
              code: 'COSTLY_ROUND_TRIP',
              message: roundTrip.reason,
              weight: 20,
            });
          }
        }
      }

      // ─── Итоговый уровень ─────────────────────────────────────────
      const risk = assessRisk({
        reasons,
        securityChecked: Boolean(security?.source) || Boolean(jup),
        isVerifiedAsset: auth.isVerified,
      });

      // Совместимость со старым полем: часть запросов ещё смотрит
      // на scamVerdict, и оставлять его рассогласованным нельзя.
      const legacyVerdict =
        risk.level === 'blocked' ? 'BLOCK' : risk.level === 'verified' || risk.level === 'low' ? 'OK' : 'WARN';

      await prisma.token.update({
        where: { id: token.id },
        data: {
          riskLevel: risk.level,
          riskCodes: risk.codes,
          isRegistered: auth.isVerified,
          scamVerdict: legacyVerdict,
          scamReasons: {
            level: risk.level,
            score: risk.score,
            reasons: risk.reasons.map((r) => ({ code: r.code, message: r.message })),
            // Старые поля оставлены: интерфейс переходит на новые
            // постепенно, и ломать его одним махом незачем.
            blockers: risk.reasons.filter((r) => r.weight >= 100).map((r) => r.message),
            warnings: risk.reasons.filter((r) => r.weight < 100).map((r) => r.message),
            sources: {
              goplus: Boolean(security?.source),
              dexscreener: Boolean(pair),
              okx: Boolean(okx),
              jupiter: Boolean(jup),
              // Согласие источников — часть объяснения вердикта:
              // «цена подтверждена тремя» и «известен одному» это
              // разные основания доверять числу.
              known: cross.known,
              queried: cross.queried,
              priceSpread: cross.priceSpread,
              // Измеренная стоимость выхода — самое конкретное, что
              // мы знаем о токене, и её стоит хранить отдельно.
              roundTrip: roundTrip
                ? { verdict: roundTrip.verdict, lossPct: roundTrip.lossPct }
                : null,
            },
          } as unknown as P.InputJsonValue,
          scamCheckedAt: new Date(),
          scamRulesVersion: RULES_VERSION,
          riskScore: risk.score,

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
          // В базу идут согласованные значения: показывать в терминале
          // число, которое подтвердил один источник из трёх, значит
          // выдавать догадку за факт.
          ...(cross.agreed.priceUsd != null
            ? { priceUsd: new P.Decimal(cross.agreed.priceUsd) }
            : {}),
          ...(liquidityUsd != null ? { liquidityUsd: new P.Decimal(liquidityUsd) } : {}),
          ...(volume24hUsd != null ? { volume24hUsd: new P.Decimal(volume24hUsd) } : {}),
        },
      });

      result.checked++;
      if (risk.level === 'blocked') result.blocked++;
      else if (risk.level === 'verified' || risk.level === 'low') result.ok++;
      else result.warned++;

      if (risk.level === 'blocked') {
        logger.info(
          {
            symbol: token.symbol,
            chain: token.chain,
            codes: risk.codes,
            reason: risk.reasons[0]?.message,
          },
          'токен заблокирован в витрине',
        );
      }
    } catch (e: any) {
      // Сбой на одном токене не должен останавливать проход: следующий
      // может быть как раз тем, который надо заблокировать.
      logger.warn({ err: e?.message, symbol: token.symbol }, 'проверка токена не удалась');

      // Отметку времени ставим всё равно, иначе токен, который стабильно
      // роняет проверку, будет вечно занимать место в очереди.
      // Версию не проставляем: токен, который уронил проверку, должен
      // попасть в неё снова при следующем изменении правил, а не считаться
      // разобранным.
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

/**
 * Число одноимённых токенов и наибольшая ликвидность среди них.
 *
 * Считается по всей витрине, а не по проверяемой пачке: клон мог быть
 * заведён неделю назад и в текущую пачку не попасть, а сравнивать
 * нужно именно с ним.
 */
async function countClones(
  symbols: string[],
): Promise<Map<string, { count: number; maxLiquidity: number | null }>> {
  const out = new Map<string, { count: number; maxLiquidity: number | null }>();
  if (symbols.length === 0) return out;

  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];

  const rows = await prisma.token.findMany({
    where: {
      isQuote: false,
      isHidden: false,
      symbol: { in: unique, mode: 'insensitive' },
    },
    select: { symbol: true, liquidityUsd: true },
  });

  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const prev = out.get(key) ?? { count: 0, maxLiquidity: null };
    const liq = r.liquidityUsd != null ? Number(r.liquidityUsd) : null;

    out.set(key, {
      count: prev.count + 1,
      maxLiquidity:
        liq != null && (prev.maxLiquidity == null || liq > prev.maxLiquidity)
          ? liq
          : prev.maxLiquidity,
    });
  }

  return out;
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
