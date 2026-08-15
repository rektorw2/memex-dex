import { Prisma as P, type Chain } from '@prisma/client';
import {
  evaluateAutoRule,
  buildTargets,
  buildStopLoss,
  buildThesis,
  type AutoRuleConfig,
  type AutoRuleCandidate,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendTelegram, escapeHtml, isTelegramConfigured } from '../services/telegram.js';

/**
 * Автоматическая публикация коллов по находкам радара.
 *
 * Триггером служит активность размеченных кошельков — это ближайшее
 * честное соответствие тому, что делает лента OKX Signal. Скопировать
 * её напрямую нельзя: официального доступа к ней нет, а разбор
 * веб-приложения ломается молча — лента просто перестаёт обновляться,
 * без единой ошибки в логах.
 *
 * Три свойства, без которых автоматику нельзя выпускать к пользователям:
 *
 * 1. Выключена по умолчанию и стартует в режиме наблюдения.
 * 2. Каждое решение попадает в журнал, включая отказы с причиной.
 *    Журнал одних срабатываний не отвечает на главный вопрос к любой
 *    автоматике — «почему она молчит».
 * 3. Ограничена по частоте. Без этого в активный час публикуется
 *    два десятка коллов, и лента перестаёт что-либо значить.
 */

const TICK_MS = 60_000;
/** Находок за проход. Больше не нужно: правило и так ограничено паузой. */
const BATCH = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Единственное правило системы. Создаётся выключенным при первом обращении. */
export async function getRule() {
  const existing = await prisma.autoRule.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;

  return prisma.autoRule.create({
    data: {
      // Значения по умолчанию заданы в схеме; здесь важно только то,
      // что запись создаётся выключенной и в режиме наблюдения.
      isEnabled: false,
      isDryRun: true,
    },
  });
}

function toConfig(r: Awaited<ReturnType<typeof getRule>>): AutoRuleConfig {
  return {
    isEnabled: r.isEnabled,
    isDryRun: r.isDryRun,
    chains: r.chains as unknown as string[],
    minSmartBuyers: r.minSmartBuyers,
    minSignalStrength: r.minSignalStrength,
    minSmartVolumeUsd: Number(r.minSmartVolumeUsd),
    minLiquidityUsd: Number(r.minLiquidityUsd),
    minVolume24hUsd: Number(r.minVolume24hUsd),
    maxRiskScore: r.maxRiskScore,
    maxPoolAgeHours: r.maxPoolAgeHours,
    maxCallsPerDay: r.maxCallsPerDay,
    cooldownMinutes: r.cooldownMinutes,
  };
}

export interface RunResult {
  checked: number;
  fired: number;
  dryRun: number;
  skipped: number;
  enabled: boolean;
}

export async function runAutoRule(): Promise<RunResult> {
  const rule = await getRule();
  const cfg = toConfig(rule);

  if (!rule.isEnabled) {
    return { checked: 0, fired: 0, dryRun: 0, skipped: 0, enabled: false };
  }

  // Кандидаты: находки с активностью кошельков, по которым правило
  // ещё не принимало решения. Сортировка по силе сигнала, а не по
  // времени: при исчерпанном лимите публиковаться должно лучшее,
  // а не первое попавшееся.
  const events = await prisma.radarEvent.findMany({
    where: {
      isTracking: true,
      smartBuyers: { gt: 0 },
      fires: { none: { ruleId: rule.id } },
    },
    orderBy: [{ walletSignalScore: 'desc' }, { firstSeenAt: 'desc' }],
    take: BATCH,
  });

  if (events.length === 0) {
    return { checked: 0, fired: 0, dryRun: 0, skipped: 0, enabled: true };
  }

  let fired = 0;
  let dryRun = 0;
  let skipped = 0;

  for (const ev of events) {
    // Состояние ограничителей перечитывается на каждой находке:
    // публикация внутри цикла меняет и счётчик, и время паузы.
    const since = new Date(Date.now() - 864e5);
    const [callsLast24h, lastFire] = await Promise.all([
      prisma.autoRuleFire.count({
        where: { ruleId: rule.id, outcome: 'FIRED', createdAt: { gte: since } },
      }),
      prisma.autoRuleFire.findFirst({
        where: { ruleId: rule.id, outcome: 'FIRED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const existingCall = await prisma.call.findFirst({
      where: {
        chain: ev.chain,
        token: { address: ev.address },
        status: { in: ['DRAFT', 'PUBLISHED'] },
      },
      select: { id: true },
    });

    const candidate: AutoRuleCandidate = {
      chain: ev.chain,
      symbol: ev.symbol,
      smartBuyers: ev.smartBuyers,
      whaleBuyers: ev.whaleBuyers,
      smartVolumeUsd: Number(ev.smartBuyVolumeUsd),
      signalStrength: ev.walletSignalScore,
      liquidityUsd: ev.liquidityUsd != null ? Number(ev.liquidityUsd) : null,
      volume24hUsd: ev.volume24hUsd != null ? Number(ev.volume24hUsd) : null,
      riskScore: ev.riskScore,
      poolAgeHours: ev.poolAgeHours != null ? Number(ev.poolAgeHours) : null,
      priceUsd:
        ev.currentPriceUsd != null
          ? Number(ev.currentPriceUsd)
          : ev.priceUsd != null
            ? Number(ev.priceUsd)
            : null,
      hasExistingCall: Boolean(existingCall),
      alreadyProcessed: false,
    };

    const decision = evaluateAutoRule(cfg, candidate, {
      callsLast24h,
      minutesSinceLastFire: lastFire
        ? (Date.now() - lastFire.createdAt.getTime()) / 60_000
        : null,
    });

    let callId: string | null = null;

    if (decision.outcome === 'FIRED') {
      callId = await publishCall(rule, ev, candidate, decision);
      // Если публикация не удалась, решение переводится в отказ:
      // запись FIRED без колла означала бы, что лимит израсходован
      // впустую, и следующая находка была бы заблокирована зря.
      if (!callId) {
        decision.outcome = 'SKIPPED';
        decision.reason = 'Условия выполнены, но создать колл не удалось';
      }
    }

    try {
      await prisma.autoRuleFire.create({
        data: {
          ruleId: rule.id,
          radarEventId: ev.id,
          chain: ev.chain,
          address: ev.address,
          symbol: ev.symbol,
          outcome: decision.outcome,
          reason: decision.reason,
          snapshot: {
            smartBuyers: candidate.smartBuyers,
            whaleBuyers: candidate.whaleBuyers,
            smartVolumeUsd: candidate.smartVolumeUsd,
            signalStrength: candidate.signalStrength,
            liquidityUsd: candidate.liquidityUsd,
            volume24hUsd: candidate.volume24hUsd,
            riskScore: candidate.riskScore,
            priceUsd: candidate.priceUsd,
            passed: decision.passed,
            failed: decision.failed,
          } as unknown as P.InputJsonValue,
          callId,
        },
      });
    } catch {
      // Гонка с параллельным проходом: решение уже записано.
      continue;
    }

    if (decision.outcome === 'FIRED') {
      fired++;
      await prisma.autoRule.update({
        where: { id: rule.id },
        data: { lastFiredAt: new Date() },
      });
      await notifyAdmins(ev.symbol, ev.chain, decision.reason, callId);
    } else if (decision.outcome === 'DRY_RUN') {
      dryRun++;
    } else {
      skipped++;
    }
  }

  if (fired > 0 || dryRun > 0) {
    logger.info(
      { checked: events.length, fired, dryRun, skipped, dry: rule.isDryRun },
      'автоправило: проход завершён',
    );
  }

  return { checked: events.length, fired, dryRun, skipped, enabled: true };
}

/**
 * Создание и публикация колла.
 *
 * Возвращает null при любой неудаче, а не бросает исключение: сбой
 * на одной находке не должен останавливать разбор остальных.
 */
async function publishCall(
  rule: Awaited<ReturnType<typeof getRule>>,
  ev: {
    id: string;
    chain: Chain;
    address: string;
    symbol: string;
    name: string;
    poolAddress: string | null;
  },
  c: AutoRuleCandidate,
  decision: ReturnType<typeof evaluateAutoRule>,
): Promise<string | null> {
  try {
    const author = rule.authorId
      ? await prisma.user.findUnique({ where: { id: rule.authorId }, select: { id: true } })
      : await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });

    if (!author) {
      logger.warn('автоправило: не найден администратор для авторства колла');
      return null;
    }

    // Токен может отсутствовать в витрине: радар находит раньше импортёра.
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: ev.chain, address: ev.address } },
      create: {
        chain: ev.chain,
        address: ev.address,
        symbol: ev.symbol,
        name: ev.name,
        // Разрядность неизвестна из данных радара. Значение по умолчанию
        // корректно для большинства токенов и уточняется импортёром;
        // на расчёт колла оно не влияет, поскольку цены в долларах.
        decimals: 18,
        poolAddress: ev.poolAddress,
        source: 'auto',
        priceUsd: c.priceUsd != null ? new P.Decimal(c.priceUsd) : null,
        liquidityUsd: c.liquidityUsd != null ? new P.Decimal(c.liquidityUsd) : null,
        volume24hUsd: c.volume24hUsd != null ? new P.Decimal(c.volume24hUsd) : null,
        riskScore: c.riskScore,
      },
      update: {},
      select: { id: true },
    });

    const pcts = Array.isArray(rule.targetPcts)
      ? (rule.targetPcts as unknown[]).filter((x): x is number => typeof x === 'number')
      : [50, 100, 200];

    const targets = buildTargets(c.priceUsd!, pcts);
    if (targets.length === 0) return null;

    const stop = buildStopLoss(c.priceUsd!, rule.stopLossPct);

    const call = await prisma.call.create({
      data: {
        authorId: author.id,
        tokenId: token.id,
        chain: ev.chain,
        title: `${ev.symbol}: сигнал по кошелькам`,
        thesis: buildThesis(c, decision),
        // Риск всегда высокий: правило работает по свежим мем-коинам,
        // и занижать его на основании активности кошельков нельзя.
        risk: 'HIGH',
        status: 'PUBLISHED',
        entryPriceUsd: new P.Decimal(c.priceUsd!),
        targets: targets.map((t) => ({
          priceUsd: t.priceUsd.toString(),
          pct: t.pct,
        })) as unknown as P.InputJsonValue,
        stopLossUsd: stop != null ? new P.Decimal(stop) : null,
        suggestedPct: rule.suggestedPct,
        timeHorizon: rule.timeHorizon,
        isCopyEnabled: rule.isCopyEnabled,
        publishedAt: new Date(),
      },
      select: { id: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: author.id,
        action: 'call.auto_publish',
        entity: 'Call',
        entityId: call.id,
        after: {
          ruleId: rule.id,
          radarEventId: ev.id,
          reason: decision.reason,
        } as never,
      },
    });

    return call.id;
  } catch (e: any) {
    logger.warn({ err: e?.message, symbol: ev.symbol }, 'автоправило: колл не создан');
    return null;
  }
}

/** Уведомление администраторов о сработавшей автоматике. */
async function notifyAdmins(
  symbol: string,
  chain: string,
  reason: string,
  callId: string | null,
): Promise<void> {
  if (!isTelegramConfigured()) return;

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });

  const text =
    `🤖 <b>Автоколл опубликован</b>\n` +
    `${escapeHtml(symbol)} · ${escapeHtml(chain)}\n\n` +
    `${escapeHtml(reason)}\n\n` +
    (callId ? `ID колла: <code>${escapeHtml(callId)}</code>` : '');

  for (const a of admins) {
    await sendTelegram(a.telegramChatId!, text).catch(() => undefined);
  }
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runAutoRule();
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'автоправило: ошибка прохода');
  } finally {
    running = false;
  }
}

export function startAutoPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  logger.info('автопубликация коллов запущена');
}

export function stopAutoPublisher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
