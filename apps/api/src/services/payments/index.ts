import { env } from '../../lib/env.js';
import { bridgeProvider } from './bridge.js';
import { coinbaseProvider, type CoinbaseProvider } from './coinbase.js';
import { disabledProvider, type PaymentProviderPort } from './provider.js';

/**
 * Действующий платёжный провайдер.
 *
 * Собирается один раз. Несогласованные настройки сюда не доходят:
 * их отвергает проверка при старте приложения.
 */
let cached: PaymentProviderPort | null = null;

export function getPaymentProvider(): PaymentProviderPort {
  if (cached) return cached;

  cached = env.BRIDGE_PAYMENTS_ENABLED
    ? bridgeProvider({
        apiKey: env.BRIDGE_API_KEY!,
        baseUrl: env.BRIDGE_API_BASE_URL,
        treasuryAddress: env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS!,
      })
    : disabledProvider;

  return cached;
}

/** Подмена провайдера в тестах. Возвращает то, что было. */
export function setPaymentProviderForTests(
  provider: PaymentProviderPort | null,
): PaymentProviderPort | null {
  const previous = cached;
  cached = provider;
  return previous;
}

/**
 * Адрес казначейства.
 *
 * Единственное место, куда уходит выручка за подписки, и единственное
 * значение, с которым сверяется адрес доставки в вебхуке. Из запроса
 * он не приходит никогда: адрес, названный клиентом, — это адрес
 * клиента, а не наш.
 */
export function treasuryAddress(): string | null {
  return env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS ?? null;
}

/**
 * Действующий провайдер оплаты.
 *
 * Выбирается настройкой сервера, а не клиентом. Строка из браузера
 * определяла бы, чьи правила проверки применить к деньгам, — решение,
 * которое пользователю не принадлежит.
 *
 * Одновременно активен ровно один. Оба включённых означали бы два
 * места, куда приходят деньги, и вопрос «какое из них настоящее»
 * при первом расхождении. Исторические платежи другого провайдера
 * при этом продолжают читаться и обрабатываться: выбор касается
 * новых покупок, а не уже начатых.
 */
export type ActiveProvider = 'disabled' | 'bridge' | 'coinbase';

export function activeProvider(): ActiveProvider {
  return env.SUBSCRIPTION_PAYMENT_PROVIDER;
}

let coinbaseCached: CoinbaseProvider | null | undefined;

export function getCoinbase(): CoinbaseProvider | null {
  if (coinbaseCached !== undefined) return coinbaseCached;

  coinbaseCached = env.COINBASE_ONRAMP_ENABLED
    ? coinbaseProvider({
        keyId: env.COINBASE_CDP_API_KEY_ID!,
        keySecret: env.COINBASE_CDP_API_KEY_SECRET!,
        mode: env.COINBASE_ONRAMP_MODE,
        treasuryAddress: env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS!,
        redirectUrl: env.COINBASE_REDIRECT_URL!,
      })
    : null;

  return coinbaseCached;
}

/** Подмена провайдера Coinbase в тестах. */
export function setCoinbaseForTests(provider: CoinbaseProvider | null): void {
  coinbaseCached = provider;
}

/** Работает ли оплата вообще — любым провайдером. */
export function paymentsEnabled(): boolean {
  const active = activeProvider();
  if (active === 'bridge') return getPaymentProvider().enabled;
  if (active === 'coinbase') return getCoinbase() != null;
  return false;
}

export { disabledProvider } from './provider.js';
export type {
  PaymentProviderPort,
  ProviderResult,
  ProviderFailure,
  HostedKycLink,
  ProviderTransfer,
  DepositInstructions,
  CreateKycLinkInput,
  CreateTransferInput,
} from './provider.js';
