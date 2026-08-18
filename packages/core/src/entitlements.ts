/**
 * Что пользователю разрешено по его плану.
 *
 * Слой намеренно ничего не знает про оплату. План приходит извне
 * уже определённым, а здесь решается единственный вопрос: какие
 * возможности он открывает. Платёжный провайдер появится позже
 * и подключится сбоку — переписывать правила доступа при этом
 * не придётся.
 *
 * Два разделения, которые легко спутать и дорого путать.
 *
 * План — не роль. `ADMIN` и `TRADER` — это роли, они про
 * полномочия внутри системы. `FREE`…`FULL_AUTO` — это подписка,
 * она про оплаченные возможности. Владелец дорогой подписки
 * не становится администратором, а администратор не получает
 * автоторговлю бесплатно: смешать их значит однажды выдать
 * управление платформой тому, кто просто заплатил.
 *
 * Право — не кнопка. Скрытая кнопка не является защитой: запрос
 * можно отправить и без неё. Поэтому проверка обязана выполняться
 * на сервере, а этот модуль существует, чтобы у всех проверок был
 * один источник правды.
 */

/** Технические коды планов. Публичные названия и цены — не здесь. */
export type PlanCode = 'FREE' | 'REALTIME' | 'SEMI_AUTO' | 'FULL_AUTO';

export type Capability =
  | 'RADAR_DELAYED'
  | 'RADAR_REALTIME'
  | 'SMART_WALLETS_DELAYED'
  | 'SMART_WALLETS_REALTIME'
  | 'MANUAL_TRADE'
  | 'LEADER_COPY_BUY'
  | 'AUTOMATED_SIGNAL_BUY'
  | 'AUTOMATED_EXITS'
  | 'REALTIME_NOTIFICATIONS'
  | 'AUTOMATION_SETTINGS';

/**
 * Задержка бесплатного плана.
 *
 * Ровно три минуты, и считается она по серверным часам. Время
 * браузера сюда не попадает никогда: перевести часы на компьютере
 * — самый простой способ получить платные данные бесплатно.
 */
export const FREE_DELAY_SECONDS = 180;

/**
 * Возможности по планам.
 *
 * Составлены накопительно, но записаны явно. Наследование через
 * «всё из предыдущего плюс» экономит четыре строки и стоит того,
 * что однажды новая возможность окажется в бесплатном плане,
 * потому что кто-то добавил её не в тот уровень.
 */
const PLAN_CAPABILITIES: Record<PlanCode, ReadonlySet<Capability>> = {
  FREE: new Set<Capability>(['RADAR_DELAYED', 'SMART_WALLETS_DELAYED']),

  REALTIME: new Set<Capability>([
    'RADAR_REALTIME',
    'SMART_WALLETS_REALTIME',
    'REALTIME_NOTIFICATIONS',
  ]),

  SEMI_AUTO: new Set<Capability>([
    'RADAR_REALTIME',
    'SMART_WALLETS_REALTIME',
    'REALTIME_NOTIFICATIONS',
    'MANUAL_TRADE',
    'LEADER_COPY_BUY',
  ]),

  FULL_AUTO: new Set<Capability>([
    'RADAR_REALTIME',
    'SMART_WALLETS_REALTIME',
    'REALTIME_NOTIFICATIONS',
    'MANUAL_TRADE',
    'LEADER_COPY_BUY',
    'AUTOMATED_SIGNAL_BUY',
    'AUTOMATED_EXITS',
    'AUTOMATION_SETTINGS',
  ]),
};

export interface Entitlement {
  plan: PlanCode;
  capabilities: ReadonlySet<Capability>;
  /** Задержка данных в секундах. Ноль означает отсутствие задержки. */
  delaySeconds: number;
}

/**
 * Состояние подписки.
 *
 * Истёкшая подписка не «почти активна»: она равна бесплатному
 * плану. Отдельного состояния «доживает» нет намеренно — оно
 * превратилось бы в лазейку.
 */
export interface SubscriptionState {
  plan: PlanCode | null;
  /** Когда подписка перестаёт действовать. null — бессрочная. */
  expiresAt: number | null;
  /** Подписка отменена пользователем или платёжной системой. */
  cancelled?: boolean;
}

/**
 * Действующий план.
 *
 * Всё, что не подтверждено активной подпиской, — бесплатный план.
 * Умолчание выбрано в сторону меньших прав: ошибка в эту сторону
 * означает, что кто-то не увидел данные вовремя, ошибка в другую —
 * что автоматика купила токен на чужие деньги.
 */
export function effectivePlan(sub: SubscriptionState | null, now: number): PlanCode {
  if (!sub?.plan) return 'FREE';
  if (sub.cancelled) return 'FREE';
  if (sub.expiresAt != null && sub.expiresAt <= now) return 'FREE';

  return sub.plan;
}

/** Права по плану. */
export function entitlementFor(plan: PlanCode): Entitlement {
  return {
    plan,
    capabilities: PLAN_CAPABILITIES[plan],
    delaySeconds: plan === 'FREE' ? FREE_DELAY_SECONDS : 0,
  };
}

/** Права по состоянию подписки. */
export function entitlementOf(sub: SubscriptionState | null, now: number): Entitlement {
  return entitlementFor(effectivePlan(sub, now));
}

/** Есть ли возможность. Единственный способ спросить. */
export function can(entitlement: Entitlement, capability: Capability): boolean {
  return entitlement.capabilities.has(capability);
}

/**
 * Видит ли пользователь данные без задержки.
 *
 * Отдельная функция, потому что этот вопрос задаётся в десятке
 * мест — в списке, в поиске, в счётчиках, в уведомлениях — и везде
 * ответ должен быть один.
 */
export function isRealtime(entitlement: Entitlement): boolean {
  return entitlement.delaySeconds === 0;
}

// ─────────────────────── Понижение и истечение ──────────────────────────────

/**
 * Что останавливается при понижении плана.
 *
 * Список нужен, чтобы сказать это человеку прямо. Молчаливое
 * отключение автоматики — худший из возможных способов: позиция
 * остаётся открытой, защита перестаёт работать, и узнаёт об этом
 * человек по убытку.
 */
export function stoppedByDowngrade(from: PlanCode, to: PlanCode): Capability[] {
  const before = PLAN_CAPABILITIES[from];
  const after = PLAN_CAPABILITIES[to];

  return [...before].filter((c) => {
    if (after.has(c)) return false;

    // Задержанный доступ, заменённый мгновенным, — не потеря.
    // Это две формы одного и того же права, и при повышении плана
    // одна сменяет другую. Без этой проверки человек, купивший
    // подписку, получал бы сообщение «остановлено: радар».
    const upgraded = SUPERSEDED_BY[c];
    return upgraded == null || !after.has(upgraded);
  });
}

/**
 * Пары «задержанное — мгновенное».
 *
 * Одно право в двух видах, а не два разных: потерять задержанный
 * доступ, получив мгновенный, невозможно.
 */
const SUPERSEDED_BY: Partial<Record<Capability, Capability>> = {
  RADAR_DELAYED: 'RADAR_REALTIME',
  SMART_WALLETS_DELAYED: 'SMART_WALLETS_REALTIME',
};

/**
 * Разрешена ли продажа уже принадлежащего актива.
 *
 * Всегда. Истёкшая подписка не повод запереть человека в позиции:
 * актив принадлежит ему, а не платформе. Автоматика при этом
 * останавливается, но ручной выход остаётся открыт при любом плане.
 */
export function canSellOwnedAsset(): boolean {
  return true;
}

/**
 * Отменяются ли защитные выходы при понижении.
 *
 * Нет. Активный стоп-лосс — это защита уже вложенных денег,
 * а не платная возможность. Снять его молча значит оставить
 * человека без страховки в тот момент, когда он этого не ждёт.
 */
export function cancelsProtectiveExitsOnDowngrade(): boolean {
  return false;
}
