/**
 * Средства пользователя по сетям — для выбора кошелька и допуска
 * LIVE-операции.
 *
 * Считается по тем же строкам `Balance`, что и остальная система:
 * `available` и `locked`. Правило допуска — в ядре
 * (`liveFundsVerdict`), заморозка — в `balances.lock`. Этот модуль
 * лишь собирает факты и не открывает никакого нового пути к деньгам:
 * ни ключей, ни подписи, ни отправки здесь нет.
 */
import type { Prisma } from '@prisma/client';
import {
  AGENT_NETWORKS,
  AGENT_NETWORK_INFO,
  NATIVE_FEE_RESERVE,
  isNativeAsset,
  liveFundsVerdict,
  nativeGasReady,
  normalizeAgentNetwork,
  spendableNative,
  type AgentNetwork,
  type GasReadiness,
  type LiveFundsVerdict,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import * as balances from './balances.js';

export interface NetworkFunds {
  chain: AgentNetwork;
  label: string;
  nativeSymbol: string;
  /** Адрес депозитного кошелька в этой сети, если он есть. */
  depositAddress: string | null;
  walletId: string | null;
  native: { tokenId: string; available: string; locked: string; spendable: string; feeReserve: string } | null;
  /** Сколько токенов (не нативных) лежит на балансе в этой сети. */
  tokenAssets: number;
}

type BalanceRow = { tokenId: string; available: Prisma.Decimal; locked: Prisma.Decimal; token: { chain: string; symbol: string; address: string } };
type WalletRow = { id: string; chain: string; address: string };

/** Чистая сборка: принимает уже прочитанные строки, чтобы её можно было проверить без базы. */
export function networkFundsFrom(balanceRows: BalanceRow[], wallets: WalletRow[]): NetworkFunds[] {
  return AGENT_NETWORKS.map((chain) => {
    const info = AGENT_NETWORK_INFO[chain];
    const wallet = wallets.find((row) => row.chain === chain) ?? null;
    const rows = balanceRows.filter((row) => row.token.chain === chain && row.available.plus(row.locked).gt(0));
    // Нативный актив — по адресу строки, не по тикеру: токен «BNB» с чужим контрактом газом не является.
    const nativeRow = rows.find((row) => isNativeAsset(chain, row.token)) ?? null;
    const native = nativeRow
      ? {
          tokenId: nativeRow.tokenId,
          available: nativeRow.available.toString(),
          locked: nativeRow.locked.toString(),
          spendable: spendableNative({ available: nativeRow.available.toString(), locked: nativeRow.locked.toString() }, chain),
          feeReserve: NATIVE_FEE_RESERVE[chain],
        }
      : null;
    return {
      chain,
      label: info.label,
      nativeSymbol: info.nativeSymbol,
      depositAddress: wallet?.address ?? null,
      walletId: wallet?.id ?? null,
      native,
      tokenAssets: rows.filter((row) => row !== nativeRow).length,
    };
  });
}

export async function networkFundsOf(userId: string): Promise<NetworkFunds[]> {
  const [balanceRows, wallets] = await Promise.all([
    prisma.balance.findMany({ where: { userId }, include: { token: { select: { chain: true, symbol: true, address: true } } } }),
    prisma.wallet.findMany({ where: { userId, kind: 'HOT_DEPOSIT', isActive: true }, select: { id: true, chain: true, address: true } }),
  ]);
  return networkFundsFrom(balanceRows, wallets);
}

/**
 * Допуск операции на сумму `amount` актива `tokenId` в сети `chain`.
 * Один вызов для ручного ордера и для агента.
 */
/**
 * Какие кошельки годятся как источник средств LIVE-операции.
 *
 * Созданные и импортированные пользователем кошельки хранятся как
 * HOT_TRADING, персональные адреса депозита — HOT_DEPOSIT. Оба
 * принадлежат пользователю и подписываются сервером; холодные и
 * сборщик комиссий — нет.
 */
export const LIVE_WALLET_KINDS = ['HOT_DEPOSIT', 'HOT_TRADING'] as const;

const WALLET_SELECT = { id: true, userId: true, chain: true, isActive: true, kind: true, address: true } as const;
type UsableWallet = { id: string; userId: string | null; chain: string; isActive: boolean; kind: string; address: string };

/**
 * Кошелёк — источник средств операции.
 *
 * Если идентичность передана (выбранный кошелёк), она проверяется как
 * есть: принадлежность, активность, сеть, допустимый вид. Поиск
 * «какого-нибудь» кошелька другого вида вместо выбранного не делается.
 * Без идентичности (ручной ордер без выбора) берётся активный кошелёк
 * пользователя в сети любого допустимого вида.
 */
async function resolveFundsWallet(tx: Prisma.TransactionClient, userId: string, network: AgentNetwork, walletId?: string | null): Promise<UsableWallet | null> {
  if (walletId) {
    const wallet = await tx.wallet.findUnique({ where: { id: walletId }, select: WALLET_SELECT });
    assertWalletUsable(wallet, userId, network);
    return wallet;
  }
  return tx.wallet.findFirst({ where: { userId, chain: network, kind: { in: [...LIVE_WALLET_KINDS] }, isActive: true }, select: WALLET_SELECT });
}

export async function liveFundsCheck(
  tx: Prisma.TransactionClient,
  params: { userId: string; chain: string; tokenId: string; amount: Prisma.Decimal | string | number; walletId?: string | null },
): Promise<LiveFundsVerdict> {
  const network = normalizeAgentNetwork(params.chain);
  if (!network) {
    return { ok: false, code: 'NO_WALLET', message: `Сеть ${params.chain} агенту и LIVE-операциям недоступна`, feeReserve: '0', spendable: '0', shortfall: '0' };
  }
  const [wallet, rows] = await Promise.all([
    resolveFundsWallet(tx, params.userId, network, params.walletId),
    tx.balance.findMany({ where: { userId: params.userId, token: { chain: network } }, include: { token: { select: { chain: true, symbol: true, address: true } } } }),
  ]);
  return liveFundsVerdictFromRows({ network, walletConnected: wallet != null, rows, tokenId: params.tokenId, amount: params.amount });
}

/** Чистая часть допуска: строки уже прочитаны, порядок строк роли не играет. */
export function liveFundsVerdictFromRows(params: { network: AgentNetwork; walletConnected: boolean; rows: BalanceRow[]; tokenId: string; amount: Prisma.Decimal | string | number }): LiveFundsVerdict {
  const { network, rows } = params;
  const nativeRow = rows.find((row) => row.token.chain === network && isNativeAsset(network, row.token)) ?? null;
  const spendRow = rows.find((row) => row.tokenId === params.tokenId) ?? null;
  return liveFundsVerdict({
    network,
    walletConnected: params.walletConnected,
    native: nativeRow ? { available: nativeRow.available.toString(), locked: nativeRow.locked.toString() } : null,
    spend: spendRow
      ? { symbol: spendRow.token.symbol, isNative: isNativeAsset(network, spendRow.token), available: spendRow.available.toString(), locked: spendRow.locked.toString() }
      : null,
    requiredAmount: String(params.amount),
  });
}

export class LiveFundsError extends Error {
  constructor(readonly verdict: LiveFundsVerdict) {
    super(verdict.message);
    this.name = 'LiveFundsError';
  }
}

/**
 * Проверить допуск и заморозить — одной транзакцией.
 *
 * Тот же `balances.lock`, что у ордеров: агент не получает отдельного
 * пути к заморозке, а значит и отдельного способа потратить дважды.
 *
 * Требование кошелька в сети и резерва нативного актива действует
 * только при реальном исполнении (`EXECUTION_MODE=live`): у PAPER-
 * баланса нет ни адреса, ни комиссий сети, и требовать их значило бы
 * запретить бумажную сделку по причине, которой в ней не существует.
 * Заморозка при этом одна и та же в обоих режимах.
 */
export async function reserveSpend(
  tx: Prisma.TransactionClient,
  params: { userId: string; chain: string; tokenId: string; amount: Prisma.Decimal | string; refId: string; walletId?: string | null },
  options: { live?: boolean } = {},
): Promise<LiveFundsVerdict | null> {
  const live = options.live ?? env.EXECUTION_MODE === 'live';
  const verdict = live ? await liveFundsCheck(tx, params) : null;
  if (verdict && !verdict.ok) throw new LiveFundsError(verdict);
  await balances.lock(tx, { userId: params.userId, tokenId: params.tokenId, amount: params.amount, refId: params.refId });
  return verdict;
}

// ───────────────────── Выбранный кошелёк для LIVE-операций ─────────────────────

export type LiveWalletSelectionCode = 'OK' | 'WALLET_NOT_FOUND' | 'WALLET_NOT_OWNED' | 'WALLET_INACTIVE' | 'WALLET_WRONG_NETWORK' | 'WALLET_KIND_NOT_ALLOWED' | 'NETWORK_NOT_SUPPORTED';

export class LiveWalletSelectionError extends Error {
  constructor(readonly code: LiveWalletSelectionCode, message: string) {
    super(message);
    this.name = 'LiveWalletSelectionError';
  }
}

/** Кошелёк годится для сети и принадлежит пользователю — одна проверка на выбор и на подготовку операции. */
function assertWalletUsable(wallet: { userId: string | null; chain: string; isActive: boolean; kind: string } | null, userId: string, network: AgentNetwork): asserts wallet is UsableWallet {
  if (!wallet) throw new LiveWalletSelectionError('WALLET_NOT_FOUND', 'Кошелёк не найден');
  // Чужой кошелёк отвечает так же, как отсутствующий: существование чужой записи не выдаётся.
  if (wallet.userId !== userId) throw new LiveWalletSelectionError('WALLET_NOT_FOUND', 'Кошелёк не найден');
  if (!wallet.isActive) throw new LiveWalletSelectionError('WALLET_INACTIVE', 'Кошелёк отключён');
  if (wallet.chain !== network) throw new LiveWalletSelectionError('WALLET_WRONG_NETWORK', `Кошелёк сети ${wallet.chain} нельзя выбрать для ${AGENT_NETWORK_INFO[network].label}`);
  if (!(LIVE_WALLET_KINDS as readonly string[]).includes(wallet.kind)) throw new LiveWalletSelectionError('WALLET_KIND_NOT_ALLOWED', `Кошелёк вида ${wallet.kind} не может быть источником средств операции`);
}

/**
 * Сохранить выбор кошелька для сети. Хранится на сервере; интерфейс
 * только показывает и меняет. Проверяется принадлежность, активность
 * и сеть — тем же правилом, что и при подготовке операции.
 */
export async function selectLiveWallet(userId: string, networkInput: string, walletId: string) {
  const network = normalizeAgentNetwork(networkInput);
  if (!network) throw new LiveWalletSelectionError('NETWORK_NOT_SUPPORTED', `Сеть ${networkInput} агенту недоступна`);
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, select: { id: true, userId: true, chain: true, isActive: true, kind: true, address: true } });
  assertWalletUsable(wallet, userId, network);
  const row = await prisma.agentLiveWallet.upsert({
    where: { userId_network: { userId, network } },
    create: { userId, network, walletId },
    update: { walletId },
  });
  return { network, walletId: row.walletId, address: wallet!.address, updatedAt: row.updatedAt };
}

/** Текущий выбор по сетям, с адресами. Кошелёк, ставший чужим или отключённым, помечается, а не подставляется. */
export async function liveWalletSelections(userId: string) {
  const rows = await prisma.agentLiveWallet.findMany({ where: { userId } });
  const wallets = await prisma.wallet.findMany({ where: { id: { in: rows.map((row) => row.walletId) } }, select: { id: true, userId: true, chain: true, isActive: true, kind: true, address: true } });
  return AGENT_NETWORKS.map((network) => {
    const row = rows.find((r) => r.network === network) ?? null;
    const wallet = row ? wallets.find((w) => w.id === row.walletId) ?? null : null;
    let problem: LiveWalletSelectionCode | null = null;
    if (row) {
      try { assertWalletUsable(wallet, userId, network); } catch (e) { problem = e instanceof LiveWalletSelectionError ? e.code : 'WALLET_NOT_FOUND'; }
    }
    return { network, walletId: row?.walletId ?? null, address: problem ? null : wallet?.address ?? null, problem, selectedAt: row?.updatedAt ?? null };
  });
}

export interface LiveOperationPreparation {
  network: AgentNetwork;
  wallet: { id: string; address: string };
  funds: LiveFundsVerdict;
  /** Заморожено ли под операцию (только при реальном исполнении и достаточных средствах). */
  reserved: boolean;
}

/**
 * Подготовка LIVE-операции агента: выбранный кошелёк → допуск средств
 * → заморозка тем же `reserveSpend`, что у ручных ордеров.
 *
 * Отправки здесь нет и быть не может: подготовка заканчивается
 * записью резерва, а транзакция остаётся заблокированной (BROADCAST_LOCKED).
 * В PAPER-режиме кошелёк проверяется, средства — нет: реальных денег
 * операция не касается.
 */
export async function prepareLiveOperation(
  tx: Prisma.TransactionClient,
  params: { userId: string; network: string; tokenId: string; amount: Prisma.Decimal | string; refId: string; live?: boolean },
): Promise<LiveOperationPreparation> {
  const network = normalizeAgentNetwork(params.network);
  if (!network) throw new LiveWalletSelectionError('NETWORK_NOT_SUPPORTED', `Сеть ${params.network} агенту недоступна`);
  const selection = await tx.agentLiveWallet.findUnique({ where: { userId_network: { userId: params.userId, network } } });
  if (!selection) throw new LiveWalletSelectionError('WALLET_NOT_FOUND', `Кошелёк для ${AGENT_NETWORK_INFO[network].label} не выбран: выберите его на странице агента`);
  const wallet = await tx.wallet.findUnique({ where: { id: selection.walletId }, select: WALLET_SELECT });
  assertWalletUsable(wallet, params.userId, network);
  const live = params.live ?? env.EXECUTION_MODE === 'live';
  // Проверенная идентичность выбранного кошелька идёт дальше как есть: допуск и резерв — под неё, не под «какой-нибудь» другой.
  const funds = await liveFundsCheck(tx, { userId: params.userId, chain: network, tokenId: params.tokenId, amount: params.amount, walletId: wallet.id });
  if (live) {
    // Тот же путь заморозки, что у ручного ордера: отдельного способа потратить дважды у агента нет.
    await reserveSpend(tx, { userId: params.userId, chain: network, tokenId: params.tokenId, amount: params.amount, refId: params.refId, walletId: wallet.id }, { live: true });
  }
  return { network, wallet: { id: wallet.id, address: wallet.address }, funds, reserved: live };
}

/**
 * Готов ли выбранный кошелёк к подтверждению предложения агента:
 * выбран, принадлежит пользователю, активен, и на нём есть нативный
 * актив хотя бы на резерв комиссий. Сумму сделки здесь не морозят —
 * это делает `prepareLiveOperation` при создании намерения.
 */
export async function assertLiveWalletReady(userId: string, networkInput: string): Promise<{ network: AgentNetwork; wallet: { id: string; address: string }; gas: GasReadiness }> {
  const network = normalizeAgentNetwork(networkInput);
  if (!network) throw new LiveWalletSelectionError('NETWORK_NOT_SUPPORTED', `Сеть ${networkInput} агенту недоступна`);
  const selection = await prisma.agentLiveWallet.findUnique({ where: { userId_network: { userId, network } } });
  if (!selection) throw new LiveWalletSelectionError('WALLET_NOT_FOUND', `Кошелёк для ${AGENT_NETWORK_INFO[network].label} не выбран: выберите его на странице агента`);
  const wallet = await prisma.wallet.findUnique({ where: { id: selection.walletId }, select: WALLET_SELECT });
  assertWalletUsable(wallet, userId, network);
  const rows = await prisma.balance.findMany({ where: { userId, token: { chain: network } }, include: { token: { select: { chain: true, symbol: true, address: true } } } });
  const nativeRow = rows.find((row) => isNativeAsset(network, row.token)) ?? null;
  // Наличие газа — ровно один резерв, а не допуск сделки на сумму резерва (тот требовал бы два).
  const gas = nativeGasReady(nativeRow ? { available: nativeRow.available.toString(), locked: nativeRow.locked.toString() } : null, network);
  return { network, wallet: { id: wallet.id, address: wallet.address }, gas };
}

/**
 * Снять резерв, поставленный `reserveSpend`/`prepareLiveOperation`.
 *
 * Внутри одной транзакции резерв откатывается вместе с ней — этого
 * достаточно, когда подготовка и запись намерения идут одним `tx`.
 * Если резерв уже зафиксирован, а следующий шаг (котировка, подпись)
 * отказал, средства обязаны вернуться тем же `unlock`, что у ордеров:
 * замороженное «навсегда» — та же потеря, что и списанное.
 */
export async function releaseSpend(
  tx: Prisma.TransactionClient,
  params: { userId: string; tokenId: string; amount: Prisma.Decimal | string; refId: string },
): Promise<void> {
  await balances.unlock(tx, { userId: params.userId, tokenId: params.tokenId, amount: params.amount, refId: params.refId });
}
