import type { Capability, PlanCode } from './entitlements.js';
import { entitlementFor } from './entitlements.js';
import { pnlView, roiPercent, type PnlView } from './pnl-display.js';

/**
 * Как тарифы показываются человеку.
 *
 * Страница тарифов — единственное место, где продукт говорит о себе
 * обещаниями, и потому единственное, где обещание может разойтись
 * с делом. Разойтись оно может тихо: кто-то добавит в карточку строку
 * «копирование сделок», кто-то через месяц уберёт эту возможность
 * из плана, и узнает об этом человек, уже заплативший.
 *
 * Поэтому каждая выгода привязана к возможности из матрицы прав,
 * а тест проверяет, что план её действительно даёт. Список выгод
 * здесь — это перевод возможностей на человеческий язык, а не второй,
 * независимый набор утверждений.
 *
 * Чего здесь нет и не будет: цен. Они приходят с сервера, из каталога,
 * по которому считают деньги. Число, написанное в интерфейсе руками,
 * рано или поздно перестанет совпадать со списываемым.
 */

/** Планы, которые продаются. Пробный период — способ получить Pro. */
export type SellablePlan = Extract<PlanCode, 'PRO' | 'SEMI_AUTO' | 'FULL_AUTO'>;

export const SELLABLE_PLANS: readonly SellablePlan[] = ['PRO', 'SEMI_AUTO', 'FULL_AUTO'];

/**
 * Одна выгода в карточке.
 *
 * `capability` — не украшение: по нему проверяется, что план
 * действительно даёт обещанное.
 */
export interface PlanBenefit {
  capability: Capability;
  text: string;
}

export interface PlanMarketing {
  plan: SellablePlan;
  title: string;
  /** Одна строка о том, кому это. Не о доходности. */
  tagline: string;
  /** Уровень контроля, который человек выбирает. */
  control: string;
  benefits: readonly PlanBenefit[];
  /** Главное предложение. Ровно одно на всю страницу. */
  featured: boolean;
  /** Возможность ещё не готова. */
  comingSoon: boolean;
}

/**
 * Тексты карточек.
 *
 * Четыре-пять пунктов на карточку, а не весь список прав: человек,
 * выбирающий тариф, сравнивает решения, а не перечни. Полная матрица
 * лежит ниже отдельным сравнением — для тех, кто хочет проверить.
 *
 * Ни одна строка не говорит о прибыли. «Поиск возможностей» — это
 * описание инструмента; «заработок на находках» был бы обещанием,
 * которого мы дать не можем и не имеем права.
 */
export const PLAN_MARKETING: readonly PlanMarketing[] = [
  {
    plan: 'PRO',
    title: 'Pro',
    tagline: 'Полный доступ к анализу и ручной торговле',
    control: 'Решения принимаете вы',
    featured: true,
    comingSoon: false,
    benefits: [
      { capability: 'RADAR_ACCESS', text: 'Поиск возможностей на новых токенах' },
      { capability: 'TERMINAL_ACCESS', text: 'Анализ риска до покупки, а не после' },
      { capability: 'MANUAL_TRADE', text: 'Ручная покупка и продажа' },
      { capability: 'SMART_WALLETS_ACCESS', text: 'Смарт-кошельки: за кем стоит следить' },
      { capability: 'PROTECTIVE_EXIT', text: 'Защитные выходы по вашим правилам' },
    ],
  },
  {
    plan: 'SEMI_AUTO',
    title: 'Semi Auto',
    tagline: 'Всё из Pro плюс сигналы лидеров',
    control: 'Вход подтверждаете вы',
    featured: false,
    comingSoon: true,
    benefits: [
      { capability: 'LEADER_COPY_BUY', text: 'Сигналы кошельков, за которыми вы следите' },
      { capability: 'SEMI_AUTO_TRADE', text: 'Вход по сигналу — с вашим подтверждением' },
      { capability: 'PROTECTIVE_EXIT', text: 'Те же защитные выходы' },
      { capability: 'SMART_WALLETS_ACCESS', text: 'Всё из Pro' },
    ],
  },
  {
    plan: 'FULL_AUTO',
    title: 'Auto',
    tagline: 'Всё из Semi Auto плюс автоматическое исполнение',
    control: 'Решает стратегия, границы задаёте вы',
    featured: false,
    comingSoon: true,
    benefits: [
      { capability: 'AUTO_BUY', text: 'Автоматический вход по заданным условиям' },
      { capability: 'AUTO_EXIT', text: 'Автоматический выход, включая защитный' },
      { capability: 'STRATEGY_AUTOMATION', text: 'Правила стратегии и её границы' },
      { capability: 'SEMI_AUTO_TRADE', text: 'Всё из Semi Auto' },
    ],
  },
];

export function marketingFor(plan: SellablePlan): PlanMarketing {
  return PLAN_MARKETING.find((m) => m.plan === plan)!;
}

// ─────────────────────────── Сравнение планов ────────────────────────────────

/**
 * Строка таблицы сравнения.
 *
 * Значение в ячейке не хранится: оно вычисляется из матрицы прав
 * того плана, о котором спрашивают. Записанная руками таблица —
 * это третий набор утверждений, и он разошёлся бы первым.
 */
export interface ComparisonRow {
  capability: Capability;
  label: string;
  /** Возможность не отбирается никогда. Показывается отдельно. */
  neverRevoked?: boolean;
}

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  { capability: 'RADAR_ACCESS', label: 'Радар находок' },
  { capability: 'TERMINAL_ACCESS', label: 'Разбор токена и оценка риска' },
  { capability: 'SMART_WALLETS_ACCESS', label: 'Смарт-кошельки' },
  { capability: 'MANUAL_TRADE', label: 'Ручная покупка' },
  { capability: 'WALLET_DEPOSIT', label: 'Пополнение кошелька' },
  { capability: 'LEADER_COPY_BUY', label: 'Сигналы лидеров' },
  { capability: 'SEMI_AUTO_TRADE', label: 'Вход по сигналу с подтверждением' },
  { capability: 'AUTO_BUY', label: 'Автоматический вход' },
  { capability: 'AUTO_EXIT', label: 'Автоматический выход' },
  { capability: 'STRATEGY_AUTOMATION', label: 'Правила стратегии' },
  { capability: 'PORTFOLIO_READ', label: 'Свой портфель', neverRevoked: true },
  { capability: 'SELL_OWN_ASSET', label: 'Продажа своих активов', neverRevoked: true },
  { capability: 'WALLET_WITHDRAW', label: 'Вывод средств', neverRevoked: true },
  { capability: 'PROTECTIVE_EXIT', label: 'Защитные выходы', neverRevoked: true },
];

/** Что стоит в ячейке сравнения. */
export type ComparisonCell = 'yes' | 'no' | 'coming-soon';

/**
 * Значение ячейки.
 *
 * `coming-soon` — не «есть» и не «нет», а третье: возможность
 * в плане описана, но продать его сегодня нельзя. Сводить это
 * к галочке значит обещать доступ, которого не будет.
 */
export function comparisonCell(
  plan: SellablePlan,
  capability: Capability,
  capabilitiesByPlan: Readonly<Record<string, readonly string[]>>,
): ComparisonCell {
  const has = (capabilitiesByPlan[plan] ?? []).includes(capability);
  if (!has) return 'no';

  return marketingFor(plan).comingSoon ? 'coming-soon' : 'yes';
}

// ──────────────────────────── Состояние кнопки ───────────────────────────────

/**
 * Что предлагает карточка.
 *
 * Ровно одно действие на карточку. Кнопка, за которой ничего нет,
 * хуже её отсутствия: человек нажимает и решает, что сломался он.
 */
export type PlanCtaKind =
  /** Пробный период доступен — главное действие страницы. */
  | 'start-trial'
  /** Этот план действует прямо сейчас. */
  | 'current'
  /** Можно купить. */
  | 'checkout'
  /** Возможность ещё не готова. */
  | 'coming-soon'
  /** Оплата отключена — честное неактивное состояние. */
  | 'payments-off'
  /** Доступ дан ролью: покупать нечего. */
  | 'service-access'
  /** Нужно войти. */
  | 'sign-in';

export interface PlanCta {
  kind: PlanCtaKind;
  label: string;
  /** Можно ли нажать. */
  enabled: boolean;
  /** Куда ведёт. null — никуда, кнопка неактивна. */
  href: string | null;
}

export interface PlanCtaInput {
  plan: SellablePlan;
  authenticated: boolean;
  /** Действующий план по ответу сервера. */
  currentPlan: PlanCode;
  /** Можно ли ещё начать пробный период. */
  canStartTrial: boolean;
  /** Работает ли оплата хоть каким-то провайдером. */
  paymentsEnabled: boolean;
  /**
   * Доступ выдан ролью, а не тарифом.
   *
   * Администратору покупать нечего: возможности у него полные
   * независимо от плана. Предлагать ему оплату значит показывать,
   * что мы не знаем собственного состояния.
   */
  serviceAccess?: boolean;
}

/**
 * Кнопка карточки.
 *
 * Порядок проверок задаёт приоритет, и он не случаен. «Скоро» идёт
 * первым: пока возможности нет, ни оплата, ни пробный период
 * к ней отношения не имеют. Действующий план — вторым: человеку,
 * у которого доступ уже есть, предлагать его же значит намекать,
 * что с оплатой что-то не так.
 */
export function planCta(input: PlanCtaInput): PlanCta {
  const marketing = marketingFor(input.plan);

  if (marketing.comingSoon) {
    return { kind: 'coming-soon', label: 'Coming soon', enabled: false, href: null };
  }

  // Служебный доступ раньше действующего плана: у администратора
  // план может быть каким угодно, включая EXPIRED, а возможности
  // при этом полные.
  if (input.serviceAccess) {
    return { kind: 'service-access', label: 'Служебный доступ', enabled: false, href: null };
  }

  if (input.currentPlan === input.plan) {
    return { kind: 'current', label: 'Текущий план', enabled: false, href: null };
  }

  // Пробный период — это Pro. Предлагать его на карточке другого
  // плана значит обещать не то, что человек получит.
  if (input.plan === 'PRO' && input.canStartTrial) {
    return {
      kind: 'start-trial',
      label: 'Начать 5 дней бесплатно',
      enabled: true,
      href: input.authenticated ? '/onboarding' : '/login?mode=register',
    };
  }

  if (!input.authenticated) {
    return { kind: 'sign-in', label: 'Войти', enabled: true, href: '/login' };
  }

  if (!input.paymentsEnabled) {
    return { kind: 'payments-off', label: 'Оплата пока не подключена', enabled: false, href: null };
  }

  return {
    kind: 'checkout',
    label: 'Оформить',
    enabled: true,
    href: `/checkout?plan=${input.plan}`,
  };
}

// ────────────────────────────── PnL без догадок ──────────────────────────────

/**
 * Что показывает блок PnL.
 *
 * Пять показателей, и ни одного выдуманного. Неизвестное значение
 * остаётся неизвестным: ноль вместо него — это утверждение, что
 * результат равен нулю, а это другое высказывание.
 *
 * Реализованного PnL здесь нет намеренно. Сервер отдаёт результат
 * только по открытым позициям, а история ограничена последними
 * двумястами сделками — сумма по ней не является реализованным
 * результатом за всё время и выдавать её за таковой нельзя.
 * Появится корректный агрегат — появится и показатель.
 */
export interface PnlCard {
  key: 'value' | 'invested' | 'unrealized' | 'roi' | 'fees';
  label: string;
  /** Готовая строка. null — показать «—» и пояснение. */
  text: string | null;
  /** Знак, если показатель денежный и знак у него есть. */
  sign: -1 | 0 | 1;
  /** Красить ли значение в цвет прибыли или убытка. */
  financial: boolean;
  hint: string;
}

export interface PortfolioSnapshot {
  totalValueUsd?: string | null;
  investedUsd?: string | null;
  unrealizedPnlUsd?: string | null;
  totalFeesPaidUsd?: string | null;
  holdings?: unknown[] | null;
}

/** Строка в число. Пустое и нечисло — это отсутствие значения. */
function num(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;

  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export interface PnlBlock {
  /** Есть ли вообще что показывать. */
  hasPositions: boolean;
  cards: readonly PnlCard[];
  unrealized: PnlView;
}

/**
 * Сборка блока PnL из ответа сервера.
 *
 * Формат чисел приходит из `formatters`: подставлять свой здесь
 * значило бы иметь два способа написать одну и ту же сумму.
 */
export function pnlBlock(
  portfolio: PortfolioSnapshot | null | undefined,
  formatters: {
    usd: (v: number | null) => string;
    signedUsd: (v: number) => string;
  },
  now = Date.now(),
): PnlBlock {
  const invested = num(portfolio?.investedUsd);
  const unrealizedUsd = num(portfolio?.unrealizedPnlUsd);
  const hasPositions = (portfolio?.holdings?.length ?? 0) > 0;

  const unrealized = pnlView({
    valueUsd: hasPositions ? unrealizedUsd : null,
    // Без позиций нереализованному результату неоткуда взяться —
    // это не ноль, а отсутствие предмета разговора.
    isOpen: !hasPositions,
    kind: 'unrealized',
    now,
  });

  const roi = hasPositions ? roiPercent(unrealizedUsd, invested) : null;

  const cards: PnlCard[] = [
    {
      key: 'value',
      label: 'Стоимость портфеля',
      text: num(portfolio?.totalValueUsd) != null ? formatters.usd(num(portfolio?.totalValueUsd)) : null,
      sign: 0,
      financial: false,
      hint: 'Позиции по текущей цене плюс свободные средства',
    },
    {
      key: 'invested',
      label: 'Вложено',
      text: invested != null ? formatters.usd(invested) : null,
      sign: 0,
      financial: false,
      hint: 'Себестоимость открытых позиций',
    },
    {
      key: 'unrealized',
      label: 'Нереализованный PnL',
      text: unrealized.valueUsd != null ? formatters.signedUsd(unrealized.valueUsd) : null,
      sign: unrealized.sign,
      financial: true,
      hint: unrealized.hint,
    },
    {
      key: 'roi',
      label: 'ROI открытых позиций',
      text: roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%` : null,
      sign: roi == null ? 0 : roi > 0 ? 1 : roi < 0 ? -1 : 0,
      financial: true,
      hint: 'Нереализованный результат к себестоимости открытых позиций',
    },
    {
      key: 'fees',
      label: 'Уплаченные комиссии',
      text: num(portfolio?.totalFeesPaidUsd) != null
        ? formatters.usd(num(portfolio?.totalFeesPaidUsd))
        : null,
      sign: 0,
      financial: false,
      hint: 'Комиссия за успех, удержанная при выходе из позиций',
    },
  ];

  return { hasPositions, cards, unrealized };
}

/** Что написать, когда сделок ещё не было. */
export const PNL_EMPTY_TEXT = 'PnL появится после первой бумажной сделки';

/**
 * Срок бесплатного периода словами.
 *
 * Считается из часов, которые прислал сервер, а не пишется числом
 * в разметке: срок задан одной константой в матрице прав, и второе
 * его написание разошлось бы с первым при первой же правке.
 */
export function trialDaysLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '';

  const days = Math.round(hours / 24);

  // Русское склонение: 1 сутки, 2 суток, 5 суток. «Сутки» —
  // существительное только множественного числа, поэтому форма
  // одна на всё, кроме единицы.
  return days === 1 ? '1 сутки' : `${days} суток`;
}

/** Оговорка, без которой цифры читаются как обещание. */
export const PNL_DISCLAIMER =
  'PnL показывает результат стратегии, но не гарантирует будущую прибыль';
