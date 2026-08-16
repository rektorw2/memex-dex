/**
 * Оценка риска находок радара тем же движком, что у терминала.
 *
 * До этого радар считал риск сам: по ликвидности, объёму и возрасту
 * пула. Получалось, что один и тот же токен мог быть «низкий риск»
 * в радаре и «заблокирован» в терминале — и человек, увидевший его
 * в ленте находок, не понимал, почему в терминале его нет.
 *
 * Два раздела одного продукта не могут расходиться в том, опасен
 * токен или нет. Поэтому проверка теперь одна.
 *
 * Осталось объяснить, почему это отдельный воркер, а не вызов внутри
 * сканера. Находки появляются пачками и быстро, а полная проверка
 * стоит семи обращений к внешним источникам. Считать её синхронно
 * означало бы задерживать саму находку — а радар ценен именно тем,
 * что показывает токен через минуты после запуска пула. Поэтому
 * находка попадает в ленту сразу, без уровня риска, и получает его
 * следующим проходом.
 *
 * Пустой уровень при этом честно означает «ещё не проверяли»,
 * а не «проверено, всё чисто».
 */

import { Prisma as P } from '@prisma/client';
import {
  assessRisk,
  checkAuthenticity,
  checkRwa,
  concentrationRulesApply,
  DEFAULT_RISK_CONFIG,
  type Reason,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchSecurityFacts } from '../services/token-intel.js';
import { fetchJupiterToken } from '../services/jupiter.js';
import { fetchRwaRegistry, safeCall } from '../services/okx-market.js';
import { fetchAdvancedInfo, readTags, readOkxRisk } from '../services/okx-security.js';
import { checkHoneypot, isHoneypotSupported } from '../services/honeypot.js';
import { checkRugcheck, isAbsoluteFinding } from '../services/rugcheck.js';
import { isOkxConfigured, isOkxSupported } from '../services/okx.js';

/**
 * Версия правил радара.
 *
 * Своя, а не общая с терминалом: наборы источников различаются —
 * у находки нет счётчиков сделок за сутки и нет замера круга,
 * потому что пулу может быть десять минут. Общий номер означал бы,
 * что изменение правил терминала гоняет перепроверку радара впустую.
 */
export const RADAR_RULES_VERSION = 1;

const TICK_MS = 30_000;
/** Находок за проход. Ограничитель тот же — лимиты GoPlus. */
const BATCH = 6;
/** Бюджет времени, заметно меньше интервала между проходами. */
const BUDGET_MS = 18_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface RadarRiskResult {
  checked: number;
  blocked: number;
  remaining?: number;
}

export async function assessRadarBatch(limit = BATCH): Promise<RadarRiskResult> {
  const deadline = Date.now() + BUDGET_MS;

  const events = await prisma.radarEvent.findMany({
    where: {
      // Только те, за кем ещё следим: разбирать мёртвый пул незачем.
      isTracking: true,
      riskRulesVersion: { lt: RADAR_RULES_VERSION },
    },
    // Свежие вперёд: находка ценна первые часы, и уровень риска
    // нужен ей именно тогда, а не через сутки.
    orderBy: { firstSeenAt: 'desc' },
    take: limit,
  });

  const result: RadarRiskResult = { checked: 0, blocked: 0 };
  if (events.length === 0) return result;

  const rwaRegistry = await fetchRwaRegistry();

  for (const [index, e] of events.entries()) {
    if (Date.now() > deadline) {
      result.remaining = events.length - index;
      break;
    }

    try {
      const chain = e.chain as ChainKey;

      const [security, advanced, honeypot, rug, jup] = await Promise.all([
        fetchSecurityFacts(e.chain, e.address).catch(() => null),
        isOkxConfigured() && isOkxSupported(chain)
          ? fetchAdvancedInfo(chain, e.address, safeCall).catch(() => null)
          : Promise.resolve(null),
        isHoneypotSupported(chain)
          ? checkHoneypot(chain, e.address).catch(() => null)
          : Promise.resolve(null),
        chain === 'SOLANA' ? checkRugcheck(e.address).catch(() => null) : Promise.resolve(null),
        chain === 'SOLANA' ? fetchJupiterToken(e.address).catch(() => null) : Promise.resolve(null),
      ]);

      const tags = advanced ? readTags(advanced.tags) : null;
      const okxRisk = readOkxRisk(advanced?.riskControlLevel ?? null);
      const cfg = DEFAULT_RISK_CONFIG;

      const auth = checkAuthenticity(chain, e.address, e.symbol);
      const rwa = checkRwa(
        { chain, address: e.address, symbol: e.symbol, tags: advanced?.tags },
        rwaRegistry,
      );

      const reasons: Reason[] = [];

      // ─── Причины, при которых токен не показывается ───────────────
      if (auth.isImpersonation) {
        reasons.push({ code: 'FAKE_SYMBOL', message: auth.reason!, weight: 100 });
      }
      if (rwa.isFakeRwa) {
        reasons.push({ code: 'FAKE_RWA_TICKER', message: rwa.reason!, weight: 100 });
      }
      if (rwa.isUndetermined) {
        reasons.push({ code: 'UNVERIFIED_RWA_CLAIM', message: rwa.reason!, weight: 40 });
      }
      if (okxRisk.hardBlock) {
        reasons.push({ code: 'OKX_HIGH_RISK', message: okxRisk.explanation, weight: 100 });
      } else if (okxRisk.band === 'caution') {
        reasons.push({ code: 'OKX_CAUTION', message: okxRisk.explanation, weight: 20 });
      }
      if (tags?.isHoneypot || security?.isHoneypot === true || honeypot?.isHoneypot) {
        reasons.push({
          code: 'HONEYPOT',
          message: honeypot?.reason ?? 'Продажа заблокирована контрактом',
          weight: 100,
        });
      }
      if (honeypot?.sellFailed) {
        reasons.push({ code: 'SELL_FAILED', message: 'Симуляция продажи не прошла', weight: 100 });
      }
      if (security?.freezable === true) {
        reasons.push({
          code: 'FREEZE_AUTHORITY_ACTIVE',
          message: 'Токен можно заморозить на вашем кошельке',
          weight: 100,
        });
      }
      const sellTax = honeypot?.sellTaxPct ?? security?.sellTaxPct ?? null;
      if (sellTax != null && sellTax >= cfg.maxSellTaxPct) {
        reasons.push({
          code: 'HIGH_SELL_TAX',
          message: `Налог на продажу ${sellTax.toFixed(0)}%`,
          weight: 100,
        });
      }
      if (jup?.isBanned) {
        reasons.push({ code: 'JUPITER_BANNED', message: 'Jupiter исключил токен', weight: 100 });
      }
      if (rug?.hasCritical) {
        const worst = rug.risks.find((r) => isAbsoluteFinding(r.name));
        reasons.push({
          code: 'RUGCHECK_CRITICAL',
          message: worst?.description ?? 'RugCheck: выход из позиции невозможен',
          weight: 100,
        });
      }

      const liq = e.liquidityUsd != null ? Number(e.liquidityUsd) : null;
      // Ноль — это не «неизвестно», а «пул пуст». Прежнее условие
      // требовало liq > 0 и потому пропускало именно тот случай,
      // ради которого правило писалось: осушенный пул с ликвидностью
      // в районе нуля не срабатывал вовсе, и токен оставался в ленте
      // с оборотом в сотни тысяч при пустом пуле.
      //
      // Неизвестность по-прежнему отсеивается проверкой на null.
      if (liq != null && liq < cfg.minLiquidityUsd) {
        reasons.push({
          code: 'LOW_LIQUIDITY',
          message: `Ликвидность $${Math.round(liq).toLocaleString('ru-RU')} — выйти без обвала нельзя`,
          weight: 100,
        });
      }

      // ─── Повышающие риск ──────────────────────────────────────────
      if (jup?.isSuspicious) {
        reasons.push({
          code: 'JUPITER_SUSPICIOUS',
          message: 'Аудит Jupiter пометил токен как подозрительный',
          weight: 45,
        });
      }
      if (security?.mintable === true || jup?.mintAuthorityActive === true) {
        reasons.push({
          code: 'MINT_AUTHORITY_ACTIVE',
          message: 'Эмиссию можно допечатать',
          weight: 25,
        });
      }
      if (security?.lpLocked === false || (advanced?.lpBurnedPct ?? 100) < 50) {
        reasons.push({
          code: 'UNLOCKED_LIQUIDITY',
          message: 'Ликвидность не заблокирована',
          weight: 15,
        });
      }
      if (security?.ownerCanModify === true) {
        reasons.push({
          code: 'OWNER_CAN_MODIFY',
          message: 'Владелец может менять правила контракта',
          weight: 15,
        });
      }

      if (concentrationRulesApply(rwa)) {
        const top10 = advanced?.top10HoldPct ?? jup?.topHoldersPct ?? security?.top10Pct ?? null;
        if (top10 != null && top10 > cfg.highConcentrationPct) {
          reasons.push({
            code: 'HIGH_TOP10_CONCENTRATION',
            message: `У топ-10 держателей ${top10.toFixed(0)}% предложения`,
            weight: top10 > cfg.criticalConcentrationPct ? 25 : 10,
          });
        }
        if (advanced?.devHoldingPct != null && advanced.devHoldingPct > cfg.maxCreatorPct) {
          reasons.push({
            code: 'HIGH_DEV_HOLDING',
            message: `У создателя ${advanced.devHoldingPct.toFixed(0)}% предложения`,
            weight: advanced.devHoldingPct > 40 ? 100 : 35,
          });
        }
        if (advanced?.bundleHoldingPct != null && advanced.bundleHoldingPct > 25) {
          reasons.push({
            code: 'HIGH_BUNDLE_HOLDING',
            message: `Связанные кошельки держат ${advanced.bundleHoldingPct.toFixed(0)}%`,
            weight: advanced.bundleHoldingPct > 50 ? 100 : 35,
          });
        }
      }

      const holders = e.currentHolders ?? security?.holderCount ?? jup?.holderCount ?? null;
      if (holders != null && holders < cfg.minHolders) {
        reasons.push({ code: 'FEW_HOLDERS', message: `Держателей всего ${holders}`, weight: 10 });
      }

      // Юный пул для радара — не порок, а предмет. Вес символический:
      // он нужен, чтобы отличить находку двухминутной давности
      // от суточной, а не чтобы её прятать.
      const age = e.poolAgeHours != null ? Number(e.poolAgeHours) : null;
      if (age != null && age < cfg.youngPoolHours) {
        reasons.push({
          code: 'YOUNG_POOL',
          message: `Пулу ${age < 1 ? `${Math.round(age * 60)} мин` : `${age.toFixed(1)} ч`}`,
          weight: 5,
        });
      }

      if (!security?.source && !advanced && !honeypot?.simulated && !rug) {
        reasons.push({
          code: 'SECURITY_DATA_UNAVAILABLE',
          message: 'Проверка контракта недоступна',
          weight: 0,
        });
      }

      const securityChecked =
        Boolean(security?.source) ||
        Boolean(advanced) ||
        Boolean(honeypot?.simulated) ||
        Boolean(rug) ||
        Boolean(jup);

      const risk = assessRisk({
        reasons,
        securityChecked,
        isVerifiedAsset: auth.isVerified || rwa.isGenuineRwa,
      });

      await prisma.radarEvent.update({
        where: { id: e.id },
        data: {
          riskLevel: risk.level,
          riskCodes: risk.codes,
          riskRulesVersion: RADAR_RULES_VERSION,
          riskScore: risk.score,
          // Тексты причин остаются для карточки: код говорит, что
          // сработало, текст — почему это важно.
          riskFlags: risk.reasons.map((r) => r.message) as unknown as P.InputJsonValue,
          ...(security?.holderCount != null && e.currentHolders == null
            ? { currentHolders: security.holderCount }
            : {}),
          ...(advanced?.top10HoldPct != null
            ? { currentTop10Pct: new P.Decimal(advanced.top10HoldPct) }
            : {}),
        },
      });

      result.checked++;
      if (risk.level === 'blocked') result.blocked++;
    } catch (err: any) {
      logger.warn({ err: err?.message, symbol: e.symbol }, 'оценка находки не удалась');
      // Версию не проставляем: находка, уронившая проверку, должна
      // попасть в неё снова, а не считаться разобранной.
    }
  }

  return result;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await assessRadarBatch();
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'оценка находок: сбой прохода');
  } finally {
    running = false;
  }
}

export function startRadarRisk(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  logger.info('оценка риска находок запущена');
}

export function stopRadarRisk(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
