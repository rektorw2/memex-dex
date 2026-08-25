/**
 * Поиск смарт-кошельков через лидерборды OKX.
 *
 * Раз в пять минут обходит четыре сети десятью сочетаниями периода
 * и способа сортировки. Сочетаний много не для полноты, а потому что
 * разные способы находят разных людей: по прибыли — крупных, по
 * доходности — мелких и удачливых, по доле удачных — осторожных.
 * Один способ дал бы однобокую выборку, где кошелёк с сотней долларов
 * и двадцатью попаданиями подряд не показался бы никогда.
 *
 * Два правила, которые здесь соблюдаются жёстко.
 *
 * Отказ провайдера не стирает найденное. Сеть моргнула — список
 * остаётся прежним и помечается устаревшим. Иначе временный сбой
 * OKX опустошал бы раздел, и выглядело бы это как «смарт-кошельков
 * не осталось».
 *
 * Найденное здесь — кандидаты, а не оценённые кошельки. Метрики OKX
 * сохраняются как мнение OKX и не подменяют собственный расчёт:
 * Smart Score появится только после того, как наш ledger наберёт
 * пять закрытых позиций.
 */

import { Prisma as P } from '@prisma/client';
import {
  discoverCandidates,
  isOkxWalletConfigured,
} from '../services/okx-wallets.js';
import {
  OKX_WALLET_TYPE,
  WALLET_TYPE_LABELS,
  type ChainKey,
  type WalletCandidate,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { supportedChains } from '../chains/index.js';

export const JOB_NAME = 'wallet-discovery';

const TICK_MS = 5 * 60_000;
/** Проход не может идти дольше: иначе он наедет на следующий. */
const TIMEOUT_MS = 4 * 60_000;

let timer: NodeJS.Timeout | null = null;

export interface DiscoveryResult {
  candidates: number;
  created: number;
  updated: number;
  chains: number;
  durationMs: number;
}

/**
 * Захват задачи.
 *
 * Через строку в базе, а не через переменную в памяти: экземпляров
 * API может быть несколько, и локальный флаг не помешал бы им
 * запустить обход одновременно и выбрать лимит OKX вдвое быстрее.
 *
 * Просроченный захват перехватывается: процесс, упавший в середине
 * прохода, иначе заблокировал бы задачу навсегда.
 */
async function acquireLock(): Promise<boolean> {
  const staleBefore = new Date(Date.now() - TIMEOUT_MS);

  const state = await prisma.jobState.upsert({
    where: { name: JOB_NAME },
    create: { name: JOB_NAME, isRunning: true, lastStartedAt: new Date() },
    update: {},
  });

  if (state.isRunning && state.lastStartedAt && state.lastStartedAt > staleBefore) {
    return false;
  }

  await prisma.jobState.update({
    where: { name: JOB_NAME },
    data: { isRunning: true, lastStartedAt: new Date(), errorCode: null },
  });

  return true;
}

async function releaseLock(patch: {
  durationMs: number;
  itemCount?: number;
  errorCode?: string | null;
}): Promise<void> {
  await prisma.jobState
    .update({
      where: { name: JOB_NAME },
      data: {
        isRunning: false,
        lastCompletedAt: new Date(),
        // Успешным считается только проход без ошибки: иначе
        // «последний успех» показывал бы время последней попытки,
        // и замерший поиск выглядел бы работающим.
        ...(patch.errorCode ? {} : { lastSuccessAt: new Date() }),
        durationMs: patch.durationMs,
        itemCount: patch.itemCount ?? null,
        errorCode: patch.errorCode ?? null,
      },
    })
    .catch(() => undefined);
}

export async function runDiscovery(): Promise<DiscoveryResult | null> {
  if (!isOkxWalletConfigured()) {
    logger.debug('поиск кошельков: OKX не настроен, пропускаем');
    return null;
  }

  if (!(await acquireLock())) {
    logger.debug('поиск кошельков: уже идёт в другом экземпляре');
    return null;
  }

  const started = Date.now();
  const result: DiscoveryResult = {
    candidates: 0,
    created: 0,
    updated: 0,
    chains: 0,
    durationMs: 0,
  };

  try {
    const chains = supportedChains().filter((c) =>
      (['ETHEREUM', 'BNB', 'BASE', 'SOLANA'] as string[]).includes(c),
    ) as ChainKey[];

    for (const chain of chains) {
      if (Date.now() - started > TIMEOUT_MS) {
        logger.warn({ chain }, 'поиск кошельков: превышено время прохода');
        break;
      }

      const candidates = await discoverCandidates(chain).catch((e) => {
        logger.warn({ chain, err: e?.message }, 'поиск кошельков: сеть не отдала список');
        return [] as WalletCandidate[];
      });

      // Пустой ответ по сети — не повод стирать найденное раньше.
      if (candidates.length === 0) continue;

      result.chains++;
      result.candidates += candidates.length;

      for (const c of candidates) {
        if (!passesMinimums(c)) continue;

        const saved = await saveCandidate(c);
        if (saved === 'created') result.created++;
        else if (saved === 'updated') result.updated++;

        // Лидерборд даёт только кандидата и агрегаты. Сразу ставим
        // новый адрес в очередь истории OKX: без этого у найденного
        // кошелька не появлялись ни позиции, ни локальный PnL.
        if (saved === 'created' && env.WALLET_LEDGER_SYNC_ENABLED) {
          const { markDirty } = await import('./wallet-ledger-sync.js');
          await markDirty(c.chain, c.address);
        }
      }
    }

    result.durationMs = Date.now() - started;

    await releaseLock({ durationMs: result.durationMs, itemCount: result.candidates });

    // В журнал идут только числа: адреса кошельков туда не попадают.
    logger.info(
      {
        chains: result.chains,
        candidates: result.candidates,
        created: result.created,
        durationMs: result.durationMs,
      },
      'поиск кошельков завершён',
    );

    return result;
  } catch (e: any) {
    await releaseLock({
      durationMs: Date.now() - started,
      errorCode: e?.name ?? 'unknown',
    });
    logger.warn({ err: e?.message }, 'поиск кошельков: сбой прохода');
    return null;
  }
}

/**
 * Пороги отбора кандидата.
 *
 * Это фильтр поиска, а не доказательство качества: он отсекает шум,
 * чтобы не заводить в базу кошельки с тремя сделками на двадцать
 * долларов. Настоящая оценка считается позже собственным ядром.
 */
function passesMinimums(c: WalletCandidate): boolean {
  const p = c.provider;

  if (
    env.SMART_WALLET_MIN_REALIZED_PNL_USD > 0 &&
    (p.realizedPnlUsd ?? 0) < env.SMART_WALLET_MIN_REALIZED_PNL_USD
  ) {
    return false;
  }

  if (
    env.SMART_WALLET_MIN_WIN_RATE_PERCENT > 0 &&
    (p.winRatePercent ?? 0) < env.SMART_WALLET_MIN_WIN_RATE_PERCENT
  ) {
    return false;
  }

  if (env.SMART_WALLET_MIN_TXS > 0 && (p.txs ?? 0) < env.SMART_WALLET_MIN_TXS) return false;

  if (
    env.SMART_WALLET_MIN_VOLUME_USD > 0 &&
    (p.txVolumeUsd ?? 0) < env.SMART_WALLET_MIN_VOLUME_USD
  ) {
    return false;
  }

  return true;
}

/**
 * Сохранение кандидата.
 *
 * Одна запись на пару сеть-адрес. Кошелёк, найденный в нескольких
 * выборках, не создаёт нескольких карточек: сведения накапливаются
 * в одной, и число попаданий само по себе говорит о нём больше,
 * чем место в любой отдельной выборке.
 */
async function saveCandidate(c: WalletCandidate): Promise<'created' | 'updated' | 'skipped'> {
  const isSniper = c.walletType === OKX_WALLET_TYPE.sniper;

  try {
    const existing = await prisma.traderWallet.findUnique({
      where: { chain_address: { chain: c.chain as never, address: c.address } },
    });

    const data = {
      // Метка OKX — их мнение, и хранится как их мнение. Собственная
      // оценка считается ядром и живёт в поле score.
      knownAs: c.walletType != null ? (WALLET_TYPE_LABELS[c.walletType] ?? null) : null,
      volumeUsd: c.provider.txVolumeUsd != null ? new P.Decimal(c.provider.txVolumeUsd) : undefined,
      lastActiveAt: c.lastActiveAt != null ? new Date(c.lastActiveAt) : undefined,
      // Снайпер попадает в отдельную категорию: его результат
      // настоящий, но повторить его нельзя — он входит в первом блоке.
      label: isSniper ? 'sniper' : 'none',
    };

    if (existing) {
      await prisma.traderWallet.update({ where: { id: existing.id }, data });
      return 'updated';
    }

    await prisma.traderWallet.create({
      data: { ...data, chain: c.chain as never, address: c.address },
    });
    return 'created';
  } catch (e: any) {
    logger.debug({ err: e?.message }, 'кандидат не сохранён');
    return 'skipped';
  }
}

// ─────────────────────────────── Планировщик ────────────────────────────────

export function startWalletDiscovery(): void {
  if (timer) return;
  timer = setInterval(() => void runDiscovery(), TICK_MS);
  void runDiscovery();
  logger.info('поиск смарт-кошельков запущен');
}

export function stopWalletDiscovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Состояние задачи для админки. */
export async function discoveryStatus() {
  const state = await prisma.jobState.findUnique({ where: { name: JOB_NAME } });

  return {
    configured: isOkxWalletConfigured(),
    isRunning: state?.isRunning ?? false,
    lastStartedAt: state?.lastStartedAt ?? null,
    lastCompletedAt: state?.lastCompletedAt ?? null,
    lastSuccessfulAt: state?.lastSuccessAt ?? null,
    durationMs: state?.durationMs ?? null,
    candidateCount: state?.itemCount ?? null,
    errorCode: state?.errorCode ?? null,
    // Данные считаются устаревшими, если удачного прохода не было
    // втрое дольше интервала: пропуск одного прохода — норма,
    // трёх подряд — уже нет.
    isStale:
      state?.lastSuccessAt == null ||
      Date.now() - state.lastSuccessAt.getTime() > TICK_MS * 3,
  };
}
