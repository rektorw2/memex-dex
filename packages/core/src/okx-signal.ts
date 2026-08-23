/**
 * Нормализация OKX Signal.
 *
 * REST и WebSocket описывают одно событие немного по-разному:
 * WebSocket кладёт часть полей в `arg`, REST отдаёт запись напрямую,
 * а названия процентов различаются суффиксом Percentage/Percent.
 * Наружу эти различия не выходят — всё приложение работает только
 * с `OkxSignal`.
 */

import { chainFromIndex, normalizePct, okxInt, okxNum, okxStr, okxTime } from './okx-model.js';
import { normalizeAddress, type ChainKey } from './token-registry.js';
import { walletCategoryFromSignalList, type OkxWalletCategory } from './okx-wallet-type.js';
import { stableHash } from './okx-ws-model.js';

export const OKX_SIGNAL_CHANNEL = 'dex-market-new-signal-openapi';

export interface OkxSignal {
  providerKey: string;
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  signaledAt: Date;
  priceUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  top10HolderPct: number | null;
  walletTypes: OkxWalletCategory[];
  triggerWalletCount: number | null;
  amountUsd: number | null;
  soldRatioPct: number | null;
}

/**
 * Живой результат сигнала, а не результат портфеля пользователя.
 *
 * `pnlUsd` — оценка того, как изменилась бы указанная OKX сумма
 * входа. Она не доказывает, что пользователь покупал токен, поэтому
 * наружу всегда должна выходить с подписью «PnL сигнала».
 */
export interface OkxSignalPerformance {
  multiple: number;
  priceChangePct: number;
  pnlUsd: number | null;
}

/** Максимальный наблюдавшийся результат именно после одного сигнала. */
export interface OkxSignalAth {
  peakPriceUsd: number;
  multiple: number;
  priceChangePct: number;
  /** Оценка капитализации при пике при неизменном предложении токена. */
  peakMarketCapUsd: number | null;
}

export function okxSignalAth(
  signalPriceUsd: number | null | undefined,
  peakPriceUsd: number | null | undefined,
  signalMarketCapUsd?: number | null,
): OkxSignalAth | null {
  if (
    signalPriceUsd == null ||
    peakPriceUsd == null ||
    !Number.isFinite(signalPriceUsd) ||
    !Number.isFinite(peakPriceUsd) ||
    signalPriceUsd <= 0 ||
    peakPriceUsd < 0
  ) {
    return null;
  }

  // ATH после сигнала не может быть ниже самой цены сигнала.
  // Защита важна для старых строк, которые ещё не успели пройти
  // исторический backfill свечами.
  const peak = Math.max(signalPriceUsd, peakPriceUsd);
  const multiple = peak / signalPriceUsd;
  const priceChangePct = (multiple - 1) * 100;
  const peakMarketCapUsd =
    signalMarketCapUsd != null &&
    Number.isFinite(signalMarketCapUsd) &&
    signalMarketCapUsd >= 0
      ? signalMarketCapUsd * multiple
      : null;

  return { peakPriceUsd: peak, multiple, priceChangePct, peakMarketCapUsd };
}

export function okxSignalPerformance(
  signalPriceUsd: number | null | undefined,
  currentPriceUsd: number | null | undefined,
  amountUsd?: number | null,
): OkxSignalPerformance | null {
  if (
    signalPriceUsd == null ||
    currentPriceUsd == null ||
    !Number.isFinite(signalPriceUsd) ||
    !Number.isFinite(currentPriceUsd) ||
    signalPriceUsd <= 0 ||
    currentPriceUsd < 0
  ) {
    return null;
  }

  const multiple = currentPriceUsd / signalPriceUsd;
  const priceChangePct = (multiple - 1) * 100;
  const pnlUsd =
    amountUsd != null && Number.isFinite(amountUsd) && amountUsd >= 0
      ? amountUsd * (multiple - 1)
      : null;

  return { multiple, priceChangePct, pnlUsd };
}

/** Типы приходят и кодами, и именами — поддерживаем официальный словарь обоих ответов. */
export function parseSignalWalletTypes(raw: unknown): OkxWalletCategory[] {
  if (raw == null) return [];

  const aliases: Record<string, OkxWalletCategory> = {
    SMART_MONEY: 'smart_money',
    SMARTMONEY: 'smart_money',
    KOL: 'kol',
    INFLUENCER: 'kol',
    WHALE: 'whale',
  };

  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const parsed = values
    .map((value) => {
      const text = String(value).trim();
      return aliases[text.toUpperCase()] ?? walletCategoryFromSignalList(text);
    })
    .filter((value) => value !== 'unknown');

  return [...new Set(parsed)];
}

/** Разбор одной строки REST либо одного push-события WebSocket. */
export function parseOkxSignal(raw: unknown): OkxSignal | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const token = r.token && typeof r.token === 'object'
    ? (r.token as Record<string, unknown>)
    : r;

  const chain = chainFromIndex(r.chainIndex as string);
  const rawAddress = okxStr(
    token.tokenAddress ?? token.tokenContractAddress ?? r.tokenAddress ?? r.tokenContractAddress,
    128,
  );
  const signaledAt = okxTime(r.timestamp ?? r.signalTime ?? r.tradeTime);

  if (!chain || !rawAddress || !signaledAt) return null;

  const address = normalizeAddress(chain, rawAddress);
  const symbol = okxStr(token.symbol ?? token.tokenSymbol, 32) ?? '???';
  const walletTypes = parseSignalWalletTypes(r.walletType);
  const triggerWalletCount = okxInt(r.triggerWalletCount);
  const amountUsd = okxNum(r.amountUsd);
  // Адреса не сохраняются, но входят в ключ события. Без них две
  // независимые покупки одного токена в одну миллисекунду с одинаковой
  // суммой могли бы ошибочно схлопнуться. Сортировка делает REST и WS
  // одинаковыми, даже если провайдер переставил адреса местами.
  const triggerAddressesKey = String(r.triggerWalletAddress ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .join(',');

  const providerKey = `okx-signal:${stableHash([
    chain,
    address,
    signaledAt.getTime(),
    walletTypes.join(','),
    triggerWalletCount ?? '',
    triggerAddressesKey,
    amountUsd ?? '',
  ].join('|'))}`;

  return {
    providerKey,
    chain,
    address,
    symbol,
    name: okxStr(token.name ?? token.tokenName, 120) ?? symbol,
    logoUrl: okxStr(token.logo ?? token.tokenLogoUrl, 500),
    signaledAt,
    priceUsd: okxNum(r.price ?? r.tokenPrice),
    marketCapUsd: okxNum(token.marketCapUsd ?? token.marketCap ?? r.marketCapUsd ?? r.marketCap),
    holders: okxInt(token.holders),
    top10HolderPct: normalizePct(
      okxNum(token.top10HolderPercent ?? token.top10HolderPercentage),
    ),
    walletTypes,
    triggerWalletCount,
    amountUsd,
    soldRatioPct: normalizePct(okxNum(r.soldRatioPercent ?? r.soldRatioPercentage)),
  };
}

/**
 * Достать сигналы из WebSocket-конверта.
 *
 * В официальном примере событие лежит прямо в `arg`, а в описании
 * контракта — в `signal`/`data`. Поддерживаются обе формы. Ответ
 * подписки без токена возвращает пустой список.
 */
export function parseOkxSignalMessage(raw: unknown): OkxSignal[] {
  if (raw == null || typeof raw !== 'object') return [];
  const message = raw as Record<string, any>;
  const arg = message.arg && typeof message.arg === 'object' ? message.arg : {};
  const channel = String(arg.channel ?? message.channel ?? '');
  if (channel !== OKX_SIGNAL_CHANNEL) return [];

  const rows = Array.isArray(message.data)
    ? message.data
    : message.signal
      ? (Array.isArray(message.signal) ? message.signal : [message.signal])
      : arg.token
        ? [arg]
        : [];

  return rows
    .map((row: unknown) => {
      if (row == null || typeof row !== 'object') return null;
      const value = row as Record<string, unknown>;
      return parseOkxSignal({
        ...value,
        ...(value.chainIndex == null && arg.chainIndex != null ? { chainIndex: arg.chainIndex } : {}),
        ...(value.timestamp == null && arg.timestamp != null ? { timestamp: arg.timestamp } : {}),
      });
    })
    .filter((signal: OkxSignal | null): signal is OkxSignal => signal !== null);
}
