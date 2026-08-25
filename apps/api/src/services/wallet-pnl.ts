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

export interface WalletRef {
  chain: ChainKey;
  address: string;
}

export interface PublicWalletPnlSnapshot {
  state: WalletPnlSnapshot['state'];
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

function toCanonical(row: {
  key: string;
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: string;
  amount: { toString(): string };
  valueUsd: { toString(): string };
  price: { toString(): string };
  marketCapUsd: { toString(): string } | null;
  providerPnlUsd: { toString(): string } | null;
  tradedAt: Date;
  reconciliation: string;
}): CanonicalTrade {
  return {
    key: row.key,
    chain: row.chain as ChainKey,
    wallet: row.walletAddress,
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    side: row.side as 'BUY' | 'SELL',
    amount: row.amount.toString(),
    valueUsd: row.valueUsd.toString(),
    price: row.price.toString(),
    marketCapUsd: row.marketCapUsd?.toString() ?? null,
    // Сохраняется для аудита и сверки, calculateWalletLedger это
    // поле принципиально не читает.
    providerPnlUsd: row.providerPnlUsd?.toString() ?? null,
    tradedAt: row.tradedAt.getTime(),
    ambiguous: row.reconciliation === 'ambiguous',
  };
}

/** Один запрос сделок и один запрос цен на весь набор кошельков. */
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

  const rows = await prisma.walletEconomicTrade.findMany({
    where: {
      OR: [...refs.values()].map((wallet) => ({
        chain: wallet.chain as never,
        walletAddress: wallet.address,
      })),
      // `superseded` — старые fills уже входят в каноническую строку.
      // `ambiguous` читается намеренно: число из неё не считается,
      // но сам факт неоднозначности обязан попасть в публичное состояние.
      reconciliation: { in: ['canonical', 'confirmed', 'ambiguous'] },
    },
    orderBy: [{ tradedAt: 'asc' }, { key: 'asc' }],
    select: {
      key: true,
      chain: true,
      walletAddress: true,
      tokenAddress: true,
      tokenSymbol: true,
      side: true,
      amount: true,
      valueUsd: true,
      price: true,
      marketCapUsd: true,
      providerPnlUsd: true,
      tradedAt: true,
      reconciliation: true,
    },
  });

  const tradesByWallet = new Map<string, CanonicalTrade[]>();
  for (const row of rows) {
    const key = walletPnlKey(row.chain, row.walletAddress);
    const list = tradesByWallet.get(key) ?? [];
    list.push(toCanonical(row));
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
        select: { chain: true, address: true, priceUsd: true, priceUpdatedAt: true },
      });

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
