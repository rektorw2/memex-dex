import { Prisma as P, type Chain } from '@prisma/client';
import { assessToken, parseTokenRefs, candidateChains } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { supportedChains } from '../chains/index.js';
import {
  fetchPools,
  fetchPoolForToken,
  isMarketDataSupported,
  type PoolFeed,
} from '../services/market-data.js';
import { fetchOkxTokens, isOkxConfigured, isOkxSupported } from '../services/okx.js';
import { sendTelegram, escapeHtml, isTelegramConfigured } from '../services/telegram.js';
import { decimalFor, DECIMAL_COLUMN } from '../lib/decimal.js';

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

/**
 * Ленты пулов и глубина по каждой.
 *
 * Порядок задаёт приоритет при слиянии дубликатов: одна и та же пара
 * приходит из нескольких лент, и в записи остаётся источник, где она
 * встретилась первой. Новые пулы идут первыми — для радара именно
 * новизна и есть смысл находки.
 *
 * Глубина ограничена суммарным лимитом GeckoTerminal в 25 запросов
 * в минуту на всё приложение: здесь их 4 на сеть, при четырёх сетях
 * это 16 за проход раз в три минуты.
 */
const FEEDS: Array<{ name: PoolFeed; pages: number }> = [
  { name: 'new', pages: 2 },
  { name: 'trending', pages: 1 },
  { name: 'top', pages: 1 },
];
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
    //
    // Читаются три разные ленты, и это принципиально. Раньше бралась
    // только сортировка по суточному обороту — то есть список уже
    // состоявшихся токенов. Свежий пул с небольшой ликвидностью в него
    // не попадает никогда, сколько страниц ни листай, и радар из-за
    // этого находил вчерашние новости.
    if (isMarketDataSupported(chain)) {
      for (const feed of FEEDS) {
        const pools = await fetchPools(chain, feed.name, feed.pages);
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
            source: `gecko:${feed.name}`,
          });
        }
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
          poolAgeHours: decimalFor(c.poolAgeHours, DECIMAL_COLUMN.percent),
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

// ──────────────────────── Ручное добавление находок ─────────────────────────

export interface WatchResult {
  added: number;
  existed: number;
  notFound: Array<{ address: string; reason: string }>;
}

/**
 * Приём вставленного текста: адреса, ссылки, целый абзац.
 *
 * Сеть для адреса EVM определяется перебором: один и тот же адрес живёт
 * в нескольких сетях, и единственный надёжный способ выбрать нужную —
 * посмотреть, где вообще есть пул.
 *
 * Токен, добавленный вручную, проходит те же проверки, что найденный
 * автоматически, кроме порога ликвидности и возраста: их человек уже
 * оценил, раз счёл нужным добавить. Риск при этом считается как обычно —
 * ручное добавление не означает одобрения.
 */
export async function addWatched(text: string): Promise<WatchResult> {
  const refs = parseTokenRefs(text, 25);
  const supported = supportedChains() as unknown as string[];

  const result: WatchResult = { added: 0, existed: 0, notFound: [] };

  if (refs.length === 0) {
    return result;
  }

  for (const ref of refs) {
    const chains = candidateChains(ref, supported);
    if (chains.length === 0) {
      result.notFound.push({ address: ref.address, reason: 'сеть не поддерживается' });
      continue;
    }

    // Проверка на существование — одним запросом по всем сетям-кандидатам,
    // до обращения к внешнему источнику: незачем тратить лимит запросов
    // на токен, который уже под наблюдением.
    const existing = await prisma.radarEvent.findFirst({
      where: { address: ref.address, chain: { in: chains as Chain[] } },
      select: { id: true },
    });
    if (existing) {
      result.existed++;
      continue;
    }

    let found: { chain: Chain; pool: NonNullable<Awaited<ReturnType<typeof fetchPoolForToken>>> } | null =
      null;

    for (const chain of chains) {
      const pool = await fetchPoolForToken(chain as Chain, ref.address);
      if (pool) {
        found = { chain: chain as Chain, pool };
        break;
      }
    }

    if (!found) {
      // «Не нашли» и «уже есть» — разные исходы: в первом случае человеку
      // надо проверить адрес, во втором делать ничего не нужно.
      result.notFound.push({
        address: ref.address,
        reason:
          chains.length > 1
            ? `пул не найден ни в одной из сетей: ${chains.join(', ')}`
            : `пул не найден в сети ${chains[0]}`,
      });
      continue;
    }

    const p = found.pool;
    const ageHours = p.poolCreatedAt
      ? (Date.now() - p.poolCreatedAt.getTime()) / 3_600_000
      : null;

    const risk = assessToken({
      liquidityUsd: p.liquidityUsd,
      volume24hUsd: p.volume24hUsd,
      ageHours,
    });

    try {
      await prisma.radarEvent.create({
        data: {
          chain: found.chain,
          address: ref.address,
          symbol: p.symbol,
          name: p.name,
          poolAddress: p.poolAddress,
          priceUsd: p.priceUsd != null ? new P.Decimal(p.priceUsd) : null,
          liquidityUsd: p.liquidityUsd != null ? new P.Decimal(p.liquidityUsd) : null,
          volume24hUsd: p.volume24hUsd != null ? new P.Decimal(p.volume24hUsd) : null,
          fdvUsd: p.fdvUsd != null ? new P.Decimal(p.fdvUsd) : null,
          poolAgeHours: decimalFor(ageHours, DECIMAL_COLUMN.percent),
          source: 'manual',
          riskScore: risk.score,
          riskFlags: risk.flags as unknown as P.InputJsonValue,
          // Уведомления по ручным находкам не рассылаются: человек,
          // который её добавил, уже про неё знает, а остальным
          // рассылка пойдёт при первом же изменении.
          notified: true,

          mcapAtSignalUsd: p.fdvUsd != null ? new P.Decimal(p.fdvUsd) : null,
          currentMcapUsd: p.fdvUsd != null ? new P.Decimal(p.fdvUsd) : null,
          peakMcapUsd: p.fdvUsd != null ? new P.Decimal(p.fdvUsd) : null,
          currentPriceUsd: p.priceUsd != null ? new P.Decimal(p.priceUsd) : null,
          currentMultiple: p.fdvUsd != null ? new P.Decimal(1) : null,
          peakMultiple: p.fdvUsd != null ? new P.Decimal(1) : null,
          pricePoints: [{ t: Date.now(), p: p.priceUsd, m: p.fdvUsd }] as unknown as P.InputJsonValue,
          lastCheckedAt: new Date(),
        },
      });
      result.added++;
    } catch {
      result.existed++;
    }
  }

  logger.info(result, 'радар: ручное добавление');
  return result;
}
