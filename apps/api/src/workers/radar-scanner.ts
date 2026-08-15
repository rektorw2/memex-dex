import { Prisma as P, type Chain } from '@prisma/client';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { supportedChains } from '../chains/index.js';
import { fetchTopPools, isMarketDataSupported } from '../services/market-data.js';
import { fetchOkxTokens, isOkxConfigured, isOkxSupported } from '../services/okx.js';
import { sendTelegram, escapeHtml, isTelegramConfigured } from '../services/telegram.js';

/**
 * Радар новых токенов.
 *
 * Новизна определяется на нашей стороне: адрес, которого нет в таблице
 * RadarEvent, считается новым. Так радар не зависит от того, какое поле
 * поставщик считает «датой листинга», и переживает смену источника.
 *
 * Первый проход после пустой базы сознательно не рассылает уведомления:
 * иначе при запуске пользователь получил бы несколько сотен сообщений
 * обо всех существующих токенах разом.
 */

const SCAN_INTERVAL_MS = 3 * 60 * 1000;
/** Пулы старше этого возраста радар не считает находкой. */
const MAX_AGE_HOURS = 72;

let running = false;

interface Candidate {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  poolAddress: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  poolAgeHours: number | null;
  source: string;
}

async function collectCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  for (const chain of supportedChains()) {
    // OKX — основной источник, когда настроен: у него шире покрытие
    // и собственная проверка листингов.
    if (isOkxConfigured() && isOkxSupported(chain)) {
      const tokens = await fetchOkxTokens(chain);
      for (const t of tokens) {
        out.push({
          chain,
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          poolAddress: null,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          volume24hUsd: t.volume24hUsd,
          fdvUsd: t.fdvUsd,
          poolAgeHours: null,
          source: 'okx',
        });
      }
    }

    // GeckoTerminal даёт возраст пула и ликвидность — без них отсеять
    // мусор невозможно, поэтому источник используется всегда.
    if (isMarketDataSupported(chain)) {
      const pools = await fetchTopPools(chain, 2);
      for (const p of pools) {
        out.push({
          chain,
          address: p.address,
          symbol: p.symbol,
          name: p.name,
          poolAddress: p.poolAddress,
          priceUsd: p.priceUsd,
          liquidityUsd: p.liquidityUsd,
          volume24hUsd: p.volume24hUsd,
          fdvUsd: p.fdvUsd,
          poolAgeHours: p.poolCreatedAt
            ? (Date.now() - p.poolCreatedAt.getTime()) / 3_600_000
            : null,
          source: 'geckoterminal',
        });
      }
    }
  }

  // Один токен может прийти из обоих источников — оставляем запись
  // с большим объёмом данных.
  const merged = new Map<string, Candidate>();
  for (const c of out) {
    const key = `${c.chain}:${c.address.toLowerCase()}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, c);
      continue;
    }
    merged.set(key, {
      ...prev,
      poolAddress: prev.poolAddress ?? c.poolAddress,
      priceUsd: prev.priceUsd ?? c.priceUsd,
      liquidityUsd: prev.liquidityUsd ?? c.liquidityUsd,
      volume24hUsd: prev.volume24hUsd ?? c.volume24hUsd,
      fdvUsd: prev.fdvUsd ?? c.fdvUsd,
      poolAgeHours: prev.poolAgeHours ?? c.poolAgeHours,
      source: prev.source === c.source ? prev.source : `${prev.source}+${c.source}`,
    });
  }

  return [...merged.values()];
}

export async function scanRadar(): Promise<{ found: number; notified: number }> {
  const candidates = await collectCandidates();
  if (candidates.length === 0) return { found: 0, notified: 0 };

  const known = await prisma.radarEvent.count();
  // Пустая база означает первый запуск: наполняем историю молча.
  const silent = known === 0;

  let found = 0;
  const fresh: Array<{ id: string }> = [];

  for (const c of candidates) {
    if ((c.liquidityUsd ?? 0) < env.RADAR_MIN_LIQUIDITY_USD) continue;
    if (c.poolAgeHours != null && c.poolAgeHours > MAX_AGE_HOURS) continue;

    const exists = await prisma.radarEvent.findUnique({
      where: { chain_address: { chain: c.chain, address: c.address } },
      select: { id: true },
    });
    if (exists) continue;

    const risk = assessToken({
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
      ageHours: c.poolAgeHours,
    });

    try {
      const event = await prisma.radarEvent.create({
        data: {
          chain: c.chain,
          address: c.address,
          symbol: c.symbol,
          name: c.name,
          poolAddress: c.poolAddress,
          priceUsd: c.priceUsd != null ? new P.Decimal(c.priceUsd) : null,
          liquidityUsd: c.liquidityUsd != null ? new P.Decimal(c.liquidityUsd) : null,
          volume24hUsd: c.volume24hUsd != null ? new P.Decimal(c.volume24hUsd) : null,
          fdvUsd: c.fdvUsd != null ? new P.Decimal(c.fdvUsd) : null,
          poolAgeHours: c.poolAgeHours != null ? new P.Decimal(c.poolAgeHours) : null,
          source: c.source,
          riskScore: risk.score,
          riskFlags: risk.flags as unknown as P.InputJsonValue,
          notified: silent,

          // Точка отсчёта для кратности. Записывается один раз и больше
          // не меняется — иначе результат находки можно было бы
          // «улучшить» задним числом, сдвинув базу.
          mcapAtSignalUsd: c.fdvUsd != null ? new P.Decimal(c.fdvUsd) : null,
          currentMcapUsd: c.fdvUsd != null ? new P.Decimal(c.fdvUsd) : null,
          peakMcapUsd: c.fdvUsd != null ? new P.Decimal(c.fdvUsd) : null,
          currentPriceUsd: c.priceUsd != null ? new P.Decimal(c.priceUsd) : null,
          currentMultiple: c.fdvUsd != null ? new P.Decimal(1) : null,
          peakMultiple: c.fdvUsd != null ? new P.Decimal(1) : null,
          pricePoints: [{ t: Date.now(), p: c.priceUsd, m: c.fdvUsd }] as unknown as P.InputJsonValue,
          lastCheckedAt: new Date(),
        },
        select: { id: true },
      });
      found++;
      if (!silent) fresh.push(event);
    } catch {
      // Гонка с параллельным проходом — запись уже создана, это не ошибка.
    }
  }

  const notified = fresh.length > 0 ? await notifySubscribers() : 0;

  if (found > 0) {
    logger.info(
      { found, notified, silent, source: isOkxConfigured() ? 'okx+gecko' : 'gecko' },
      'радар: обнаружены новые токены',
    );
  }

  return { found, notified };
}

/** Рассылка по подписчикам с учётом их фильтров и лимита частоты. */
async function notifySubscribers(): Promise<number> {
  const events = await prisma.radarEvent.findMany({
    where: { notified: false },
    orderBy: { firstSeenAt: 'asc' },
    take: 50,
  });
  if (events.length === 0) return 0;

  const subs = await prisma.radarSubscription.findMany({
    where: { isActive: true, channel: 'TELEGRAM' },
    include: { user: { select: { telegramChatId: true, isFrozen: true } } },
  });

  let sent = 0;

  for (const sub of subs) {
    const chatId = sub.user.telegramChatId;
    if (!chatId || sub.user.isFrozen || !isTelegramConfigured()) continue;

    // Окно частоты: обнуляем счётчик, если прошёл час.
    const windowAge = Date.now() - sub.windowStartedAt.getTime();
    let sentInWindow = windowAge > 3_600_000 ? 0 : sub.sentLastHour;
    const windowStart = windowAge > 3_600_000 ? new Date() : sub.windowStartedAt;

    for (const e of events) {
      if (sentInWindow >= sub.maxAlertsPerHour) break;

      if (sub.chains.length > 0 && !sub.chains.includes(e.chain)) continue;
      if (sub.minLiquidityUsd && (e.liquidityUsd ?? new P.Decimal(0)).lt(sub.minLiquidityUsd)) continue;
      if (sub.minVolume24hUsd && (e.volume24hUsd ?? new P.Decimal(0)).lt(sub.minVolume24hUsd)) continue;
      if (sub.maxRiskScore != null && (e.riskScore ?? 100) > sub.maxRiskScore) continue;
      if (sub.maxPoolAgeHours != null && e.poolAgeHours && e.poolAgeHours.gt(sub.maxPoolAgeHours)) continue;

      const ok = await sendTelegram(chatId, formatAlert(e));
      if (ok) {
        sent++;
        sentInWindow++;
      }
    }

    await prisma.radarSubscription.update({
      where: { id: sub.id },
      data: { sentLastHour: sentInWindow, windowStartedAt: windowStart },
    });
  }

  await prisma.radarEvent.updateMany({
    where: { id: { in: events.map((e: { id: string }) => e.id) } },
    data: { notified: true },
  });

  return sent;
}

function formatAlert(e: {
  symbol: string; name: string; chain: string; address: string;
  liquidityUsd: P.Decimal | null; volume24hUsd: P.Decimal | null;
  poolAgeHours: P.Decimal | null; riskScore: number | null; riskFlags: unknown;
}): string {
  const usd = (v: P.Decimal | null) =>
    v ? `$${Number(v).toLocaleString('ru', { maximumFractionDigits: 0 })}` : '—';

  const flags = Array.isArray(e.riskFlags) ? (e.riskFlags as string[]).slice(0, 3) : [];

  return [
    `🆕 <b>${escapeHtml(e.symbol)}</b> — ${escapeHtml(e.name)}`,
    `Сеть: ${e.chain}`,
    `Ликвидность: ${usd(e.liquidityUsd)} · Объём 24ч: ${usd(e.volume24hUsd)}`,
    e.poolAgeHours ? `Возраст пула: ${Number(e.poolAgeHours).toFixed(1)} ч` : null,
    e.riskScore != null ? `Риск: ${e.riskScore}/100` : null,
    flags.length ? `\n${flags.map((f) => `• ${escapeHtml(f)}`).join('\n')}` : null,
    `\n<code>${escapeHtml(e.address)}</code>`,
    `\n<i>Это не рекомендация. Новый токен может обесцениться до нуля.</i>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function startRadarScanner() {
  if (running) return;
  running = true;

  const loop = async () => {
    while (running) {
      await scanRadar().catch((e) => logger.error({ err: e?.message }, 'сбой радара'));
      await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
    }
  };
  void loop();
  logger.info(
    { okx: isOkxConfigured(), telegram: isTelegramConfigured() },
    'радар новых токенов запущен',
  );
}

export function stopRadarScanner() {
  running = false;
}
