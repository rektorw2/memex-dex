/**
 * Что пользователю разрешено.
 *
 * Слой намеренно ничего не знает про оплату. План приходит извне уже
 * определённым, а здесь решается единственный вопрос: какие возможности
 * он открывает.
 *
 * Три разделения, которые легко спутать и дорого путать.
 *
 * План — не роль. `ADMIN` и `TRADER` — роли, они про полномочия внутри
 * системы. `TRIAL`…`FULL_AUTO` — подписка, она про оплаченные
 * возможности. Администратор не получает автоторговлю за роль:
 * смешать их значит однажды выдать управление деньгами тому, кто
 * просто числится сотрудником.
 *
 * Право — не кнопка. Скрытая кнопка не является защитой: запрос можно
 * отправить и без неё. Проверка обязана выполняться на сервере, а этот
 * модуль существует, чтобы у всех проверок был один источник правды.
 *
 * И главное: **деньги пользователя не заперты никогда.** Окончание
 * пробного периода или подписки закрывает новые покупки и закрытые
 * разделы, но не отбирает у человека доступ к его собственным активам.
 * Продать своё, вывести своё и посмотреть свой баланс можно при любом
 * состоянии договора. Платформа берёт плату за поиск и автоматику,
 * а не за возможность забрать деньги.
 */

/** Технические коды планов. Публичные названия — не здесь. */
export type PlanCode = 'TRIAL' | 'PRO' | 'SEMI_AUTO' | 'FULL_AUTO' | 'EXPIRED';

/*
 * Каталог платных планов переехал в subscription-catalog.ts.
 *
 * Причина не в объёме файла. Цена перестала быть одним числом:
 * к ней добавились срок, валюта платежа, валюта расчёта и сеть
 * доставки, и всё это нужно платёжному контуру целиком. Держать
 * такой набор рядом с матрицей прав значит однажды поправить цену
 * там, где решается, кому что показывать.
 *
 * Имена сохранены — `subscriptionPriceFor` и `PaidPlanCode`
 * реэкспортируются, чтобы обращения к ним не пришлось искать
 * по всему проекту.
 */
export type {
  PaidPlanCode,
  SubscriptionPrice,
  CatalogEntry,
  PriceCurrency,
  SourceCurrency,
  SettlementChain,
} from './subscription-catalog.js';

export {
  SUBSCRIPTION_CATALOG,
  SUBSCRIPTION_TERM_DAYS,
  SUBSCRIPTION_TERM_MS,
  subscriptionPriceFor,
  catalogEntryFor,
  catalogList,
  isPaidPlan,
  paidPeriodEnd,
  renewalPeriodEnd,
  sameMoney,
} from './subscription-catalog.js';

/**
 * Все возможности продукта, перечисленные один раз.
 *
 * Массив, а не только тип-объединение, и это принципиально: тип
 * существует лишь при компиляции, а «все возможности» нужны
 * в рантайме — служебному доступу администратора. Список,
 * записанный там отдельно, разошёлся бы с этим при первом же
 * добавлении, и новая возможность тихо не досталась бы никому.
 *
 * Тип выводится из массива, поэтому добавить одно без другого
 * нельзя: забытая строка здесь — это ошибка компиляции там, где
 * возможность используется.
 */
export const CAPABILITIES = [
  /** Лента находок радара. */
  'RADAR_ACCESS',
  /** Терминал: карточка токена, разбор риска, покупка. */
  'TERMINAL_ACCESS',
  /** Ручная покупка. Продажа собственного актива — отдельное право. */
  'MANUAL_TRADE',
  /** Свой баланс и свои позиции. */
  'PORTFOLIO_READ',
  /** Пополнение торгового кошелька. */
  'WALLET_DEPOSIT',
  /** Вывод средств. */
  'WALLET_WITHDRAW',
  /** Продажа уже принадлежащего актива. */
  'SELL_OWN_ASSET',
  /** Действующие защитные выходы продолжают работать. */
  'PROTECTIVE_EXIT',
  /** Раздел смарт-кошельков. */
  'SMART_WALLETS_ACCESS',
  /** Повторение покупок за лидером. */
  'LEADER_COPY_BUY',
  /** Полуавтомат: вход по сигналу, выход руками. */
  'SEMI_AUTO_TRADE',
  /** Автоматическая покупка без подтверждения. */
  'AUTO_BUY',
  /** Автоматический выход по правилам. */
  'AUTO_EXIT',
  /** Настройка стратегий автоматизации. */
  'STRATEGY_AUTOMATION',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Полный набор.
 *
 * Собирается из того же массива. Единственный законный получатель —
 * служебный доступ администратора; ни один тарифный план сюда
 * не ссылается, иначе новая платная возможность досталась бы
 * бесплатному периоду в день добавления.
 */
export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/**
 * Права, которые не отбираются никогда.
 *
 * Список короткий и он же самый важный в файле. Всё, что здесь
 * перечислено, касается уже принадлежащих человеку денег: посмотреть,
 * продать, вывести, не потерять защиту открытой позиции.
 *
 * Отдельной константой, а не просто повтором в каждом плане, потому
 * что это правило, а не совпадение. Если однажды кто-то соберёт новый
 * план и забудет вписать туда `WALLET_WITHDRAW`, ошибка будет стоить
 * не подписки, а чужих денег.
 */
export const NEVER_REVOKED: readonly Capability[] = [
  'PORTFOLIO_READ',
  'WALLET_WITHDRAW',
  'SELL_OWN_ASSET',
  'PROTECTIVE_EXIT',
];

/**
 * Длительность пробного периода.
 *
 * Ровно пять суток, считая по серверным часам UTC. Время браузера
 * сюда не попадает никогда: перевести часы на своём компьютере —
 * самый простой способ получить бесплатный доступ второй раз.
 */
export const TRIAL_DURATION_MS = 5 * 24 * 60 * 60 * 1000;
export const TRIAL_DURATION_HOURS = 120;

/**
 * Возможности по планам.
 *
 * Записаны накопительно, но явно. Наследование через «всё из
 * предыдущего плюс» экономит несколько строк и стоит того, что
 * однажды платная возможность окажется в пробном периоде, потому что
 * кто-то добавил её не в тот уровень.
 */
const PLAN_CAPABILITIES: Record<PlanCode, ReadonlySet<Capability>> = {
  /**
   * Без плана и после окончания пробного периода.
   *
   * Ровно то, что нельзя отнять. Радар закрыт, терминал не даёт новых
   * покупок, автоматика выключена — но свой актив можно продать,
   * а деньги вывести.
   */
  EXPIRED: new Set<Capability>([...NEVER_REVOKED]),

  /**
   * Пробный период — это бесплатный Pro, а не отдельный урезанный план.
   *
   * Так он и продаётся на первом экране: «Pro — Free trial». Дать
   * под этим названием меньше, чем Pro, значит соврать в подписи
   * кнопки, а человек обнаружит это ровно тогда, когда упрётся
   * в закрытый раздел, за который, как он думал, уже не платит.
   *
   * Поэтому список совпадает с PRO ровно. Разница между ними
   * не в возможностях, а в сроке и в том, что пробный период
   * даётся один раз за всё время.
   *
   * Всё, что действует за человека — копирование и автоматика, —
   * остаётся закрытым: это уровень Semi Auto и Full Auto. Показать
   * автоматическую торговлю бесплатно значит дать чужой машине
   * распоряжаться деньгами до того, как человек решил, доверяет ли
   * он ей.
   */
  TRIAL: new Set<Capability>([
    ...NEVER_REVOKED,
    'RADAR_ACCESS',
    'TERMINAL_ACCESS',
    'MANUAL_TRADE',
    'WALLET_DEPOSIT',
    'SMART_WALLETS_ACCESS',
  ]),

  PRO: new Set<Capability>([
    ...NEVER_REVOKED,
    'RADAR_ACCESS',
    'TERMINAL_ACCESS',
    'MANUAL_TRADE',
    'WALLET_DEPOSIT',
    'SMART_WALLETS_ACCESS',
  ]),

  SEMI_AUTO: new Set<Capability>([
    ...NEVER_REVOKED,
    'RADAR_ACCESS',
    'TERMINAL_ACCESS',
    'MANUAL_TRADE',
    'WALLET_DEPOSIT',
    'SMART_WALLETS_ACCESS',
    'LEADER_COPY_BUY',
    'SEMI_AUTO_TRADE',
  ]),

  FULL_AUTO: new Set<Capability>([
    ...NEVER_REVOKED,
    'RADAR_ACCESS',
    'TERMINAL_ACCESS',
    'MANUAL_TRADE',
    'WALLET_DEPOSIT',
    'SMART_WALLETS_ACCESS',
    'LEADER_COPY_BUY',
    'SEMI_AUTO_TRADE',
    'AUTO_BUY',
    'AUTO_EXIT',
    'STRATEGY_AUTOMATION',
  ]),
};

export interface Entitlement {
  plan: PlanCode;
  capabilities: ReadonlySet<Capability>;
}

/**
 * Старшинство планов.
 *
 * Нужно ровно для одного: если у человека есть и действующая оплата,
 * и незакончившийся пробный период, действует оплата. Обратный порядок
 * означал бы, что купивший подписку в первый день теряет часть
 * возможностей до конца пробного периода.
 */
const PLAN_RANK: Record<PlanCode, number> = {
  EXPIRED: 0,
  TRIAL: 1,
  PRO: 2,
  SEMI_AUTO: 3,
  FULL_AUTO: 4,
};

export function planRank(plan: PlanCode): number {
  return PLAN_RANK[plan];
}

/** Состояние оплаченной подписки. Пробный период сюда не входит. */
export interface SubscriptionState {
  plan: Exclude<PlanCode, 'TRIAL' | 'EXPIRED'> | null;
  /** Когда права начинаются. Договор из будущего прав не даёт. */
  startsAt?: number | null;
  /** Когда права заканчиваются. null — бессрочно. */
  expiresAt: number | null;
  cancelled?: boolean;
}

/** Состояние пробного периода. */
export interface TrialState {
  startedAt: number;
  expiresAt: number;
}

/** Действует ли пробный период прямо сейчас. */
export function isTrialActive(trial: TrialState | null | undefined, now: number): boolean {
  if (!trial) return false;
  return trial.startedAt <= now && now < trial.expiresAt;
}

/** Сколько секунд осталось. Ноль, если период кончился или не начинался. */
export function trialRemainingSeconds(
  trial: TrialState | null | undefined,
  now: number,
): number {
  if (!isTrialActive(trial, now)) return 0;
  return Math.max(0, Math.ceil((trial!.expiresAt - now) / 1000));
}

/** Конец пробного периода по его началу. */
export function trialExpiresAt(startedAtMs: number): number {
  return startedAtMs + TRIAL_DURATION_MS;
}

/** Действует ли оплаченная подписка. */
export function isSubscriptionActive(
  sub: SubscriptionState | null | undefined,
  now: number,
): boolean {
  if (!sub?.plan) return false;
  if (sub.cancelled) return false;
  if (sub.startsAt != null && sub.startsAt > now) return false;
  if (sub.expiresAt != null && sub.expiresAt <= now) return false;

  return true;
}

/**
 * Действующий план.
 *
 * Порядок разбора и есть правило приоритета: сначала оплата, потом
 * пробный период, потом ничего. Умолчание выбрано в сторону меньших
 * прав — ошибка в эту сторону означает, что кто-то не увидел радар,
 * ошибка в другую означает, что автоматика купила токен на чужие деньги.
 */
export function effectivePlan(
  input: { subscription?: SubscriptionState | null; trial?: TrialState | null },
  now: number,
): PlanCode {
  const paid = isSubscriptionActive(input.subscription, now)
    ? (input.subscription!.plan as PlanCode)
    : null;

  const trial = isTrialActive(input.trial, now) ? ('TRIAL' as PlanCode) : null;

  if (paid && trial) return planRank(paid) >= planRank(trial) ? paid : trial;

  return paid ?? trial ?? 'EXPIRED';
}

/** Права по плану. */
export function entitlementFor(plan: PlanCode): Entitlement {
  return { plan, capabilities: PLAN_CAPABILITIES[plan] };
}

/** Права по состоянию договоров. */
export function entitlementOf(
  input: { subscription?: SubscriptionState | null; trial?: TrialState | null },
  now: number,
): Entitlement {
  return entitlementFor(effectivePlan(input, now));
}

/** Есть ли возможность. Единственный способ спросить. */
export function can(entitlement: Entitlement, capability: Capability): boolean {
  return entitlement.capabilities.has(capability);
}

/** Список возможностей для ответа клиенту. Порядок устойчивый. */
export function capabilityList(entitlement: Entitlement): Capability[] {
  return [...entitlement.capabilities].sort();
}

/**
 * Какой план нужен, чтобы получить эту возможность.
 *
 * Возвращается самый дешёвый подходящий. Нужно, чтобы отказ был
 * полезным: «нужен PRO» помогает, «доступ запрещён» — нет.
 */
export function requiredPlanFor(capability: Capability): PlanCode | null {
  const order: PlanCode[] = ['EXPIRED', 'TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'];

  for (const plan of order) {
    if (PLAN_CAPABILITIES[plan].has(capability)) return plan;
  }

  return null;
}

/**
 * Что перестанет работать при переходе на другой план.
 *
 * Список нужен, чтобы сказать это человеку прямо. Молчаливое
 * отключение автоматики — худший из возможных способов: позиция
 * остаётся открытой, защита перестаёт работать, и узнаёт об этом
 * человек по убытку.
 */
export function stoppedByDowngrade(from: PlanCode, to: PlanCode): Capability[] {
  const before = PLAN_CAPABILITIES[from];
  const after = PLAN_CAPABILITIES[to];

  return [...before].filter((c) => !after.has(c)).sort();
}

/**
 * Разрешена ли продажа уже принадлежащего актива.
 *
 * Всегда. Истёкшая подписка не повод запереть человека в позиции:
 * актив принадлежит ему, а не платформе.
 */
export function canSellOwnedAsset(): boolean {
  return true;
}

/** Разрешён ли вывод средств. Всегда, по той же причине. */
export function canWithdraw(): boolean {
  return true;
}

/**
 * Отменяются ли защитные выходы при понижении плана.
 *
 * Нет. Действующий стоп-лосс — это защита уже вложенных денег,
 * а не платная возможность. Снять его молча значит оставить человека
 * без страховки ровно тогда, когда он этого не ждёт.
 */
export function cancelsProtectiveExitsOnDowngrade(): boolean {
  return false;
}
