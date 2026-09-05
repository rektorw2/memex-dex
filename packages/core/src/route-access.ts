import type { Capability, PlanCode } from './entitlements.js';

/**
 * Кто и куда может зайти.
 *
 * Единственная таблица маршрутов на всё приложение. Раньше проверки
 * жили по страницам — где-то `Requires`, где-то ничего, — и вопрос
 * «что видит гость» не имел одного ответа: его приходилось собирать
 * обходом всех файлов, а забытая страница обнаруживалась только
 * тем, что кто-то в неё зашёл.
 *
 * Здесь решается, куда пускать. Что показывать внутри — дело страницы,
 * а можно ли получить данные — дело сервера. Ни одно из трёх
 * не заменяет остальные: скрытая ссылка защитой не является, запрос
 * отправляется и без неё.
 *
 * Правило маршрута — это возможность, а не «есть ли план». Разница
 * существенная. Портфель и вывод средств закрыты возможностями
 * из `NEVER_REVOKED`, поэтому человек с истёкшей подпиской попадает
 * туда по тем же правилам, что и оплативший: его активы принадлежат
 * ему, и запирать их за неоплату нельзя. Проверка «план не EXPIRED»
 * заперла бы.
 */

/** Что требуется от посетителя. */
export type RouteAudience =
  /** Никого не спрашиваем. Рынок публичен. */
  | 'public'
  /** Нужен вход, но не нужен план. */
  | 'authenticated'
  /** Нужна конкретная возможность. */
  | 'capability';

export interface RouteRule {
  /** Совпадение по префиксу пути: `/radar` покрывает и `/radar/alerts`. */
  prefix: string;
  audience: RouteAudience;
  capability?: Capability;
  /** Только для роли администратора. Проверяется отдельно от плана. */
  adminOnly?: boolean;
  /** Куда отправить гостя. По умолчанию — публичная витрина. */
  anonymousTo?: '/' | '/login';
}

/**
 * Таблица маршрутов.
 *
 * Порядок важен: побеждает самое длинное совпадение, а не первое
 * по списку. Иначе `/wallet` перехватывал бы `/wallets`, и раздел
 * смарт-денег открылся бы всем, у кого есть свой кошелёк.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // ─── Публичное ───────────────────────────────────────────────────
  // Первый экран и терминал в режиме просмотра. Рынок — не приватные
  // данные: цена токена одинакова для всех, и прятать её за входом
  // значит требовать регистрацию за то, что человек и так увидит
  // на любом агрегаторе.
  { prefix: '/', audience: 'public' },
  { prefix: '/terminal', audience: 'public' },
  { prefix: '/token', audience: 'public' },
  { prefix: '/login', audience: 'public' },

  // Витрина тарифов. Цены и то, что входит в план, — не приватные
  // данные, а первое, что человек хочет узнать о платном продукте.
  // Страница, которую нельзя посмотреть без аккаунта, требует
  // регистрацию за право узнать стоимость; на этом закрывают вкладку.
  //
  // Приватного здесь нет: блок PnL гостю не показывается и даже
  // не запрашивается, а кнопка ведёт на регистрацию.
  { prefix: '/plans', audience: 'public' },

  // ─── Нужен вход ──────────────────────────────────────────────────
  { prefix: '/onboarding', audience: 'authenticated' },
  { prefix: '/access', audience: 'authenticated' },

  // Оплата — уже не витрина: платить без аккаунта некому и незачем.
  { prefix: '/checkout', audience: 'authenticated' },

  // Продуктовый экран PAPER-агента доступен каждому вошедшему. Для
  // прямой ссылки сохраняем полный next и ведём сразу на форму входа.
  { prefix: '/agent', audience: 'authenticated', anonymousTo: '/login' },

  // ─── Нужна возможность ───────────────────────────────────────────
  { prefix: '/radar', audience: 'capability', capability: 'RADAR_ACCESS' },
  { prefix: '/wallets', audience: 'capability', capability: 'SMART_WALLETS_ACCESS' },
  { prefix: '/copy', audience: 'capability', capability: 'LEADER_COPY_BUY' },

  // Свои активы. Возможности из NEVER_REVOKED — человек с истёкшей
  // подпиской продолжает видеть портфель, продавать и выводить.
  { prefix: '/portfolio', audience: 'capability', capability: 'PORTFOLIO_READ' },
  { prefix: '/wallet', audience: 'capability', capability: 'WALLET_WITHDRAW' },

  // ─── Служебное ───────────────────────────────────────────────────
  { prefix: '/admin', audience: 'authenticated', adminOnly: true },
];

/** Что интерфейс знает о посетителе. Всё — из ответа сервера. */
export interface VisitorState {
  authenticated: boolean;
  isAdmin: boolean;
  capabilities: readonly string[];
}

export type GuardVerdict =
  | { kind: 'allow' }
  /**
   * Отправить в другое место.
   *
   * `next` — адрес, куда человек шёл. Возвращать его туда после входа
   * обязательно: без этого ссылка, присланная в чате, приводит
   * на форму входа и там теряется.
   */
  | {
      kind: 'redirect';
      to: string;
      /** Адрес целиком: путь, параметры запроса и якорь. */
      next: string;
      reason: RedirectReason;
    };

export type RedirectReason =
  /** Не вошёл. */
  | 'anonymous'
  /** Вошёл, но плана нет — нужен онбординг. */
  | 'no-plan'
  /** Вошёл, план есть, но этой возможности он не даёт. */
  | 'insufficient-plan'
  /** Не администратор. */
  | 'not-admin';

/**
 * Правило для пути.
 *
 * Побеждает самое длинное совпадение. Неизвестный путь считается
 * защищённым: забытая страница должна закрыться сама, а не открыться.
 * Умолчание в сторону меньших прав — единственное, которое можно
 * забыть безопасно.
 */
export function ruleFor(path: string): RouteRule {
  const clean = normalize(path);

  let best: RouteRule | null = null;

  for (const rule of ROUTE_RULES) {
    if (!matches(clean, rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }

  return best ?? { prefix: clean, audience: 'authenticated' };
}

function normalize(path: string): string {
  // Отрезаем параметры и якорь: правило определяется путём.
  const withoutQuery = path.split('?')[0]!.split('#')[0]!;
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery || '/';
}

function matches(path: string, prefix: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Пускать или отправлять.
 *
 * Гостя отправляем на первый экран, а не на форму входа: он мог
 * попасть по ссылке и вообще не знать, что это такое. Вошедшего
 * без прав — в онбординг, где он выберет план.
 */
export function guard(path: string, state: VisitorState): GuardVerdict {
  const rule = ruleFor(path);

  /*
   * Возврат сохраняет адрес целиком: путь, параметры и якорь.
   *
   * Правило маршрута определяется одним лишь путём — поэтому
   * `ruleFor` работает с обрезанным значением, — но человек шёл
   * не на путь, а на страницу. `/radar/alerts?filter=new` без фильтра
   * это другой экран: список найденного вместо списка нового,
   * и возвращать туда значит возвращать не туда.
   */
  const next = path;

  if (rule.audience === 'public') return { kind: 'allow' };

  if (!state.authenticated) {
    return { kind: 'redirect', to: rule.anonymousTo ?? '/', next, reason: 'anonymous' };
  }

  if (rule.adminOnly && !state.isAdmin) {
    return { kind: 'redirect', to: '/', next, reason: 'not-admin' };
  }

  if (rule.audience === 'authenticated') return { kind: 'allow' };

  if (rule.capability && state.capabilities.includes(rule.capability)) {
    return { kind: 'allow' };
  }

  return { kind: 'redirect', to: '/onboarding', next, reason: 'insufficient-plan' };
}

/**
 * Годится ли значение как адрес возврата.
 *
 * Принимается только путь внутри приложения. Проверка «начинается
 * с косой черты» одна этого не даёт: `//evil.example/x` тоже
 * начинается с косой черты, но браузер прочитает его как адрес
 * с другим хостом и унаследованной схемой. Это классический открытый
 * редирект — человек нажимает вход у нас, а оказывается на чужой
 * странице, выглядящей как наша, и вводит туда пароль.
 *
 * Обратная косая черта отвергается по той же причине: часть браузеров
 * приводит `/\evil.example` к тому же виду.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;

  // Второй символ решает всё: `//` и `/\` уводят на чужой хост.
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return null;

  // Управляющие символы и пробелы в адресе используются, чтобы
  // проскочить мимо проверок: браузер их выбрасывает, а проверка нет.
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return null;

  return raw;
}

/**
 * Путь внутри приложения — без префикса развёртывания.
 *
 * На GitHub Pages приложение живёт под `/memex-dex`, и роутер сам
 * добавляет этот префикс к каждому переходу. `window.location.pathname`
 * при этом префикс уже содержит. Сложение двух этих фактов давало
 * `/memex-dex/memex-dex/agent`: адрес, куда человек шёл, сохранялся
 * вместе с префиксом, а роутер добавлял его второй раз.
 *
 * Ошибка не косметическая. Человека, которого попросили войти,
 * возвращало на несуществующую страницу — то есть ровно в тот момент,
 * когда он сделал всё правильно.
 *
 * Здесь префикс снимается столько раз, сколько он приписан. Снимать
 * один раз недостаточно: в закладках и в открытых вкладках уже лежат
 * ссылки с двойным префиксом, и они должны продолжать работать.
 *
 * Значение проходит проверку безопасности и до снятия префикса, и
 * после каждого снятия. Промежуточный результат вида `//evil.example`
 * получается из `/memex-dex//evil.example`, и без повторной проверки
 * снятие префикса само стало бы способом обойти защиту.
 */
export function appRelativePath(
  raw: string | null | undefined,
  basePath: string,
): string | null {
  const safe = safeNextPath(raw);
  if (!safe) return null;

  const prefix = normalizedPrefix(basePath);
  if (!prefix) return safe;

  let path = safe;

  /*
   * Цикл, а не одно снятие и не `replaceAll`.
   *
   * `replaceAll` вырезал бы префикс и из середины пути — например,
   * из `/agent/memex-dex/x`, где это часть адреса, а не развёртывания.
   */
  for (;;) {
    const stripped = stripOnce(path, prefix);
    if (stripped === null) break;

    const checked = safeNextPath(stripped);
    if (!checked) return null;
    path = checked;
  }

  return path;
}

/**
 * Снятие одного префикса.
 *
 * `null` означает «префикса нет». Отдельно разобран случай, когда
 * путь равен префиксу целиком: `/memex-dex` — это корень приложения,
 * то есть `/`, а не пустая строка.
 */
function stripOnce(path: string, prefix: string): string | null {
  if (path === prefix) return '/';
  if (!path.startsWith(prefix)) return null;

  const rest = path.slice(prefix.length);
  // Без этой проверки `/memex-dexterity` потерял бы начало и
  // превратился бы в `terity`.
  return rest.startsWith('/') ? rest : null;
}

/** Префикс в виде `/name` без хвостовой косой черты. Пустой — префикса нет. */
function normalizedPrefix(basePath: string): string {
  const trimmed = (basePath ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Адрес назначения с сохранённым возвратом.
 *
 * Собран здесь, а не в трёх местах интерфейса: параметр теряется
 * ровно в том месте, где его собирают руками и однажды забывают.
 */
export function withNext(to: string, next: string | null | undefined): string {
  const safe = safeNextPath(next ?? null);

  // Возвращать на первый экран незачем: человек и так на него идёт.
  if (!safe || safe === '/') return to;

  return `${to}?next=${encodeURIComponent(safe)}`;
}

/**
 * Адрес формы входа с сохранённым возвратом.
 *
 * Собирается здесь по той же причине, что и `withNext`: склейка
 * параметров руками в разметке — это место, где однажды забывают
 * амперсанд, и `next` молча превращается в часть значения `mode`.
 */
export function loginHref(
  next: string | null | undefined,
  options: { register?: boolean } = {},
): string {
  const params = new URLSearchParams();

  const safe = safeNextPath(next ?? null);
  if (safe && safe !== '/') params.set('next', safe);
  if (options.register) params.set('mode', 'register');

  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}

/** Публичен ли путь. Для случаев, когда важен только этот вопрос. */
export function isPublicRoute(path: string): boolean {
  return ruleFor(path).audience === 'public';
}

// ─────────────────────────────── Онбординг ───────────────────────────────────

/**
 * Шаг первого сценария.
 *
 * Считается от серверного состояния, а не от того, что интерфейс
 * помнит о себе сам. Состояние в браузере переживает выход, смену
 * аккаунта и вкладку, открытую вчера, — и каждый из этих случаев
 * даёт человеку чужой или устаревший шаг.
 */
export type OnboardingStep =
  /** Не вошёл. */
  | 'login'
  /**
   * Вошёл, адрес не подтверждён.
   *
   * Первый и единственный обязательный шаг после регистрации.
   * Выбор тарифа до подтверждения не показывается: человеку нечего
   * там решать, пока бесплатный период ещё не начался.
   */
  | 'verify-email'
  /**
   * Подтверждение прошло, период выдаётся.
   *
   * Промежуточное состояние на время ответа сервера. Отдельный шаг,
   * а не спиннер внутри предыдущего: если выдача не удалась, здесь
   * же показывается повтор.
   */
  | 'activate'
  /** Пробный период уже был. Остаются платные планы. */
  | 'plans-only'
  /** Онбординг пройден: план действует. */
  | 'done';

export interface OnboardingState {
  authenticated: boolean;
  plan: PlanCode;
  emailVerified: boolean;
  canStartTrial: boolean;
  /**
   * Идёт ли выдача периода прямо сейчас.
   *
   * Намерение интерфейса, а не состояние сервера: живёт в одной
   * вкладке и до перезагрузки. Потерять его безопасно — шаг
   * пересчитается по ответу сервера.
   */
  activating?: boolean;
  /**
   * Доступ выдан ролью, а не тарифом.
   *
   * Администратору первый сценарий не нужен: возможности у него
   * полные, и вести его выбирать тариф значит показывать, что мы
   * не знаем собственного состояния.
   */
  serviceAccess?: boolean;
}

/**
 * Где человек находится в первом сценарии.
 *
 * Пробный период выдаётся автоматически — в момент подтверждения
 * адреса, и только тогда. Раньше он включался отдельным нажатием,
 * которое не несло решения: отказаться от бесплатного доступа никто
 * не хотел, а часть людей терялась между экранами.
 *
 * «Только тогда» — существенная часть правила. Период привязан
 * к переходу «не подтверждён → подтверждён», а не к состоянию
 * «подтверждён». Иначе в день выкладки его получили бы все
 * существующие пользователи, включая тех, кто уже платит.
 */
export function onboardingStep(state: OnboardingState): OnboardingStep {
  if (!state.authenticated) return 'login';

  // Служебный доступ раньше плана: у администратора план может быть
  // каким угодно, включая EXPIRED, а доступ при этом полный.
  if (state.serviceAccess) return 'done';

  /*
   * Неподтверждённый адрес важнее действующего плана.
   *
   * Такое сочетание возможно у существующего пользователя: план
   * достался ему до того, как подтверждение стало обязательным.
   * Провести его через подтверждение нужно всё равно — но период
   * при этом не выдаётся: он и так с доступом.
   */
  if (!state.emailVerified) return 'verify-email';

  // Действующий план важнее остального: у человека уже есть доступ,
  // и показывать ему выбор тарифа значит намекать, что с оплатой
  // что-то не так.
  if (state.plan !== 'EXPIRED') return 'done';

  // Подтверждение прошло, период ещё выдаётся.
  if (state.activating) return 'activate';

  // Пробный период израсходован. Второй не выдаётся — ни ожиданием,
  // ни повторным подтверждением, ни новым входом.
  return 'plans-only';
}

/**
 * Нужно ли уводить с текущей страницы в онбординг.
 *
 * Отдельно от `guard`, потому что вопрос другой: guard отвечает
 * «пустить ли сюда», а этот — «не пора ли показать первый сценарий».
 * Совмещать их значило бы гонять человека с действующим планом
 * по кругу между приложением и выбором тарифа.
 */
export function needsOnboarding(state: OnboardingState): boolean {
  const step = onboardingStep(state);
  return step === 'verify-email' || step === 'activate';
}

// ───────────────────────── Приватные данные в интерфейсе ─────────────────────

/**
 * Спрашивать ли у сервера приватные данные.
 *
 * Терминал открыт гостю, и портфель — единственное на нём, чего
 * у гостя быть не может. Запрос всё равно вернёт 401, но платить
 * за это ошибкой в консоли, лишним разбором чужого токена на сервере
 * и мельканием пустой панели незачем.
 *
 * Пока права ещё загружаются, тоже не спрашиваем: иначе при обновлении
 * страницы гость успевал бы отправить запрос до того, как выяснится,
 * что он гость.
 */
export function shouldRequestPrivateData(state: {
  authenticated: boolean;
  accessLoading: boolean;
}): boolean {
  return state.authenticated && !state.accessLoading;
}

// ───────────────────────── Тарифы в первом сценарии ──────────────────────────

/**
 * Что показывается на шаге выбора тарифа.
 *
 * Список лежит здесь, а не в разметке, по той же причине, что
 * и матрица прав: он обязан не разойтись с ней. Карточка, обещающая
 * смарт-кошельки на плане, который их не даёт, обнаруживается только
 * тогда, когда человек уже заплатил вниманием.
 *
 * Semi Auto и Auto показаны, но выбрать их нельзя: они не готовы.
 * Показать активную кнопку, за которой ничего нет, хуже, чем честно
 * написать «скоро», — человек нажмёт и решит, что сломался он.
 */
export interface OnboardingPlanCard {
  plan: Exclude<PlanCode, 'EXPIRED' | 'TRIAL'>;
  title: string;
  /** Можно ли выбрать прямо сейчас. */
  available: boolean;
  /** Готовится ли эта возможность. */
  comingSoon: boolean;
}

export const ONBOARDING_PLAN_CARDS: readonly OnboardingPlanCard[] = [
  { plan: 'PRO', title: 'Pro', available: true, comingSoon: false },
  { plan: 'SEMI_AUTO', title: 'Semi Auto', available: false, comingSoon: true },
  { plan: 'FULL_AUTO', title: 'Auto', available: false, comingSoon: true },
];

/**
 * Единственный тариф, который можно выбрать в первом сценарии.
 *
 * И выбирается он как бесплатный период, а не как покупка: кнопок
 * оплаты на этом шаге нет вовсе. Платёжные модули работают и не
 * тронуты, но первый экран после регистрации — не место для карты.
 */
export function selectableOnboardingPlans(): readonly OnboardingPlanCard[] {
  return ONBOARDING_PLAN_CARDS.filter((c) => c.available);
}

// ────────────────────────────── Иксы роста ───────────────────────────────────

/**
 * Во сколько раз выросла цена.
 *
 * Проценты и иксы — одно и то же число, но читаются по-разному.
 * «+300%» требует пересчёта в уме, «4×» не требует, и именно иксами
 * говорят о мем-коинах. Показываем оба: икс отвечает на вопрос
 * «насколько», процент оставляет проверяемость.
 *
 * Формула ровно одна: `1 + change / 100`. Рост на 300% — это цена
 * вчера ×1 плюс ×3 сверху, то есть 4×, а не 3×; ошибка на единицу
 * здесь превращает честное число в завышенное на треть.
 *
 * Возвращает null, когда считать не из чего. Придумать икс при
 * отсутствующем изменении цены значит объявить рост там, где о нём
 * ничего не известно.
 */
export function growthMultiple(rawChangePercent: string | number | null | undefined): number | null {
  if (rawChangePercent == null || rawChangePercent === '') return null;

  const change = typeof rawChangePercent === 'number' ? rawChangePercent : Number(rawChangePercent);
  if (!Number.isFinite(change)) return null;

  const multiple = 1 + change / 100;

  // Ноль и отрицательные иксы бессмысленны: цена не может упасть
  // более чем на 100%, и такое значение означает испорченные данные,
  // а не рекордное падение.
  if (multiple <= 0) return null;

  return multiple;
}

// ──────────────────────── Что показывать в терминале ─────────────────────────

/**
 * Состояние торговой панели.
 *
 * Три положения, и путать их дорого. Раньше признаком был факт входа,
 * и вошедший без действующего плана получал рабочую форму: он
 * заполнял её, отправлял заявку и получал отказ сервера. Ошибка там,
 * где должно было стоять предложение.
 */
export type TradePanelState =
  /** Гость: предложить регистрацию. */
  | 'register'
  /** Вошёл, но плана нет: предложить онбординг. */
  | 'needs-plan'
  /** Можно торговать. */
  | 'trade';

export function tradePanelState(state: {
  authenticated: boolean;
  capabilities: readonly string[];
}): TradePanelState {
  if (!state.authenticated) return 'register';

  // Возможность, а не план: проверка идёт по тому же признаку,
  // по которому откажет сервер.
  return state.capabilities.includes('MANUAL_TRADE') ? 'trade' : 'needs-plan';
}

/**
 * Показывать ли человеку его собственные позиции.
 *
 * Отдельно от торговли и намеренно шире: `PORTFOLIO_READ` входит
 * в `NEVER_REVOKED`, и человек с истёкшей подпиской обязан видеть,
 * что у него есть. Иначе он не сможет это продать — а продавать
 * своё он вправе всегда.
 */
export function canSeeOwnPositions(state: {
  authenticated: boolean;
  capabilities: readonly string[];
}): boolean {
  return state.authenticated && state.capabilities.includes('PORTFOLIO_READ');
}

/**
 * Что показать в карточке лидера роста.
 *
 * Возвращает либо оба значения сразу, либо ничего. Промежуточного
 * состояния «икс не посчитался, но процент покажем» здесь нет
 * намеренно: именно оно однажды и появилось — форматтер отдавал
 * прочерк, а карточка подставляла вместо него процент и объявляла
 * рост там, где считать его было не из чего.
 *
 * Отсутствие данных должно выглядеть отсутствием данных.
 */
export interface GainerDisplay {
  /** «4×» */
  multiple: string;
  /** «+300%» */
  percent: string;
}

export function gainerDisplay(
  rawChangePercent: string | number | null | undefined,
  format: (v: number | null) => string,
): GainerDisplay | null {
  const value = growthMultiple(rawChangePercent);
  if (value == null) return null;

  const change =
    typeof rawChangePercent === 'number' ? rawChangePercent : Number(rawChangePercent);

  const digits = Math.abs(change) >= 100 ? 0 : Math.abs(change) >= 10 ? 1 : 2;

  return {
    multiple: format(value),
    percent: `${change >= 0 ? '+' : ''}${change.toFixed(digits)}%`,
  };
}
