/**
 * Единый серверный снимок PnL кошелька.
 *
 * Сделки и цены читаются пакетно из нашей базы. Этот сервис никогда
 * не обращается к OKX: обновление вкладки «Активность» или списка
 * избранного не должно расходовать внешнюю квоту и не должно менять
 * результат в зависимости от доступности провайдера в эту секунду.
 */

import {
  calculateWalletLedger,
  normalizeAddress,
  walletPnlSnapshot,
  type CanonicalTrade,
  type ChainKey,
  type WalletPnlSnapshot,
  type WalletPriceMark,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { markHotFromList } from '../workers/hot-tokens.js';
import { loadWalletHistory } from './wallet-history.js';

export interface WalletRef {
  chain: ChainKey;
  address: string;
}

export interface PublicWalletPnlSnapshot {
  state: WalletPnlSnapshot['state'];
  assetsUsd: number | null;
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  totalUsd: number | null;
  closedPositions: number;
  openPositions: number;
  incompleteTokens: number;
  ambiguousTokens: number;
  unpricedPositions: number;
  isStale: boolean;
  computedAt: string | null;
  priceAsOf: string | null;
  method: WalletPnlSnapshot['method'];
  version: WalletPnlSnapshot['version'];
}

/** Единый ключ PnL; нужен и сервису, и маршрутам-потребителям. */
export function walletPnlKey(chain: string, address: string): string {
  return `${chain}:${normalizeAddress(chain as ChainKey, address)}`;
}

/** История порциями из одного снимка БД, затем пакет сохранённых цен. */
export async function walletPnlForWallets(
  input: WalletRef[],
  now = Date.now(),
): Promise<Map<string, WalletPnlSnapshot>> {
  const refs = new Map<string, WalletRef>();
  for (const wallet of input) {
    const address = normalizeAddress(wallet.chain, wallet.address);
    refs.set(walletPnlKey(wallet.chain, address), { chain: wallet.chain, address });
  }

  const out = new Map<string, WalletPnlSnapshot>();
  if (refs.size === 0) return out;

  const trades = await loadWalletHistory({
    OR: [...refs.values()].map((wallet) => ({
      chain: wallet.chain as never,
      walletAddress: wallet.address,
    })),
    // `superseded` — старые fills уже входят в каноническую строку.
    // `ambiguous` читается намеренно: число из неё не считается,
    // но сам факт неоднозначности обязан попасть в публичное состояние.
    reconciliation: { in: ['canonical', 'confirmed', 'ambiguous'] },
  });

  const tradesByWallet = new Map<string, CanonicalTrade[]>();
  for (const trade of trades) {
    const key = walletPnlKey(trade.chain, trade.wallet);
    const list = tradesByWallet.get(key) ?? [];
    list.push(trade);
    tradesByWallet.set(key, list);
  }

  const ledgers = new Map(
    [...refs.keys()].map((key) => [key, calculateWalletLedger(tradesByWallet.get(key) ?? [])]),
  );

  // Сначала узнаём только реально открытые позиции, затем одной
  // выборкой получаем их сохранённые котировки. Закрытый токен цены
  // не требует, а запрос по одному токену создавал бы N+1.
  const markPairs = new Map<string, { chain: ChainKey; address: string }>();
  for (const ledger of ledgers.values()) {
    for (const position of ledger.positions) {
      if (position.isClosed) continue;
      const key = walletPnlKey(position.chain, position.tokenAddress);
      markPairs.set(key, {
        chain: position.chain as ChainKey,
        address: normalizeAddress(position.chain as ChainKey, position.tokenAddress),
      });
    }
  }

  const tokenRows = markPairs.size === 0
    ? []
    : await prisma.token.findMany({
        where: {
          OR: [...markPairs.values()].map((token) => ({
            chain: token.chain as never,
            address: token.address,
          })),
        },
        select: { id: true, chain: true, address: true, priceUsd: true, priceUpdatedAt: true },
      });

  // Пока пользователь смотрит Smart Wallets, открытые позиции должны
  // получать ту же приоритетную котировку, что токен в терминале.
  // Список ограничен общим бюджетом hot-token очереди и не создаёт
  // прямых запросов к провайдеру из HTTP-маршрута.
  markHotFromList(tokenRows.map((token) => token.id));

  const marks: WalletPriceMark[] = tokenRows
    .filter((token) => token.priceUsd != null && token.priceUpdatedAt != null)
    .map((token) => ({
      chain: token.chain,
      tokenAddress: token.address,
      priceUsd: token.priceUsd!.toString(),
      observedAt: token.priceUpdatedAt!.getTime(),
    }));

  for (const [key, ledger] of ledgers) {
    out.set(key, walletPnlSnapshot(ledger, marks, { computedAt: now }));
  }

  return out;
}

function finite(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Преобразование в number — только на границе JSON для текущего web-клиента. */
export function serializeWalletPnl(snapshot: WalletPnlSnapshot): PublicWalletPnlSnapshot {
  return {
    state: snapshot.state,
    assetsUsd: finite(snapshot.assetsUsd),
    realizedUsd: finite(snapshot.realizedUsd),
    unrealizedUsd: finite(snapshot.unrealizedUsd),
    totalUsd: finite(snapshot.totalUsd),
    closedPositions: snapshot.closedPositions,
    openPositions: snapshot.openPositions,
    incompleteTokens: snapshot.incompleteTokens,
    ambiguousTokens: snapshot.ambiguousTokens,
    unpricedPositions: snapshot.unpricedPositions,
    isStale: snapshot.isStale,
    computedAt: snapshot.computedAt == null ? null : new Date(snapshot.computedAt).toISOString(),
    priceAsOf: snapshot.priceAsOf == null ? null : new Date(snapshot.priceAsOf).toISOString(),
    method: snapshot.method,
    version: snapshot.version,
  };
}
