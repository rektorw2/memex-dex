/**
 * Средства под LIVE-операцию: одно правило на ручную сделку и агента.
 *
 * Двойная трата возникает не из-за злого умысла, а из-за двух разных
 * ответов на вопрос «сколько можно потратить». Поэтому ответ один:
 * доступно минус то, что уже заморожено под другие операции
 * (`locked`), минус резерв на комиссии сети в нативном активе. Кто бы
 * ни спрашивал — форма ордера или агент — считает эту функцию, а
 * сама заморозка идёт через тот же `lock` в журнале.
 *
 * Здесь нет ключей, подписей и отправки: только арифметика допуска.
 * PAPER-счёт агента сюда не входит вовсе — это другие деньги.
 */
import Decimal from 'decimal.js';
import { AGENT_NETWORK_INFO, type AgentNetwork } from './agent-networks.js';
import { normalizeAddress, type ChainKey } from './token-registry.js';

/**
 * Каноническая идентичность нативного актива каждой сети.
 *
 * Нативный актив — это не тикер. Токен с символом ETH в Robinhood Chain
 * или BNB в BNB Chain может быть чем угодно; обёрнутые WBNB/WETH/wSOL —
 * тоже не газ. Поэтому актив узнаётся по паре «сеть + адрес»:
 *   • Solana: строка баланса SOL в системе ведётся под mint wrapped SOL
 *     (`So111…112`) — так заведено сидом и приёмом депозитов;
 *   • EVM: нулевой адрес — так его читает адаптер (`eth_getBalance`);
 *     `0xeeee…` — то же самое в терминах OKX, принимается как синоним.
 */
export interface NativeAssetIdentity {
  chain: ChainKey;
  symbol: string;
  decimals: number;
  /** Канонический адрес строки баланса. */
  address: string;
  /** Другие написания того же актива у провайдеров. */
  aliases: readonly string[];
}

const EVM_ZERO = '0x0000000000000000000000000000000000000000';
const EVM_OKX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const NATIVE_ASSETS: Record<ChainKey, NativeAssetIdentity> = {
  SOLANA: { chain: 'SOLANA', symbol: 'SOL', decimals: 9, address: 'So11111111111111111111111111111111111111112', aliases: [] },
  BNB: { chain: 'BNB', symbol: 'BNB', decimals: 18, address: EVM_ZERO, aliases: [EVM_OKX_NATIVE] },
  ROBINHOOD: { chain: 'ROBINHOOD', symbol: 'ETH', decimals: 18, address: EVM_ZERO, aliases: [EVM_OKX_NATIVE] },
  ETHEREUM: { chain: 'ETHEREUM', symbol: 'ETH', decimals: 18, address: EVM_ZERO, aliases: [EVM_OKX_NATIVE] },
  BASE: { chain: 'BASE', symbol: 'ETH', decimals: 18, address: EVM_ZERO, aliases: [EVM_OKX_NATIVE] },
};

/**
 * Сколько нативного актива держать нетронутым под комиссии.
 *
 * Консервативно: несколько сделок с запасом, а не одна впритык.
 * Сеть без резерва (ноль) означала бы, что последняя монета уйдёт в
 * сделку и на выход из неё платить будет нечем.
 */
export const NATIVE_FEE_RESERVE: Record<AgentNetwork, string> = {
  SOLANA: '0.01',
  BNB: '0.003',
  ROBINHOOD: '0.0005',
};

/** Нативный актив сети — по адресу и сети, а не по тикеру. */
export function isNativeAsset(chain: string, asset: { address: string; symbol?: string } | string): boolean {
  const identity = NATIVE_ASSETS[chain as ChainKey];
  if (!identity) return false;
  const address = typeof asset === 'string' ? asset : asset.address;
  if (typeof address !== 'string' || address.trim() === '') return false;
  const normalized = normalizeAddress(identity.chain, address);
  return normalized === normalizeAddress(identity.chain, identity.address)
    || identity.aliases.some((alias) => normalizeAddress(identity.chain, alias) === normalized);
}

/** Число в строке для арифметики допуска: Decimal, без плавающей точки. */
export type Amount = string | number | Decimal;
const dec = (value: Amount | null | undefined): Decimal => {
  try { return new Decimal(value == null ? 0 : value); } catch { return new Decimal(0); }
};

export interface AssetBalance {
  available: Amount;
  locked: Amount;
}

export interface LiveFundsInput {
  network: AgentNetwork;
  /** Есть ли у пользователя кошелёк в этой сети. */
  walletConnected: boolean;
  /** Баланс нативного актива (строка с каноническим адресом); `null` — строки нет. */
  native: AssetBalance | null;
  /** Актив, которым платят за вход; `null` — не выбран или нет. */
  spend: (AssetBalance & { symbol: string; isNative: boolean }) | null;
  /** Сколько этого актива нужно на операцию. */
  requiredAmount: Amount;
}

export type LiveFundsCode =
  | 'OK'
  | 'NO_WALLET'
  | 'NO_NATIVE_FOR_FEES'
  | 'NO_SPEND_ASSET'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_AMOUNT';

export interface LiveFundsVerdict {
  ok: boolean;
  code: LiveFundsCode;
  message: string;
  /** Резерв под комиссии в нативном активе (строка, точное число). */
  feeReserve: string;
  /** Сколько выбранного актива можно направить в операцию. */
  spendable: string;
  /** Чего не хватает (в выбранном активе), '0' если хватает. */
  shortfall: string;
}

/**
 * Сколько нативного актива можно потратить: свободное минус резерв.
 * `locked` не входит по определению — оно уже чьё-то.
 */
export function spendableNative(balance: AssetBalance | null, network: AgentNetwork): string {
  if (!balance) return '0';
  return Decimal.max(0, dec(balance.available).minus(NATIVE_FEE_RESERVE[network])).toString();
}

export interface GasReadiness {
  ok: boolean;
  code: 'OK' | 'NO_NATIVE_FOR_FEES';
  message: string;
  available: string;
  feeReserve: string;
}

/**
 * Есть ли на кошельке газ на комиссии — отдельно от допуска сделки.
 *
 * Ровно один резерв: доступно ≥ резерв. Это не «резерв плюс ещё столько
 * же на операцию» — такую ошибку давала проверка через допуск сделки с
 * суммой, равной резерву.
 */
export function nativeGasReady(native: AssetBalance | null, network: AgentNetwork): GasReadiness {
  const info = AGENT_NETWORK_INFO[network];
  const feeReserve = NATIVE_FEE_RESERVE[network];
  const available = dec(native?.available);
  if (!native || available.lt(feeReserve)) {
    return { ok: false, code: 'NO_NATIVE_FOR_FEES', message: `Недостаточно ${info.nativeSymbol} на комиссии ${info.label}: нужно держать не меньше ${feeReserve} ${info.nativeSymbol}, есть ${available.toString()}`, available: available.toString(), feeReserve };
  }
  return { ok: true, code: 'OK', message: `Газ есть: ${available.toString()} ${info.nativeSymbol} при резерве ${feeReserve}`, available: available.toString(), feeReserve };
}

export function liveFundsVerdict(input: LiveFundsInput): LiveFundsVerdict {
  const info = AGENT_NETWORK_INFO[input.network];
  const feeReserve = NATIVE_FEE_RESERVE[input.network];
  const fail = (code: LiveFundsCode, message: string, spendable = '0', shortfall = '0'): LiveFundsVerdict =>
    ({ ok: false, code, message, feeReserve, spendable, shortfall });

  if (!input.walletConnected) return fail('NO_WALLET', `Нет кошелька в сети ${info.label}: создайте его в разделе «Кошельки»`);
  const required = dec(input.requiredAmount);
  if (!required.isFinite() || required.lte(0)) return fail('INVALID_AMOUNT', 'Сумма операции должна быть больше нуля');
  if (!input.native || dec(input.native.available).lt(feeReserve)) {
    return fail('NO_NATIVE_FOR_FEES', `Недостаточно ${info.nativeSymbol} на комиссии ${info.label}: нужно держать не меньше ${feeReserve} ${info.nativeSymbol}`);
  }
  if (!input.spend) return fail('NO_SPEND_ASSET', 'Актив для операции не выбран или его нет на балансе');

  const spendable = input.spend.isNative
    ? dec(spendableNative(input.spend, input.network))
    : Decimal.max(0, dec(input.spend.available));
  if (spendable.lt(required)) {
    const shortfall = required.minus(spendable);
    return fail('INSUFFICIENT_FUNDS', `Не хватает ${shortfall.toString()} ${input.spend.symbol}: свободно ${spendable.toString()} с учётом резерва и уже замороженного`, spendable.toString(), shortfall.toString());
  }
  return { ok: true, code: 'OK', message: 'Средств достаточно', feeReserve, spendable: spendable.toString(), shortfall: '0' };
}

/**
 * Подходит ли адрес сети.
 *
 * Solana — base58 длиной 32–44 без 0, O, I, l; EVM-сети (BNB Chain,
 * Robinhood Chain) — 0x и сорок шестнадцатеричных знаков. Перевод на
 * адрес чужой сети — потеря средств без возврата, поэтому проверка
 * идёт до заявки, а не после.
 */
export function addressMatchesChain(chain: string, address: string): boolean {
  const value = address.trim();
  if (chain === 'SOLANA') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  if (chain === 'BNB' || chain === 'ROBINHOOD' || chain === 'ETHEREUM' || chain === 'BASE') return /^0x[0-9a-fA-F]{40}$/.test(value);
  return false;
}
