import { fromBridgeState, fromBridgeKycStatus } from '@memex/core';
import type {
  PaymentProviderPort,
  ProviderResult,
  ProviderFailure,
  HostedKycLink,
  ProviderTransfer,
  CreateKycLinkInput,
  CreateTransferInput,
} from './provider.js';

/**
 * Bridge через официальный HTTPS API.
 *
 * Единственное место в проекте, где встречаются поля Bridge. Всё,
 * что выходит отсюда, уже переведено в наши понятия.
 *
 * SDK не используется: нужны четыре вызова, и каждый — обычный
 * `fetch` с заголовком `Api-Key`. Пакет добавил бы зависимость,
 * обновления и свой слой ошибок ради того, что укладывается
 * в этот файл.
 *
 * Ключ живёт только здесь и в переменных окружения. В браузер,
 * в журнал и в ответы API он не попадает никогда — в том числе
 * в тексте ошибки провайдера, поэтому тело ответа обрезается.
 */

const TIMEOUT_MS = 15_000;

/** Сколько раз повторяем. Только для чтения — см. ниже. */
const READ_RETRIES = 2;

interface BridgeKycLinkResponse {
  id?: string;
  kyc_link?: string;
  tos_link?: string;
  kyc_status?: string;
  tos_status?: string;
  customer_id?: string;
}

interface BridgeTransferResponse {
  id?: string;
  state?: string;
  on_behalf_of?: string;
  amount?: string;
  source?: { payment_rail?: string; currency?: string };
  destination?: { payment_rail?: string; currency?: string; to_address?: string };
  source_deposit_instructions?: {
    bank_name?: string;
    bank_account_number?: string;
    bank_routing_number?: string;
    amount?: string;
    currency?: string;
    deposit_message?: string;
  };
  receipt?: {
    initial_amount?: string;
    developer_fee?: string;
    exchange_fee?: string;
    final_amount?: string;
    destination_tx_hash?: string;
    url?: string;
  };
}

function failureFor(status: number): ProviderFailure {
  if (status >= 500) return 'UNAVAILABLE';
  return 'REJECTED';
}

export function bridgeProvider(config: {
  apiKey: string;
  baseUrl: string;
  treasuryAddress: string;
}): PaymentProviderPort {
  /**
   * Один запрос к провайдеру.
   *
   * Повторы разрешены только для чтения и только при сетевых сбоях
   * и пятисотых. Повторить создание перевода нельзя даже с ключом
   * идемпотентности: ключ защищает от второго перевода, но не даёт
   * права считать, что первый не удался, — а именно так выглядит
   * оборванное соединение.
   */
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string; retries?: number } = {},
  ): Promise<ProviderResult<T>> {
    const attempts = (options.retries ?? 0) + 1;
    let last: ProviderResult<T> = { ok: false, failure: 'NETWORK' };

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(`${config.baseUrl}${path}`, {
          method,
          headers: {
            'Api-Key': config.apiKey,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Тело обрезается: в ответах провайдера встречается эхо
          // запроса, а в нём — сумма, адрес и данные клиента.
          const text = await res.text().catch(() => '');
          last = {
            ok: false,
            failure: failureFor(res.status),
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

  function toKycLink(raw: BridgeKycLinkResponse): ProviderResult<HostedKycLink> {
    if (!raw.id || !raw.kyc_link || !raw.tos_link) return { ok: false, failure: 'MALFORMED' };

    return {
      ok: true,
      value: {
        externalKycLinkId: raw.id,
        kycUrl: raw.kyc_link,
        tosUrl: raw.tos_link,
        kycState: fromBridgeKycStatus(raw.kyc_status ?? ''),
        // Согласие считается принятым только по слову провайдера.
        // Возвращение браузера с его страницы доказательством
        // не является: браузер возвращается и по кнопке «назад».
        tosAccepted: raw.tos_status === 'approved',
        externalCustomerId: raw.customer_id ?? null,
      },
    };
  }

  function toTransfer(raw: BridgeTransferResponse): ProviderResult<ProviderTransfer> {
    if (!raw.id || !raw.state) return { ok: false, failure: 'MALFORMED' };

    const ins = raw.source_deposit_instructions;

    return {
      ok: true,
      value: {
        externalTransferId: raw.id,
        state: fromBridgeState(raw.state),
        rawState: raw.state,
        externalCustomerId: raw.on_behalf_of ?? null,

        sourceCurrency: raw.source?.currency ?? null,
        sourceAmount: raw.amount ?? null,
        destinationCurrency: raw.destination?.currency ?? null,
        destinationRail: raw.destination?.payment_rail ?? null,
        destinationAddress: raw.destination?.to_address ?? null,

        instructions: ins
          ? {
              depositMessage: ins.deposit_message ?? null,
              bankName: ins.bank_name ?? null,
              accountNumber: ins.bank_account_number ?? null,
              routingNumber: ins.bank_routing_number ?? null,
              amount: ins.amount ?? null,
              currency: ins.currency ?? null,
            }
          : null,

        deliveredAmount: raw.receipt?.final_amount ?? null,
        providerFee: raw.receipt?.developer_fee ?? null,
        exchangeFee: raw.receipt?.exchange_fee ?? null,
        destinationTxHash: raw.receipt?.destination_tx_hash ?? null,
        receiptUrl: raw.receipt?.url ?? null,
      },
    };
  }

  return {
    name: 'bridge',
    enabled: true,

    async createKycLink(input: CreateKycLinkInput) {
      const res = await call<BridgeKycLinkResponse>('POST', '/kyc_links', {
        idempotencyKey: input.idempotencyKey,
        body: {
          full_name: input.fullName,
          email: input.email,
          type: 'individual',
          ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
        },
      });

      return res.ok ? toKycLink(res.value) : res;
    },

    async getKycLink(id: string) {
      const res = await call<BridgeKycLinkResponse>(
        'GET',
        `/kyc_links/${encodeURIComponent(id)}`,
        { retries: READ_RETRIES },
      );

      return res.ok ? toKycLink(res.value) : res;
    },

    async createTransfer(input: CreateTransferInput) {
      const res = await call<BridgeTransferResponse>('POST', '/transfers', {
        idempotencyKey: input.idempotencyKey,
        body: {
          amount: input.sourceAmount,
          on_behalf_of: input.externalCustomerId,
          // Комиссия разработчика ноль: платформа берёт деньги
          // за подписку, а не за перевод. Сумма, которую человек
          // видит в счёте, и сумма, которую он переводит, совпадают.
          developer_fee: '0.0',
          source: { payment_rail: 'ach_push', currency: 'usd' },
          destination: {
            payment_rail: 'solana',
            currency: 'usdc',
            // Адрес берётся из настроек, а не из запроса. Единственное
            // место, куда уходят деньги за подписку.
            to_address: input.destinationAddress,
          },
        },
      });

      return res.ok ? toTransfer(res.value) : res;
    },

    async getTransfer(id: string) {
      const res = await call<BridgeTransferResponse>(
        'GET',
        `/transfers/${encodeURIComponent(id)}`,
        { retries: READ_RETRIES },
      );

      return res.ok ? toTransfer(res.value) : res;
    },
  };
}
