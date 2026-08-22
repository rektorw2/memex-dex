import type { PlanCode } from './entitlements.js';

/**
 * Каталог платных планов.
 *
 * Единственный источник цены, срока, валюты и сети. Всё, что связано
 * с деньгами за подписку, берётся отсюда и только отсюда: ни клиент,
 * ни платёжный адаптер не имеют права предложить свои значения.
 *
 * Причина простая. Сумма, приходящая от клиента, — это не сведение
 * о цене, а пожелание платящего. Приняв его, платформа продаёт доступ
 * по цене, которую назначил покупатель.
 *
 * Три решения, которые стоит объяснить.
 *
 * **Суммы — строки.** Не `number` и не «пока целые, потом посмотрим».
 * `0.1 + 0.2` в JavaScript не равно `0.3`, и деньги, прошедшие через
 * такое сложение хотя бы раз, перестают сходиться с выпиской. Строка
 * доходит до Bridge и до базы неизменной.
 *
 * **Срок ровно тридцать суток**, а не «месяц». Месяц бывает 28, 29,
 * 30 и 31 день; «месячная подписка» без определения — это спор
 * о трёх днях, который однажды придётся разбирать вручную.
 *
 * **Валюта платежа и валюта цены различаются.** Цена объявлена
 * в USDC, платит человек долларами, конвертирует Bridge. Считать, что
 * доллар всегда равен USDC, нельзя: разница и комиссии видны только
 * в ответе провайдера, и показывать их надо оттуда.
 */

/** Планы, которые можно купить. Пробный и истёкший — не покупки. */
export type PaidPlanCode = Exclude<PlanCode, 'TRIAL' | 'EXPIRED'>;

/** Валюта, в которой объявлена цена. */
export type PriceCurrency = 'USDC';

/** Валюта, которой человек платит. */
export type SourceCurrency = 'USD';

/** Сеть доставки. Ровно одна, и это не случайность — см. treasury. */
export type SettlementChain = 'SOLANA';

export interface SubscriptionPrice {
  /** Строка. Никаких чисел с плавающей точкой в деньгах. */
  amount: string;
  currency: PriceCurrency;
}

export interface CatalogEntry {
  plan: PaidPlanCode;
  price: SubscriptionPrice;
  /** Длительность оплаченного периода. Ровно 30 суток, не «месяц». */
  termDays: number;
  /** Чем платит человек. */
  sourceCurrency: SourceCurrency;
  /** Сумма к переводу в исходной валюте. */
  sourceAmount: string;
  /** Куда приходит результат конвертации. */
  settlementChain: SettlementChain;
}

/** Срок любого оплаченного периода. */
export const SUBSCRIPTION_TERM_DAYS = 30;
export const SUBSCRIPTION_TERM_MS = SUBSCRIPTION_TERM_DAYS * 24 * 60 * 60 * 1000;

/**
 * Объявленные цены.
 *
 * Две цифры после запятой везде: сумма уходит в платёжную систему
 * как есть, и «50» вместо «50.00» — это лишний повод для расхождения
 * при сверке.
 *
 * `sourceAmount` совпадает с ценой по величине, но это разные поля
 * и разные валюты. Совпадение сегодня не означает, что курс равен
 * единице всегда; если однажды разойдётся, менять придётся одно поле,
 * а не смысл каталога.
 */
export const SUBSCRIPTION_CATALOG: Readonly<Record<PaidPlanCode, CatalogEntry>> = {
  PRO: {
    plan: 'PRO',
    price: { amount: '50.00', currency: 'USDC' },
    termDays: SUBSCRIPTION_TERM_DAYS,
    sourceCurrency: 'USD',
    sourceAmount: '50.00',
    settlementChain: 'SOLANA',
  },
  SEMI_AUTO: {
    plan: 'SEMI_AUTO',
    price: { amount: '100.00', currency: 'USDC' },
    termDays: SUBSCRIPTION_TERM_DAYS,
    sourceCurrency: 'USD',
    sourceAmount: '100.00',
    settlementChain: 'SOLANA',
  },
  FULL_AUTO: {
    plan: 'FULL_AUTO',
    price: { amount: '200.00', currency: 'USDC' },
    termDays: SUBSCRIPTION_TERM_DAYS,
    sourceCurrency: 'USD',
    sourceAmount: '200.00',
    settlementChain: 'SOLANA',
  },
};

/** Запись каталога по коду плана. */
export function catalogEntryFor(plan: PaidPlanCode): CatalogEntry {
  return SUBSCRIPTION_CATALOG[plan];
}

/** Цена платного плана. */
export function subscriptionPriceFor(plan: PaidPlanCode): SubscriptionPrice {
  return SUBSCRIPTION_CATALOG[plan].price;
}

/** Покупаемый ли это план. Проверка для строк, пришедших извне. */
export function isPaidPlan(value: string): value is PaidPlanCode {
  return value === 'PRO' || value === 'SEMI_AUTO' || value === 'FULL_AUTO';
}

/** Весь каталог списком. Порядок устойчивый — от дешёвого к дорогому. */
export function catalogList(): CatalogEntry[] {
  return [SUBSCRIPTION_CATALOG.PRO, SUBSCRIPTION_CATALOG.SEMI_AUTO, SUBSCRIPTION_CATALOG.FULL_AUTO];
}

/**
 * Конец оплаченного периода.
 *
 * От момента подтверждённой оплаты, а не от начала суток и не от
 * даты счёта. Тридцать суток по серверным часам UTC.
 */
export function paidPeriodEnd(startsAtMs: number, termDays = SUBSCRIPTION_TERM_DAYS): number {
  return startsAtMs + termDays * 24 * 60 * 60 * 1000;
}

/**
 * Конец периода при продлении.
 *
 * Оплаченное время не сгорает: если подписка ещё действует, тридцать
 * суток прибавляются к её концу, а не к текущему моменту. Иначе
 * человек, заплативший заранее, терял бы остаток — и был бы прав,
 * считая это обманом.
 *
 * Если подписка уже кончилась, отсчёт идёт от «сейчас»: возвращать
 * человеку дни, которыми он не пользовался, платформа не обязана,
 * а начинать период в прошлом бессмысленно.
 */
export function renewalPeriodEnd(
  nowMs: number,
  currentExpiresAtMs: number | null,
  termDays = SUBSCRIPTION_TERM_DAYS,
): number {
  const base = currentExpiresAtMs != null && currentExpiresAtMs > nowMs ? currentExpiresAtMs : nowMs;
  return paidPeriodEnd(base, termDays);
}

/**
 * Сравнение денежных сумм, записанных строками.
 *
 * Нужно там, где приходится сверять сумму из ответа провайдера
 * с суммой из каталога. Приведение к `Number` для этого не годится:
 * «50.00» и «50.000» — одна и та же сумма, а `parseFloat` по дороге
 * теряет точность на больших значениях.
 */
export function sameMoney(a: string, b: string): boolean {
  const norm = (s: string): string | null => {
    const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s.trim());
    if (!m) return null;

    const sign = m[1] === '-' ? '-' : '';
    const whole = (m[2] ?? '').replace(/^0+(?=\d)/, '');
    const frac = (m[3] ?? '').replace(/0+$/, '');

    // Минус ноль — это ноль. Иначе «-0.00» не совпало бы с «0».
    if (whole === '0' && frac === '') return '0';

    return `${sign}${whole}${frac ? `.${frac}` : ''}`;
  };

  const x = norm(a);
  const y = norm(b);

  return x != null && y != null && x === y;
}
