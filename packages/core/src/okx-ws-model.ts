/**
 * Разбор живых событий OKX и раскладка подписок.
 *
 * Чистая часть WebSocket-интеграции: проверяется тестами без сокета
 * и без ключей. Здесь два разных дела, объединённых тем, что оба
 * не требуют сети.
 *
 * Первое — разбор push-сообщения. Он сложнее, чем кажется, потому что
 * документация и живой пример расходятся в названиях полей: в одном
 * месте `tokenContractAddress`, в другом `baseTokenContractAddress`.
 * Выбрать одно значило бы сломаться на половине событий, причём молча:
 * лента просто оказалась бы наполовину пустой, и списали бы это
 * на спокойный рынок.
 *
 * Второе — распределение адресов по соединениям. Одно соединение
 * держит двести адресов, и превышение не даёт ошибки: лишние адреса
 * просто не подписываются. Обнаруживается это как «кошелёк перестал
 * торговать», то есть никак. Поэтому раскладка считается явно
 * и проверяется тестом.
 */

import type { ChainKey } from './token-registry.js';
import { normalizeAddress } from './token-registry.js';
import { chainFromIndex, okxNum, okxInt, okxStr } from './okx-model.js';
import { okxMillis } from './okx-wallet-model.js';

// ────────────────────────── Подпись для сокета ──────────────────────────────

/**
 * Строка подписи при входе в WebSocket.
 *
 * Отличается от REST двумя вещами, и обе — источник многочасовой
 * отладки, если их перепутать. Время здесь в секундах, а не в ISO,
 * и путь всегда постоянный: /users/self/verify, независимо от того,
 * на что мы собираемся подписаться.
 */
export const WS_LOGIN_PATH = '/users/self/verify';

export function buildWsLoginPreHash(timestampSeconds: string | number): string {
  return `${timestampSeconds}GET${WS_LOGIN_PATH}`;
}

/** Время в секундах, как требует вход в сокет. */
export function wsTimestamp(now = Date.now()): string {
  return String(Math.floor(now / 1000));
}

/**
 * Не устарела ли отметка времени.
 *
 * OKX отвергает вход со старым временем, и понять это по ответу
 * трудно: сообщение об ошибке одинаково для неверной подписи
 * и для просроченного времени.
 */
export const WS_TIMESTAMP_MAX_AGE_SEC = 30;

export function isWsTimestampFresh(timestampSeconds: string | number, now = Date.now()): boolean {
  const t = Number(timestampSeconds);
  if (!Number.isFinite(t)) return false;
  return Math.abs(Math.floor(now / 1000) - t) <= WS_TIMESTAMP_MAX_AGE_SEC;
}

// ──────────────────────── Разбор ответа на вход ─────────────────────────────

export type LoginOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Вход удался только при event=login и code=0.
 *
 * Считать успехом отсутствие ошибки нельзя: сокет может ответить
 * чем угодно, и молчаливая подписка без входа даёт соединение,
 * которое открыто и не присылает ничего.
 */
export function parseLoginReply(raw: unknown): LoginOutcome | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const event = okxStr(r.event, 32);
  if (event !== 'login' && event !== 'error') return null;

  const code = String(r.code ?? '');

  if (event === 'login' && code === '0') return { ok: true };

  return {
    ok: false,
    code: code || 'unknown',
    message: okxStr(r.msg, 200) ?? 'вход отклонён',
  };
}

// ─────────────────────────── Разбор события ─────────────────────────────────

export interface LiveTradeEvent {
  /** Устойчивый идентификатор для дедупликации. */
  id: string;
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: 'BUY' | 'SELL';
  quoteSymbol: string | null;
  quoteAmount: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  /** Только для продаж: у покупки результата ещё нет. */
  realizedPnlUsd: number | null;
  tradedAt: number;
  txHash: string | null;
  trackerType: number | null;
  source: 'okx_websocket' | 'okx_rest';
  receivedAt: number;
  /** Насколько полон разбор: 0–1. */
  parsingConfidence: number;
}

export class LiveParseError extends Error {
  constructor(readonly reason: string) {
    super(`событие не разобрано: ${reason}`);
    this.name = 'LiveParseError';
  }
}

/**
 * Простая устойчивая свёртка строки.
 *
 * Нужна для событий без txHash. Криптографическая стойкость здесь
 * не требуется — задача только в том, чтобы одно и то же событие
 * давало один и тот же ключ, а разные события расходились.
 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }

  return (h1.toString(36) + h2.toString(36)).padStart(12, '0');
}

/**
 * Разбор живого события.
 *
 * Названия полей берутся с запасными вариантами: документация
 * и живой пример расходятся, и поддержать нужно оба. Отсутствие
 * txHash законно — в примере его нет вовсе, и отвергать такие
 * события значило бы выбросить половину ленты.
 */
export function parseLiveTrade(
  raw: unknown,
  opts: { source?: 'okx_websocket' | 'okx_rest'; now?: number } = {},
): LiveTradeEvent {
  if (raw == null || typeof raw !== 'object') {
    throw new LiveParseError('не объект');
  }

  const r = raw as Record<string, unknown>;

  // Запасные названия — не «на всякий случай», а обязательная часть
  // разбора: они встречаются в живом потоке наравне с основными.
  const chainRaw = r.chainIndex ?? r.baseTokenChainIndex;
  const tokenRaw = r.tokenContractAddress ?? r.baseTokenContractAddress;
  const symbolRaw = r.tokenSymbol ?? r.baseTokenSymbol;
  const priceRaw = r.tokenPrice ?? r.tradePrice;

  const chain = chainFromIndex(chainRaw as string);
  if (!chain) throw new LiveParseError('неизвестная сеть');

  const wallet = okxStr(r.walletAddress, 128);
  if (!wallet) throw new LiveParseError('нет адреса кошелька');

  const token = okxStr(tokenRaw, 128);
  if (!token) throw new LiveParseError('нет адреса токена');

  // Время приходит и числом, и строкой — okxMillis принимает оба.
  const tradedAt = okxMillis(r.tradeTime);
  if (tradedAt == null) throw new LiveParseError('нет или неверное время сделки');

  const typeRaw = okxInt(r.tradeType);
  if (typeRaw !== 1 && typeRaw !== 2) {
    // Направление угадывать нельзя: перепутанное испортит весь учёт.
    throw new LiveParseError('неизвестное направление сделки');
  }
  const side: 'BUY' | 'SELL' = typeRaw === 1 ? 'BUY' : 'SELL';

  const normWallet = normalizeAddress(chain, wallet);
  const normToken = normalizeAddress(chain, token);
  const txHash = okxStr(r.txHash, 160);
  const quoteAmount = okxNum(r.quoteTokenAmount);

  const id = txHash
    ? [chainRaw, txHash, normWallet, normToken, typeRaw].join('|')
    : // Без хеша ключ собирается из того, что делает событие
      // уникальным: те же кошелёк, токен, направление, время
      // и объём дважды не повторяются.
      'h:' +
      stableHash(
        [chainRaw, normWallet, normToken, typeRaw, tradedAt, quoteAmount ?? ''].join('|'),
      );

  const optional = [symbolRaw, priceRaw, r.marketCap, r.quoteTokenSymbol, quoteAmount];
  const present = optional.filter((v) => v != null && v !== '').length;

  return {
    id,
    chain,
    wallet: normWallet,
    tokenAddress: normToken,
    tokenSymbol: okxStr(symbolRaw, 32),
    side,
    quoteSymbol: okxStr(r.quoteTokenSymbol, 32),
    quoteAmount,
    priceUsd: okxNum(priceRaw),
    marketCapUsd: okxNum(r.marketCap),
    realizedPnlUsd: side === 'SELL' ? okxNum(r.realizedPnlUsd) : null,
    tradedAt,
    txHash,
    trackerType: okxInt(r.trackerType),
    source: opts.source ?? 'okx_websocket',
    receivedAt: opts.now ?? Date.now(),
    // Без хеша событие менее надёжно опознаётся, и это честно
    // отражается в уверенности разбора.
    parsingConfidence: (present / optional.length) * (txHash ? 1 : 0.9),
  };
}

// ────────────────────── Распределение подписок ──────────────────────────────

/**
 * Сколько адресов держит одно соединение.
 *
 * Превышение не даёт ошибки — лишние адреса просто не подписываются.
 * Именно поэтому раскладка считается здесь явно: молчаливое
 * усечение выглядит как «кошелёк перестал торговать».
 */
export const MAX_ADDRESSES_PER_CONNECTION = 200;

export interface ConnectionPlan {
  /** Номер соединения, начиная с нуля. */
  index: number;
  addresses: string[];
}

/**
 * Разложить адреса по соединениям.
 *
 * Раскладка устойчивая: один и тот же набор адресов всегда даёт
 * одно и то же распределение. Это важно при переподключении —
 * иначе после обрыва адреса перемешались бы между соединениями,
 * и часть подписок пришлось бы снимать и ставить заново без нужды.
 */
export function planConnections(
  addresses: string[],
  maxPerConnection = MAX_ADDRESSES_PER_CONNECTION,
): ConnectionPlan[] {
  // Дедупликация до раскладки: один адрес не должен подписываться
  // дважды, даже если пришёл из двух источников.
  const unique = [...new Set(addresses)].sort();

  const plans: ConnectionPlan[] = [];
  for (let i = 0; i < unique.length; i += maxPerConnection) {
    plans.push({ index: plans.length, addresses: unique.slice(i, i + maxPerConnection) });
  }

  return plans;
}

/**
 * Что изменилось между двумя раскладками.
 *
 * Нужно, чтобы добавление одного адреса не требовало пересоздания
 * всех подписок: сокет остаётся, отправляются только разницы.
 */
export function diffSubscriptions(
  current: string[],
  next: string[],
): { toAdd: string[]; toRemove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);

  return {
    toAdd: [...nxt].filter((a) => !cur.has(a)),
    toRemove: [...cur].filter((a) => !nxt.has(a)),
  };
}

// ─────────────────────── Задержка переподключения ───────────────────────────

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/**
 * Задержка перед следующей попыткой.
 *
 * Растёт вдвое с каждой неудачей и имеет потолок: без потолка
 * после суток простоя соединение не восстановится вовсе. Разброс
 * нужен, чтобы несколько соединений не били в сервер одновременно
 * после общего сбоя.
 */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS);
  // Разброс до четверти задержки в обе стороны.
  return Math.round(base * (0.75 + random() * 0.5));
}
