import { describe, it, expect } from 'vitest';
import {
  guard,
  safeNextPath,
  withNext,
  loginHref,
  growthMultiple,
  gainerDisplay,
  tradePanelState,
  canSeeOwnPositions,
  shouldRequestPrivateData,
  ONBOARDING_PLAN_CARDS,
  selectableOnboardingPlans,
  ruleFor,
  isPublicRoute,
  onboardingStep,
  needsOnboarding,
  ROUTE_RULES,
  type VisitorState,
  type OnboardingState,
} from './route-access.js';
import { entitlementFor } from './entitlements.js';
import { formatMultiple } from './wallet-confidence.js';

/**
 * Правила доступа маршрутов.
 *
 * Проверяется не то, что нарисовано, а то, куда пускают. Ошибка здесь
 * выглядит одинаково безобидно в обе стороны — лишняя открытая
 * страница и лишняя закрытая отличаются только тем, кто пожалуется, —
 * поэтому каждый маршрут назван поимённо.
 */

const caps = (plan: Parameters<typeof entitlementFor>[0]) => [
  ...entitlementFor(plan).capabilities,
];

const guest: VisitorState = { authenticated: false, isAdmin: false, capabilities: [] };

const expired: VisitorState = {
  authenticated: true,
  isAdmin: false,
  capabilities: caps('EXPIRED'),
};

const trial: VisitorState = {
  authenticated: true,
  isAdmin: false,
  capabilities: caps('TRIAL'),
};

const full: VisitorState = {
  authenticated: true,
  isAdmin: false,
  capabilities: caps('FULL_AUTO'),
};

const admin: VisitorState = { ...full, isAdmin: true };

describe('что открыто гостю', () => {
  it.each(['/', '/terminal', '/token', '/login'])('%s публичен', (path) => {
    expect(isPublicRoute(path)).toBe(true);
    expect(guard(path, guest)).toEqual({ kind: 'allow' });
  });

  it('первый экран открывается гостю первым', () => {
    expect(guard('/', guest).kind).toBe('allow');
  });

  it('терминал открывается гостю в режиме просмотра', () => {
    expect(guard('/terminal', guest).kind).toBe('allow');
    expect(guard('/terminal?token=abc', guest).kind).toBe('allow');
  });

  it.each([
    '/radar',
    '/radar/alerts',
    '/portfolio',
    '/wallet',
    '/wallets',
    '/copy',
    '/calls',
    '/plans',
    '/checkout',
    '/access',
    '/admin',
    '/admin/auto',
    '/onboarding',
  ])('%s гостю закрыт', (path) => {
    const v = guard(path, guest);

    expect(v.kind).toBe('redirect');
    if (v.kind !== 'redirect') return;

    expect(v.reason).toBe('anonymous');
    // Гостя ведём на первый экран, а не на форму входа: он мог прийти
    // по ссылке и вообще не знать, что это за продукт.
    expect(v.to).toBe('/');
  });

  it('сохраняет желаемый адрес целиком, вместе с параметрами и якорем', () => {
    // Правило маршрута определяется путём, но человек шёл не на путь,
    // а на страницу: `/radar/alerts` без `?filter=new` — другой экран,
    // и вернуть туда значит вернуть не туда.
    const v = guard('/radar/alerts?filter=new#top', guest);

    expect(v.kind).toBe('redirect');
    if (v.kind !== 'redirect') return;

    expect(v.next).toBe('/radar/alerts?filter=new#top');
  });

  it('правило при этом по-прежнему определяется одним путём', () => {
    expect(ruleFor('/radar/alerts?filter=new#top').capability).toBe('RADAR_ACCESS');
  });
});

describe('вошедший без плана', () => {
  it('не попадает в радар и смарт-кошельки', () => {
    for (const path of ['/radar', '/wallets', '/copy', '/calls']) {
      const v = guard(path, expired);

      expect(v.kind, path).toBe('redirect');
      if (v.kind !== 'redirect') continue;

      expect(v.to).toBe('/onboarding');
      expect(v.reason).toBe('insufficient-plan');
    }
  });

  it('сохраняет доступ к своим активам', () => {
    // NEVER_REVOKED. Запереть портфель и вывод за неоплату значит
    // удерживать чужие деньги, а не ограничивать доступ.
    expect(guard('/portfolio', expired)).toEqual({ kind: 'allow' });
    expect(guard('/wallet', expired)).toEqual({ kind: 'allow' });
  });

  it('видит тарифы и онбординг', () => {
    expect(guard('/onboarding', expired)).toEqual({ kind: 'allow' });
    expect(guard('/plans', expired)).toEqual({ kind: 'allow' });
    expect(guard('/checkout', expired)).toEqual({ kind: 'allow' });
  });
});

describe('пробный период', () => {
  it('открывает радар и смарт-кошельки', () => {
    expect(guard('/radar', trial)).toEqual({ kind: 'allow' });
    expect(guard('/wallets', trial)).toEqual({ kind: 'allow' });
  });

  it('не открывает копирование', () => {
    expect(guard('/copy', trial).kind).toBe('redirect');
  });
});

describe('администратор', () => {
  it('не попадает в админку без роли, даже с полным планом', () => {
    const v = guard('/admin', full);

    expect(v.kind).toBe('redirect');
    if (v.kind !== 'redirect') return;
    expect(v.reason).toBe('not-admin');
  });

  it('попадает с ролью', () => {
    expect(guard('/admin', admin)).toEqual({ kind: 'allow' });
    expect(guard('/admin/auto', admin)).toEqual({ kind: 'allow' });
  });

  it('роль сама по себе торговых прав не даёт', () => {
    // Роль администратора — обязанности по поддержке, а не деньги.
    const support: VisitorState = {
      authenticated: true,
      isAdmin: true,
      capabilities: caps('EXPIRED'),
    };

    expect(guard('/copy', support).kind).toBe('redirect');
    expect(guard('/radar', support).kind).toBe('redirect');
  });
});

describe('разбор пути', () => {
  it('не путает /wallet и /wallets', () => {
    // Побеждает самое длинное совпадение. Иначе раздел смарт-денег
    // открылся бы всем, у кого есть свой кошелёк.
    expect(ruleFor('/wallet').capability).toBe('WALLET_WITHDRAW');
    expect(ruleFor('/wallets').capability).toBe('SMART_WALLETS_ACCESS');
    expect(ruleFor('/wallets/abc').capability).toBe('SMART_WALLETS_ACCESS');
  });

  it('корень не перехватывает всё подряд', () => {
    expect(ruleFor('/').audience).toBe('public');
    expect(ruleFor('/radar').audience).toBe('capability');
  });

  it('незнакомый путь закрыт', () => {
    // Забытая страница должна закрыться сама. Умолчание в сторону
    // меньших прав — единственное, которое можно забыть безопасно.
    expect(ruleFor('/что-то-новое').audience).toBe('authenticated');
    expect(guard('/что-то-новое', guest).kind).toBe('redirect');
  });

  it('не спотыкается о хвостовой слэш и параметры', () => {
    expect(ruleFor('/terminal/').audience).toBe('public');
    expect(ruleFor('/radar?x=1#y').capability).toBe('RADAR_ACCESS');
  });

  it('у каждого правила с возможностью она указана', () => {
    for (const r of ROUTE_RULES) {
      if (r.audience === 'capability') expect(r.capability, r.prefix).toBeTruthy();
    }
  });
});

// ─────────────────────────────── Онбординг ───────────────────────────────────

const base: OnboardingState = {
  authenticated: true,
  plan: 'EXPIRED',
  emailVerified: false,
  canStartTrial: true,
  choseTrial: false,
};

describe('шаги первого сценария', () => {
  it('гостю — вход', () => {
    expect(onboardingStep({ ...base, authenticated: false })).toBe('login');
  });

  it('после регистрации — выбор тарифа', () => {
    expect(onboardingStep(base)).toBe('choose-plan');
  });

  it('пробный период не начинается сам', () => {
    // Ни регистрация, ни вход, ни открытие первого экрана его
    // не включают: пять суток даются один раз за всё время.
    expect(onboardingStep(base)).not.toBe('activate');
    expect(onboardingStep({ ...base, emailVerified: true })).not.toBe('activate');
  });

  it('после выбора Pro без подтверждённой почты — подтверждение', () => {
    expect(onboardingStep({ ...base, choseTrial: true })).toBe('verify-email');
  });

  it('после подтверждения почты — активация', () => {
    expect(onboardingStep({ ...base, choseTrial: true, emailVerified: true })).toBe('activate');
  });

  it('с подтверждённой почтой выбор Pro сразу ведёт к активации', () => {
    const state = { ...base, emailVerified: true, choseTrial: true };
    expect(onboardingStep(state)).toBe('activate');
  });

  it('с действующим пробным периодом онбординг пройден', () => {
    expect(onboardingStep({ ...base, plan: 'TRIAL', canStartTrial: false })).toBe('done');
  });

  it('платный план имеет приоритет и пропускает онбординг', () => {
    for (const plan of ['PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const) {
      expect(onboardingStep({ ...base, plan, canStartTrial: false })).toBe('done');
      // Даже если пробный период формально ещё доступен.
      expect(onboardingStep({ ...base, plan, canStartTrial: true })).toBe('done');
    }
  });

  it('истёкший пробный период не выдаётся второй раз', () => {
    const used = { ...base, canStartTrial: false, emailVerified: true, choseTrial: true };

    expect(onboardingStep(used)).toBe('plans-only');
    // Ни ожиданием, ни повторным нажатием, ни новым входом.
    expect(onboardingStep({ ...used, choseTrial: false })).toBe('plans-only');
  });

  it('онбординг нужен только тем, кто его не прошёл', () => {
    expect(needsOnboarding(base)).toBe(true);
    expect(needsOnboarding({ ...base, choseTrial: true })).toBe(true);
    expect(needsOnboarding({ ...base, plan: 'TRIAL' })).toBe(false);
    expect(needsOnboarding({ ...base, plan: 'PRO' })).toBe(false);
    expect(needsOnboarding({ ...base, authenticated: false })).toBe(false);
    // Тарифы вместо онбординга: второй пробный период не выдаётся,
    // и держать человека в сценарии, из которого нет выхода, нельзя.
    expect(needsOnboarding({ ...base, canStartTrial: false })).toBe(false);
  });
});

// ───────────────────────── Приватные данные в терминале ──────────────────────

describe('приватные данные', () => {
  it('гость их не запрашивает', () => {
    // Терминал открыт гостю, но портфеля у него быть не может.
    // Запрос вернул бы 401 — платить за это ошибкой в консоли
    // и лишним разбором чужого токена на сервере незачем.
    expect(shouldRequestPrivateData({ authenticated: false, accessLoading: false })).toBe(false);
  });

  it('не запрашиваются, пока права ещё грузятся', () => {
    // Иначе при обновлении страницы гость успевает отправить запрос
    // до того, как выяснится, что он гость.
    expect(shouldRequestPrivateData({ authenticated: false, accessLoading: true })).toBe(false);
    expect(shouldRequestPrivateData({ authenticated: true, accessLoading: true })).toBe(false);
  });

  it('запрашиваются вошедшим', () => {
    expect(shouldRequestPrivateData({ authenticated: true, accessLoading: false })).toBe(true);
  });
});

// ─────────────────────── Тарифы на шаге выбора ───────────────────────────────

describe('тарифы в первом сценарии', () => {
  it('выбрать можно только Pro', () => {
    expect(selectableOnboardingPlans().map((c) => c.plan)).toEqual(['PRO']);
  });

  it('Semi Auto и Auto показаны, но отключены', () => {
    for (const plan of ['SEMI_AUTO', 'FULL_AUTO'] as const) {
      const card = ONBOARDING_PLAN_CARDS.find((c) => c.plan === plan);

      expect(card, `карточка ${plan} должна быть видна`).toBeTruthy();
      expect(card!.available, `${plan} не должен выбираться`).toBe(false);
      expect(card!.comingSoon, `${plan} должен быть помечен как скорый`).toBe(true);
    }
  });

  it('доступное и «скоро» — взаимоисключающие', () => {
    for (const c of ONBOARDING_PLAN_CARDS) {
      expect(c.available && c.comingSoon, c.plan).toBe(false);
    }
  });

  it('пробного периода нет отдельной карточкой', () => {
    // TRIAL — это способ получить Pro, а не отдельный тариф.
    // Отдельная карточка означала бы четвёртый вариант выбора.
    expect(ONBOARDING_PLAN_CARDS.some((c) => (c.plan as string) === 'TRIAL')).toBe(false);
  });

  it('карточки не несут цены и кнопки покупки', () => {
    // Первый экран после регистрации — не место для оплаты.
    // Если в карточке появится цена, это заметит тест, а не человек
    // с картой в руках.
    for (const c of ONBOARDING_PLAN_CARDS) {
      expect(Object.keys(c).sort()).toEqual(['available', 'comingSoon', 'plan', 'title']);
    }
  });
});

// ───────────────────────────── Адрес возврата ────────────────────────────────

describe('адрес возврата', () => {
  it('принимает внутренние пути', () => {
    expect(safeNextPath('/radar')).toBe('/radar');
    expect(safeNextPath('/radar/alerts?filter=new')).toBe('/radar/alerts?filter=new');
    expect(safeNextPath('/')).toBe('/');
  });

  it.each([
    ['//evil.example/x', 'протокол-относительный адрес'],
    ['/\\evil.example', 'обратная косая черта'],
    ['https://evil.example', 'полный адрес'],
    ['http://evil.example', 'полный адрес без tls'],
    ['evil.example', 'без косой черты вовсе'],
    ['javascript:alert(1)', 'схема со скриптом'],
    ['', 'пусто'],
  ])('отвергает %s — %s', (raw) => {
    // Открытый редирект: человек нажимает вход у нас, а оказывается
    // на чужой странице, выглядящей как наша, и вводит туда пароль.
    // Проверки «начинается с косой черты» для этого недостаточно.
    expect(safeNextPath(raw)).toBeNull();
  });

  it('отвергает управляющие символы и пробелы', () => {
    // Браузер их выбрасывает при разборе, а наивная проверка нет —
    // на этой разнице и строят обход.
    expect(safeNextPath('/a\tb')).toBeNull();
    expect(safeNextPath('/a\nb')).toBeNull();
    expect(safeNextPath('/ evil')).toBeNull();
    expect(safeNextPath('/\u0000evil')).toBeNull();
  });

  it('отвергает null и undefined', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe('сборка адреса с возвратом', () => {
  it('добавляет параметр и кодирует его', () => {
    expect(withNext('/login', '/radar/alerts')).toBe('/login?next=%2Fradar%2Falerts');
  });

  it('не добавляет пустой и опасный возврат', () => {
    expect(withNext('/login', null)).toBe('/login');
    expect(withNext('/login', '//evil.example')).toBe('/login');
    expect(withNext('/login', 'https://evil.example')).toBe('/login');
  });

  it('не возвращает на первый экран: человек и так туда идёт', () => {
    expect(withNext('/onboarding', '/')).toBe('/onboarding');
  });

  it('переживает полный круг вместе с параметрами: маршрут → Welcome → вход → онбординг', () => {
    // Цепочка целиком. Параметр теряется ровно в том месте, где его
    // собирают руками, поэтому проверяется каждое звено — и каждое
    // проверяется на адресе с фильтром, а не на голом пути.
    const wanted = '/radar/alerts?filter=new#top';

    // 1. Закрытый маршрут: сторож отправляет гостя на первый экран.
    const verdict = guard(wanted, guest);
    expect(verdict.kind).toBe('redirect');
    if (verdict.kind !== 'redirect') return;
    expect(verdict.next).toBe(wanted);

    // 2. Welcome.
    const toWelcome = withNext(verdict.to, verdict.next);
    const fromWelcome = new URLSearchParams(toWelcome.split('?')[1]).get('next');
    expect(fromWelcome).toBe(wanted);

    // 3. Регистрация.
    const toLogin = loginHref(fromWelcome, { register: true });
    const loginQuery = new URLSearchParams(toLogin.split('?')[1]);
    expect(loginQuery.get('next')).toBe(wanted);
    expect(loginQuery.get('mode')).toBe('register');

    // 4. Онбординг.
    const afterLogin = withNext('/onboarding', loginQuery.get('next'));
    const onboardingQuery = new URLSearchParams(afterLogin.split('?')[1]);
    expect(onboardingQuery.get('next')).toBe(wanted);

    // 5. Исходный адрес — тот же, с чего начали.
    expect(safeNextPath(onboardingQuery.get('next'))).toBe(wanted);
  });

  it('пропускает параметры и якорь через проверку', () => {
    expect(safeNextPath('/radar/alerts?filter=new#top')).toBe('/radar/alerts?filter=new#top');
    expect(safeNextPath('/token?id=abc&chain=SOLANA')).toBe('/token?id=abc&chain=SOLANA');
  });
});

describe('адрес формы входа', () => {
  it('без параметров остаётся коротким', () => {
    expect(loginHref(null)).toBe('/login');
  });

  it('склеивает параметры правильно, а не через строку', () => {
    // Ручная склейка — то место, где однажды забывают амперсанд
    // и `next` становится частью значения `mode`.
    const href = loginHref('/radar', { register: true });

    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('next')).toBe('/radar');
    expect(query.get('mode')).toBe('register');
  });

  it('не проносит чужой хост', () => {
    expect(loginHref('//evil.example', { register: true })).toBe('/login?mode=register');
  });
});

// ─────────────────────────────── Иксы роста ──────────────────────────────────

describe('иксы роста', () => {
  it('считает по формуле 1 + change / 100', () => {
    // Рост на 300% — это 4×, а не 3×: ошибка на единицу завышает
    // число на треть.
    expect(growthMultiple('300')).toBe(4);
    expect(growthMultiple('100')).toBe(2);
    expect(growthMultiple('0')).toBe(1);
    expect(growthMultiple(-50)).toBe(0.5);
  });

  it('ничего не придумывает при отсутствующем значении', () => {
    expect(growthMultiple(null)).toBeNull();
    expect(growthMultiple(undefined)).toBeNull();
    expect(growthMultiple('')).toBeNull();
    expect(growthMultiple('не число')).toBeNull();
    expect(growthMultiple(Number.NaN)).toBeNull();
    expect(growthMultiple(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('отвергает невозможное падение', () => {
    // Цена не может упасть более чем на 100%. Такое значение —
    // испорченные данные, а не рекорд.
    expect(growthMultiple('-100')).toBeNull();
    expect(growthMultiple('-150')).toBeNull();
  });
});

// ─────────────────────────── Торговая панель ─────────────────────────────────

describe('торговая панель', () => {
  it('гостю предлагает регистрацию', () => {
    expect(tradePanelState({ authenticated: false, capabilities: [] })).toBe('register');
  });

  it('вошедшему без плана предлагает онбординг, а не форму', () => {
    // Форма по признаку «вошёл» отправляла заявку, которую сервер
    // отклонял: человек видел ошибку там, где должно было стоять
    // предложение.
    expect(tradePanelState({ authenticated: true, capabilities: caps('EXPIRED') })).toBe(
      'needs-plan',
    );
  });

  it('открывает форму только при MANUAL_TRADE', () => {
    for (const plan of ['TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const) {
      expect(tradePanelState({ authenticated: true, capabilities: caps(plan) }), plan).toBe('trade');
    }
  });

  it('признак — возможность, а не факт входа', () => {
    // Ровно тот же признак, по которому откажет сервер.
    expect(tradePanelState({ authenticated: true, capabilities: ['MANUAL_TRADE'] })).toBe('trade');
    expect(tradePanelState({ authenticated: true, capabilities: ['PORTFOLIO_READ'] })).toBe(
      'needs-plan',
    );
  });
});

describe('свои позиции', () => {
  it('видны вошедшему даже без плана', () => {
    // PORTFOLIO_READ не отбирается: не увидев позиций, человек
    // не сможет их продать, а продавать своё он вправе всегда.
    expect(canSeeOwnPositions({ authenticated: true, capabilities: caps('EXPIRED') })).toBe(true);
  });

  it('не видны гостю', () => {
    expect(canSeeOwnPositions({ authenticated: false, capabilities: caps('EXPIRED') })).toBe(false);
  });

  it('право на просмотр не отбирается ни на одном плане', () => {
    for (const plan of ['EXPIRED', 'TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const) {
      expect(canSeeOwnPositions({ authenticated: true, capabilities: caps(plan) }), plan).toBe(true);
    }
  });
});

// ──────────────────────── Второй путь активации ──────────────────────────────

describe('единственный путь включения периода', () => {
  it('страница доступа отправляет новичка в онбординг', () => {
    // Второй независимый путь обходил явный выбор тарифа: человек
    // включал период, ни разу не увидев, что получает.
    const fresh: OnboardingState = {
      authenticated: true,
      plan: 'EXPIRED',
      emailVerified: false,
      canStartTrial: true,
      choseTrial: false,
    };

    expect(needsOnboarding(fresh)).toBe(true);
  });

  it('не гоняет в онбординг того, у кого период уже идёт', () => {
    expect(needsOnboarding({ ...base, plan: 'TRIAL', canStartTrial: false })).toBe(false);
  });

  it('не гоняет туда и того, кто период уже израсходовал', () => {
    // Держать человека в сценарии, из которого нет выхода, нельзя.
    expect(needsOnboarding({ ...base, canStartTrial: false })).toBe(false);
  });
});

// ─────────────────────── Пункты меню и уведомления ───────────────────────────

describe('видимость пунктов меню', () => {
  it('уведомления скрыты без RADAR_ACCESS', () => {
    // Пункт живёт во второстепенном списке, но решает по нему тот же
    // сторож: отдельная проверка разошлась бы с основной навигацией,
    // и пункт остался бы виден ровно потому, что о нём забыли.
    expect(guard('/radar/alerts', guest).kind).toBe('redirect');
    expect(guard('/radar/alerts', expired).kind).toBe('redirect');
  });

  it('уведомления видны при RADAR_ACCESS', () => {
    expect(guard('/radar/alerts', trial)).toEqual({ kind: 'allow' });
  });

  it('решение по уведомлениям совпадает с решением по радару', () => {
    for (const who of [guest, expired, trial, full]) {
      expect(guard('/radar/alerts', who).kind).toBe(guard('/radar', who).kind);
    }
  });
});

describe('карточка лидера роста', () => {
  const show = (raw: string | number | null | undefined) => gainerDisplay(raw, formatMultiple);

  it('показывает 4× (+300%) при росте втрое', () => {
    expect(show('300')).toEqual({ multiple: '4×', percent: '+300%' });
  });

  it.each([
    // Знаков после запятой тем меньше, чем крупнее число: у роста
    // в двенадцать тысяч процентов десятая доля не значит ничего.
    ['100', '2×', '+100%'],
    ['0', '1×', '+0.00%'],
    ['12500', '126×', '+12500%'],
    ['-50', '0.5×', '-50.0%'],
    ['42.5', '1.4×', '+42.5%'],
  ])('%s → %s (%s)', (raw, multiple, percent) => {
    expect(show(raw)).toEqual({ multiple, percent });
  });

  it.each([
    ['-100', 'падение на всю цену'],
    ['-150', 'падение больше цены'],
    [null, 'значения нет'],
    [undefined, 'поле отсутствует'],
    ['', 'пустая строка'],
    ['не число', 'мусор вместо числа'],
  ])('не показывает ничего при %s — %s', (raw) => {
    // Ни икса, ни процента. Промежуточного «икс не посчитался,
    // но процент покажем» быть не должно: именно так карточка
    // однажды и начала объявлять рост из ничего.
    expect(show(raw as string | null)).toBeNull();
  });

  it('процент без икса невозможен и наоборот', () => {
    // Оба значения приходят вместе или не приходят вовсе.
    for (const raw of ['300', '-100', null, '', 'abc']) {
      const r = show(raw as string | null);
      if (r === null) continue;

      expect(r.multiple).toBeTruthy();
      expect(r.percent).toBeTruthy();
      expect(r.multiple).not.toBe('—');
    }
  });
});
