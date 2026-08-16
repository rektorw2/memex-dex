/**
 * Справочник сетей для интерфейса: подписи и ссылки на внешние обозреватели.
 *
 * Ссылки наружу на странице токена обязательны. Пользователь, который
 * собирается вложить деньги в мем-коин, должен иметь возможность за один
 * клик проверить контракт, держателей и историю пула в независимом
 * источнике. Платформа, прячущая эти данные, выглядит как ловушка.
 */

export interface ChainInfo {
  label: string;
  nativeSymbol: string;
  /** Обозреватель блоков: контракт токена. */
  explorerToken: (address: string) => string;
  /**
   * Страница кошелька в обозревателе.
   *
   * Отдельно от explorerToken: у обозревателей это разные разделы,
   * и открытие адреса кошелька по пути токена даёт пустую страницу
   * с ошибкой. Снаружи такая ссылка выглядит рабочей, поэтому
   * ошибка живёт долго.
   */
  explorerAddress: (address: string) => string;
  /** Страница пары на DexScreener. */
  dexScreener: (address: string) => string;
  /** Идентификатор сети в GeckoTerminal, null — не поддерживается. */
  geckoNetwork: string | null;
}

export const CHAINS: Record<string, ChainInfo> = {
  SOLANA: {
    label: 'Solana',
    nativeSymbol: 'SOL',
    explorerToken: (a) => `https://solscan.io/token/${a}`,
    explorerAddress: (a) => `https://solscan.io/account/${a}`,
    dexScreener: (a) => `https://dexscreener.com/solana/${a}`,
    geckoNetwork: 'solana',
  },
  BNB: {
    label: 'BNB Chain',
    nativeSymbol: 'BNB',
    explorerToken: (a) => `https://bscscan.com/token/${a}`,
    explorerAddress: (a) => `https://bscscan.com/address/${a}`,
    dexScreener: (a) => `https://dexscreener.com/bsc/${a}`,
    geckoNetwork: 'bsc',
  },
  BASE: {
    label: 'Base',
    nativeSymbol: 'ETH',
    explorerToken: (a) => `https://basescan.org/token/${a}`,
    explorerAddress: (a) => `https://basescan.org/address/${a}`,
    dexScreener: (a) => `https://dexscreener.com/base/${a}`,
    geckoNetwork: 'base',
  },
  ETHEREUM: {
    label: 'Ethereum',
    nativeSymbol: 'ETH',
    explorerToken: (a) => `https://etherscan.io/token/${a}`,
    explorerAddress: (a) => `https://etherscan.io/address/${a}`,
    dexScreener: (a) => `https://dexscreener.com/ethereum/${a}`,
    geckoNetwork: 'eth',
  },
  ROBINHOOD: {
    label: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    explorerToken: (a) => `https://explorer.robinhood.com/token/${a}`,
    explorerAddress: (a) => `https://explorer.robinhood.com/address/${a}`,
    dexScreener: (a) => `https://dexscreener.com/search?q=${a}`,
    geckoNetwork: null,
  },
};

export function chainLabel(chain: string): string {
  return CHAINS[chain]?.label ?? chain;
}

export function geckoTerminalPool(chain: string, poolAddress: string): string | null {
  const net = CHAINS[chain]?.geckoNetwork;
  return net ? `https://www.geckoterminal.com/${net}/pools/${poolAddress}` : null;
}
