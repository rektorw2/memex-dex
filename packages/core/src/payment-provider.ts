/**
 * Что умеет платёжный провайдер.
 *
 * Провайдеры не одинаковы, и притворяться, что одинаковы, дороже,
 * чем признать разницу. Bridge выдаёт размещённую проверку личности
 * и банковские реквизиты; Coinbase проводит проверку сам внутри
 * своей страницы и реквизитов не показывает вовсе. Свести это
 * к одному интерфейсу можно только одним способом — заставив
 * Coinbase отвечать «одобрено» на вопрос, которого ему не задавали.
 *
 * Такой ответ был бы ложью с последствиями: интерфейс показал бы
 * «проверка пройдена» человеку, который её не проходил, а сервер
 * пропустил бы его к оплате на основании выдуманного статуса.
 *
 * Поэтому возможности объявляются явно, а интерфейс строится
 * по этому списку — не по имени провайдера. Проверка `provider ===
 * 'COINBASE'` в пяти местах разъезжается при появлении третьего
 * провайдера; список возможностей — нет.
 */

export const PROVIDER_CAPABILITY = {
  /** Размещённая у провайдера проверка личности с отдельными ссылками. */
  hostedKyc: 'hostedKyc',
  /** Банковские реквизиты и сообщение перевода. */
  bankInstructions: 'bankInstructions',
  /** Размещённая страница оплаты, куда уходит человек. */
  hostedCheckout: 'hostedCheckout',
  /** Подписанные события об изменении платежа. */
  webhooks: 'webhooks',
  /** Состояние можно перечитать по запросу. */
  polling: 'polling',
} as const;

export type ProviderCapability =
  (typeof PROVIDER_CAPABILITY)[keyof typeof PROVIDER_CAPABILITY];

/** Коды провайдеров. Совпадают со значениями перечисления в базе. */
export type PaymentProviderCode = 'BRIDGE' | 'COINBASE';

export interface ProviderProfile {
  code: PaymentProviderCode;
  capabilities: readonly ProviderCapability[];
  /**
   * Проводит ли провайдер проверку личности внутри своей страницы.
   *
   * Отдельный признак, а не отсутствие `hostedKyc`. Разница
   * существенная: «проверки нет» и «проверка есть, но мы её
   * не видим» требуют от интерфейса разного, и путать их значит
   * либо обещать человеку лишний шаг, либо умолчать о нужном.
   */
  kycInsideCheckout: boolean;
}

const PROFILES: Readonly<Record<PaymentProviderCode, ProviderProfile>> = {
  BRIDGE: {
    code: 'BRIDGE',
    capabilities: [
      PROVIDER_CAPABILITY.hostedKyc,
      PROVIDER_CAPABILITY.bankInstructions,
      PROVIDER_CAPABILITY.webhooks,
      PROVIDER_CAPABILITY.polling,
    ],
    kycInsideCheckout: false,
  },

  COINBASE: {
    code: 'COINBASE',
    capabilities: [
      PROVIDER_CAPABILITY.hostedCheckout,
      PROVIDER_CAPABILITY.webhooks,
      PROVIDER_CAPABILITY.polling,
    ],
    // Coinbase проверяет человека внутри своей страницы. Документов
    // мы не получаем и не храним — и отдельного состояния «одобрено»
    // у нас не появляется, потому что подтвердить его нечем.
    kycInsideCheckout: true,
  },
};

export function providerProfile(code: PaymentProviderCode): ProviderProfile {
  return PROFILES[code];
}

export function providerHas(
  code: PaymentProviderCode,
  capability: ProviderCapability,
): boolean {
  return PROFILES[code].capabilities.includes(capability);
}

/** Все профили. Порядок устойчивый — для витрины и для тестов. */
export function providerProfiles(): ProviderProfile[] {
  return [PROFILES.BRIDGE, PROFILES.COINBASE];
}

/**
 * Ссылка на платёж для провайдера.
 *
 * Coinbase связывает свои транзакции с нашими по строке, которую мы
 * передаём в адрес страницы оплаты. Строка обязана быть уникальной
 * на каждую покупку — не идентификатором пользователя.
 *
 * Постоянный идентификатор пользователя здесь стоил бы дорого:
 * запрос состояния по нему вернул бы все покупки человека разом,
 * и сопоставить нужную с нужным платежом было бы нечем. Вторая
 * покупка того же плана слилась бы с первой.
 *
 * Персональных данных в строке нет. Она уходит в адресную строку
 * браузера, оседает в истории, в журналах прокси и в отчётах
 * провайдера; адрес почты там появляться не должен.
 */
export const PARTNER_REF_MAX_LENGTH = 49;

const REF_PREFIX = 'mx';

export function isPartnerUserRef(value: string): boolean {
  return (
    value.length <= PARTNER_REF_MAX_LENGTH &&
    value.length >= 8 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Сборка ссылки из случайной части.
 *
 * Случайность передаётся снаружи: генератор случайных чисел —
 * дело вызывающего, а этот модуль остаётся чистым и проверяемым.
 */
export function buildPartnerUserRef(randomPart: string): string {
  const cleaned = randomPart.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  const ref = `${REF_PREFIX}_${cleaned}`;

  if (!isPartnerUserRef(ref)) {
    throw new Error(`buildPartnerUserRef: негодная ссылка длиной ${ref.length}`);
  }

  return ref;
}
