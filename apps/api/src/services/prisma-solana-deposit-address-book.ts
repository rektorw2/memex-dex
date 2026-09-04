import { prisma } from '../lib/prisma.js';
import {
  scanAddressesForOwner,
  type SolanaDepositAddressBook,
  type SolanaWatchedDestination,
} from './solana-rpc-deposit-source.js';

/** Database-owned list of addresses that the chain reader may inspect. */
export class PrismaSolanaDepositAddressBook implements SolanaDepositAddressBook {
  async listActiveDestinations(): Promise<SolanaWatchedDestination[]> {
    const wallets = await prisma.wallet.findMany({
      where: {
        chain: 'SOLANA',
        kind: 'HOT_DEPOSIT',
        isActive: true,
        userId: { not: null },
      },
      select: { address: true },
      distinct: ['address'],
    });
    if (wallets.length === 0) return [];

    const cursors = await prisma.solanaDepositAddressCursor.findMany({
      where: { address: { in: wallets.map((wallet) => wallet.address) } },
      select: { address: true, scannedThroughSlot: true },
    });
    const byAddress = new Map(cursors.map((row) => [row.address, row.scannedThroughSlot]));

    return wallets.map(({ address }) => ({
      ownerAddress: address,
      scanAddresses: scanAddressesForOwner(address),
      /*
       * Отсутствие курсора — не ноль.
       *
       * Ноль означал бы «просмотрено с начала цепочки», то есть
       * ровно противоположное правде. `null` заставляет источник
       * просмотреть ограниченное окно назад и только потом
       * записать курсор.
       */
      scannedThroughSlot: byAddress.get(address) ?? null,
    }));
  }

  async recordScannedThrough(ownerAddresses: readonly string[], slot: bigint): Promise<void> {
    for (const address of ownerAddresses) {
      /*
       * Курсор только растёт.
       *
       * Два процесса могут закончить циклы в обратном порядке.
       * Безусловная запись опустила бы курсор к более раннему слоту
       * и заставила бы просматривать заново уже просмотренное — не
       * опасно, но бесконечно.
       */
      const raised = await prisma.solanaDepositAddressCursor.updateMany({
        where: { address, scannedThroughSlot: { lt: slot } },
        data: { scannedThroughSlot: slot },
      });
      if (raised.count === 0) {
        await prisma.solanaDepositAddressCursor.upsert({
          where: { address },
          create: { address, scannedThroughSlot: slot },
          update: {},
        });
      }
    }
  }
}
