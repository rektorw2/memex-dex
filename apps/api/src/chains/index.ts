import type { Chain } from '@prisma/client';
import { env } from '../lib/env.js';
import { SolanaAdapter } from './solana.js';
import { EvmAdapter } from './evm.js';
import type { ChainAdapter } from './types.js';

const adapters = new Map<Chain, ChainAdapter>();

adapters.set('SOLANA', new SolanaAdapter());

adapters.set(
  'BNB',
  new EvmAdapter({
    chain: 'BNB',
    chainId: 56,
    rpcUrl: env.BNB_RPC_URL,
    nativeSymbol: 'BNB',
    zeroExSupported: true,
  }),
);

adapters.set(
  'ETHEREUM',
  new EvmAdapter({
    chain: 'ETHEREUM',
    chainId: 1,
    rpcUrl: 'https://eth.llamarpc.com',
    nativeSymbol: 'ETH',
    zeroExSupported: true,
  }),
);

adapters.set(
  'BASE',
  new EvmAdapter({
    chain: 'BASE',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    nativeSymbol: 'ETH',
    zeroExSupported: true,
  }),
);

// Robinhood Chain подключается только если заданы RPC и chainId —
// иначе сеть просто не появится в списке и не сломает запуск.
if (env.RHC_RPC_URL && env.RHC_CHAIN_ID) {
  adapters.set(
    'ROBINHOOD',
    new EvmAdapter({
      chain: 'ROBINHOOD',
      chainId: env.RHC_CHAIN_ID,
      rpcUrl: env.RHC_RPC_URL,
      nativeSymbol: 'ETH',
      // На момент написания агрегаторы на RHC не подтверждены —
      // включить после проверки доступности 0x/Odos на этом chainId.
      zeroExSupported: false,
    }),
  );
}

export function getAdapter(chain: Chain): ChainAdapter {
  const a = adapters.get(chain);
  if (!a) throw new Error(`Сеть ${chain} не подключена (проверьте переменные окружения)`);
  return a;
}

export function supportedChains(): Chain[] {
  return [...adapters.keys()];
}

export type { ChainAdapter } from './types.js';
