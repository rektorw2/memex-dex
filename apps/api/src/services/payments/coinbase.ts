import {
  fromCoinbaseStatus,
  isAllowedCoinbaseType,
  COINBASE_TRANSACTION_STATUS,
  type PaymentState,
} from '@memex/core';
import { createCdpJwt } from './coinbase-auth.js';

/**
 * Coinbase Onramp через официальный HTTPS API.
 *
 * Единственное место, где встречаются поля Coinbase. Наружу выходят
 * уже наши понятия — как и у адаптера Bridge.
 *
 * Два вызова: создать одноразовый токен сессии и прочитать состояние
 * транзакции. Больше проекту от Coinbase ничего не нужно, и общего
 * прокси к их API здесь нет намеренно: список действий с деньгами
 * должен определяться нами, а не тем, что провайдер добавил в свою
 * документацию.
 *
 * Токен сессии одноразовый и живёт пять минут. Он не кешируется,
 * не пишется в журнал и не хранится в базе: перехваченный токен —
 * это чужая страница оплаты, привязанная к нашему адресу
 * казначейства.
 */

const API_HOST = 'api.developer.coinbase.com';
const TOKEN_PATH = '/onramp/v1/token';

/** Куда уходит человек. Песочница и боевая среда — разные адреса. */
export const HOSTED_URL = {
  production: 'https://pay.coinbase.com/buy/select-asset',
  sandbox: 'https://pay-sandbox.coinbase.com/buy/select-asset',
} as const;

const TIMEOUT_MS = 15_000;
const READ_RETRIES = 2;

export type CoinbaseFailure =
  | 'DISABLED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNAVAILABLE'
  | 'MALFORMED'
  | 'NOT_FOUND';

export type CoinbaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: CoinbaseFailure; detail?: string; status?: number };

/** Транзакция Onramp в нормализованном виде. */
export interface OnrampTransaction {
  transactionId: string;
  partnerUserRef: string | null;
  state: PaymentState;
  rawStatus: string;

  purchaseCurrency: string | null;
  purchaseNetwork: string | null;
  purchaseAmount: string | null;

  paymentSubtotal: string | null;
  paymentTotal: string | null;
  paymentCurrency: string | null;
  coinbaseFee: string | null;
  networkFee: string | null;

  walletAddress: string | null;
  txHash: string | null;
  /** `ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND` или `..._SEND`. */
  type: string | null;
  typeAllowed: boolean;
}

export interface SessionToken {
  token: string;
  /** Когда токен перестаёт действовать. Хранится только это. */
  expiresAt: Date;
}

interface Money {
  value?: string;
  currency?: string;
}

interface RawTransaction {
  status?: string;
  transaction_id?: string;
  partner_user_ref?: string;
  purchase_currency?: string;
  purchase_network?: string;
  purchase_amount?: Money;
  payment_total?: Money;
  payment_subtotal?: Money;
  coinbase_fee?: Money;
  network_fee?: Money;
  wallet_address?: string;
  tx_hash?: string;
  type?: string;
}

export interface CoinbaseConfig {
  keyId: string;
  keySecret: string;
  mode: 'sandbox' | 'production';
  treasuryAddress: string;
  redirectUrl: string;
}

/** Пустая строка и «0x» — не хеш. Провайдер присылает и то, и другое. */
function realHash(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (v === '' || v === '0x') return null;
  return v;
}

export function coinbaseProvider(config: CoinbaseConfig) {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; retries?: number } = {},
  ): Promise<CoinbaseResult<T>> {
    const attempts = (options.retries ?? 0) + 1;
    let last: CoinbaseResult<T> = { ok: false, failure: 'NETWORK' };

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        // Токен подписывается на конкретный метод и путь: для другого
        // адреса он не годится.
        const jwt = createCdpJwt({
          keyId: config.keyId,
          keySecret: config.keySecret,
          method,
          host: API_HOST,
          path: path.split('?')[0] ?? path,
          nowSeconds: Math.floor(Date.now() / 1000),
        });

        const res = await fetch(`https://${API_HOST}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${jwt}`,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        if (res.status === 404) return { ok: false, failure: 'NOT_FOUND', status: 404 };

        if (!res.ok) {
          // Тело обрезается: в ответах провайдера встречается эхо
          // запроса, а в нём — адрес и сумма.
          const text = await res.text().catch(() => '');
          last = {
            ok: false,
            failure: res.status >= 500 ? 'UNAVAILABLE' : 'REJECTED',
            status: res.status,
            detail: text.slice(0, 160),
          };

          if (last.failure !== 'UNAVAILABLE') return last;
        } else {
          const data = (await res.json().catch(() => null)) as T | null;
          if (data == null) return { ok: false, failure: 'MALFORMED' };
          return { ok: true, value: data };
        }
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        last = {
          ok: false,
          failure: aborted ? 'TIMEOUT' : 'NETWORK',
          detail: e instanceof Error ? e.message.slice(0, 160) : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return last;
  }

  function normalize(raw: RawTransaction): OnrampTransaction | null {
    if (!raw.transaction_id || !raw.status) return null;

    return {
      transactionId: raw.transaction_id,
      partnerUserRef: raw.partner_user_ref ?? null,
      state: fromCoinbaseStatus(raw.status),
      rawStatus: raw.status,

      purchaseCurrency: raw.purchase_currency ?? null,
      purchaseNetwork: raw.purchase_network ?? null,
      purchaseAmount: raw.purchase_amount?.value ?? null,

      paymentSubtotal: raw.payment_subtotal?.value ?? null,
      paymentTotal: raw.payment_total?.value ?? null,
      paymentCurrency: raw.payment_total?.currency ?? raw.payment_subtotal?.currency ?? null,
      coinbaseFee: raw.coinbase_fee?.value ?? null,
      networkFee: raw.network_fee?.value ?? null,

      walletAddress: raw.wallet_address ?? null,
      txHash: realHash(raw.tx_hash),
      type: raw.type ?? null,
      typeAllowed: isAllowedCoinbaseType(raw.type ?? ''),
    };
  }

  return {
    name: 'coinbase' as const,
    enabled: true,
    mode: config.mode,

    /**
     * Одноразовый токен сессии.
     *
     * Адрес доставки, сеть и актив задаются здесь, на сервере.
     * В адресную строку они попадают только как значения по умолчанию
     * для выбора; настоящее ограничение — это токен, который
     * привязывает сессию к нашему адресу.
     *
     * Настоящий IP человека обязателен: по нему провайдер определяет
     * страну и доступные способы оплаты. В песочнице документация
     * разрешает подставлять тестовый адрес.
     */
    async createSessionToken(input: {
      clientIp: string;
      nowMs: number;
    }): Promise<CoinbaseResult<SessionToken>> {
      const res = await call<{ token?: string }>('POST', TOKEN_PATH, {
        body: {
          addresses: [{ address: config.treasuryAddress, blockchains: ['solana'] }],
          assets: ['USDC'],
          clientIp: input.clientIp,
        },
      });

      if (!res.ok) return res;
      if (!res.value.token) return { ok: false, failure: 'MALFORMED' };

      return {
        ok: true,
        value: {
          token: res.value.token,
          // Пять минут по документации. Хранится только срок —
          // сам токен нигде не остаётся.
          expiresAt: new Date(input.nowMs + 5 * 60 * 1000),
        },
      };
    },

    /**
     * Адрес размещённой страницы оплаты.
     *
     * Предзаполненная сумма — удобство, а не защита: интерфейс
     * провайдера позволяет её изменить. Окончательное решение
     * принимает сервер, сверяя завершённую транзакцию.
     */
    hostedUrl(input: {
      token: string;
      partnerUserRef: string;
      fiatAmount: string;
    }): string {
      const base = HOSTED_URL[config.mode];
      const url = new URL(base);

      url.searchParams.set('sessionToken', input.token);
      url.searchParams.set('partnerUserRef', input.partnerUserRef);
      url.searchParams.set('redirectUrl', config.redirectUrl);
      url.searchParams.set('defaultNetwork', 'solana');
      url.searchParams.set('defaultAsset', 'USDC');
      url.searchParams.set('presetFiatAmount', input.fiatAmount);

      return url.toString();
    },

    /**
     * Состояние транзакций по ссылке платежа.
     *
     * Ссылка уникальна на покупку, поэтому список короткий — обычно
     * одна запись. Повторы разрешены: чтение идемпотентно.
     */
    async transactionsByRef(
      partnerUserRef: string,
    ): Promise<CoinbaseResult<OnrampTransaction[]>> {
      const path = `/onramp/v1/buy/user/${encodeURIComponent(partnerUserRef)}/transactions?page_size=10`;
      const res = await call<{ transactions?: RawTransaction[] }>('GET', path, {
        retries: READ_RETRIES,
      });

      if (!res.ok) return res;

      const list = (res.value.transactions ?? [])
        .map(normalize)
        .filter((t): t is OnrampTransaction => t != null);

      return { ok: true, value: list };
    },

    /**
     * Успешная транзакция по ссылке платежа, если она есть.
     *
     * Ищется именно успешная: у одной ссылки может оказаться
     * неудачная попытка и следом удачная, и брать первую попавшуюся
     * значит объявить платёж неуспешным при успешной оплате.
     */
    async successfulTransaction(
      partnerUserRef: string,
    ): Promise<CoinbaseResult<OnrampTransaction | null>> {
      const res = await this.transactionsByRef(partnerUserRef);
      if (!res.ok) return res;

      const success = res.value.find(
        (t) => t.rawStatus === COINBASE_TRANSACTION_STATUS.success,
      );

      return { ok: true, value: success ?? res.value[0] ?? null };
    },
  };
}

export type CoinbaseProvider = ReturnType<typeof coinbaseProvider>;
