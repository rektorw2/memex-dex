import type { KycState, PaymentState } from '@memex/core';

/**
 * Интерфейс платёжного провайдера.
 *
 * Существует, чтобы всё остальное — оркестрация, маршруты, выдача
 * подписки — не знало ни одного поля Bridge. Провайдера меняют
 * по причинам, к подписке отношения не имеющим: страна, комиссии,
 * лицензия, отказ обслуживать. Если его структуры протекут в базу
 * и в маршруты, замена станет переписыванием половины проекта.
 *
 * Отсюда два правила.
 *
 * **Никакого сквозного прокси.** Здесь перечислены операции,
 * которые проект умеет делать, и ничего сверх. Обобщённый «вызови
 * любой метод Bridge» означал бы, что список возможных действий
 * с деньгами определяется не нами.
 *
 * **Ошибки нормализованы.** Наружу уходит наш код причины, а не
 * текст провайдера: по нему принимают решения, и он не должен
 * меняться вместе с формулировками чужой документации.
 */

export type ProviderFailure =
  /** Модуль выключен настройками. Не сбой, а решение. */
  | 'DISABLED'
  /** Провайдер отверг запрос: неверные данные, лимит, отказ. */
  | 'REJECTED'
  /** Провайдер не ответил вовремя. */
  | 'TIMEOUT'
  /** До провайдера не достучались. */
  | 'NETWORK'
  /** Провайдеру плохо: пятисотые. Повторить можно. */
  | 'UNAVAILABLE'
  /** Ответ есть, но он не той формы. Повторять бессмысленно. */
  | 'MALFORMED';

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ProviderFailure; detail?: string; status?: number };

/** Размещённая у провайдера проверка личности. */
export interface HostedKycLink {
  externalKycLinkId: string;
  kycUrl: string;
  tosUrl: string;
  kycState: KycState;
  tosAccepted: boolean;
  externalCustomerId: string | null;
}

/** Инструкции для перевода фиатных денег. */
export interface DepositInstructions {
  /** Обязательное сообщение перевода. Без него платёж не сопоставят. */
  depositMessage: string | null;
  bankName: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  amount: string | null;
  currency: string | null;
}

/** Перевод у провайдера в нормализованном виде. */
export interface ProviderTransfer {
  externalTransferId: string;
  /** Наше состояние, а не строка провайдера. */
  state: PaymentState;
  /** Сырое состояние — только для журнала и разбора. */
  rawState: string;
  externalCustomerId: string | null;

  sourceCurrency: string | null;
  sourceAmount: string | null;
  destinationCurrency: string | null;
  destinationRail: string | null;
  destinationAddress: string | null;

  instructions: DepositInstructions | null;

  /** Что доставлено по факту. Появляется к завершению. */
  deliveredAmount: string | null;
  providerFee: string | null;
  exchangeFee: string | null;
  destinationTxHash: string | null;
  receiptUrl: string | null;
}

export interface CreateKycLinkInput {
  /** Полное имя. Спрашивается у человека явно, не выводится из почты. */
  fullName: string;
  /** Адрес из записи пользователя. Из тела запроса не читается. */
  email: string;
  idempotencyKey: string;
  redirectUri?: string | undefined;
}

export interface CreateTransferInput {
  /** Идентификатор клиента у провайдера. */
  externalCustomerId: string;
  /** Сумма в исходной валюте. Строка из каталога. */
  sourceAmount: string;
  destinationAddress: string;
  /** Наш ключ идемпотентности. Один платёж — один ключ. */
  idempotencyKey: string;
}

export interface PaymentProviderPort {
  readonly name: 'bridge' | 'fake' | 'disabled';
  readonly enabled: boolean;

  createKycLink(input: CreateKycLinkInput): Promise<ProviderResult<HostedKycLink>>;
  getKycLink(externalKycLinkId: string): Promise<ProviderResult<HostedKycLink>>;

  createTransfer(input: CreateTransferInput): Promise<ProviderResult<ProviderTransfer>>;
  getTransfer(externalTransferId: string): Promise<ProviderResult<ProviderTransfer>>;
}

/**
 * Провайдер, которого нет.
 *
 * Отвечает отказом, а не тишиной. Именно этот отказ доходит
 * до маршрута и превращается в `PAYMENTS_UNAVAILABLE`. Каталог
 * тарифов при этом продолжает работать: посмотреть цены можно
 * и без возможности заплатить.
 */
export const disabledProvider: PaymentProviderPort = {
  name: 'disabled',
  enabled: false,
  async createKycLink() {
    return { ok: false, failure: 'DISABLED' };
  },
  async getKycLink() {
    return { ok: false, failure: 'DISABLED' };
  },
  async createTransfer() {
    return { ok: false, failure: 'DISABLED' };
  },
  async getTransfer() {
    return { ok: false, failure: 'DISABLED' };
  },
};
