import { describe, it, expect } from 'vitest';
import {
  accessIndicatorState,
  accessIndicatorVisible,
  planLabel,
  type AccessIndicatorInput,
  type AccessIndicatorSnapshot,
} from './access-indicator.js';

/**
 * Двенадцать состояний индикатора доступа.
 *
 * Проверяется не оформление, а утверждения: что именно интерфейс
 * говорит человеку о его доступе. Цена ошибки здесь несимметрична —
 * лишний значок никого не задевает, а «Выбрать план» у человека
 * с оплаченным тарифом подрывает доверие ко всему остальному,
 * что мы о нём знаем.
 */

const snapshot = (over: Partial<AccessIndicatorSnapshot> = {}): AccessIndicatorSnapshot => ({
  effectivePlan: 'EXPIRED',
  status: 'expired',
  canStartTrial: true,
  emailVerified: true,
  serviceAccess: false,
  trialRemainingSeconds: 0,
  ...over,
});

const input = (over: Partial<AccessIndicatorInput> = {}): AccessIndicatorInput => ({
  hasSession: true,
  anonymous: false,
  loading: false,
  access: snapshot(),
  ...over,
});

// ─────────────────────────────── 1. Гость ───────────────────────────────────

describe('1. гость', () => {
  it('индикатора нет вовсе', () => {
    const view = accessIndicatorState({
      hasSession: false,
      anonymous: true,
      loading: false,
      access: null,
    });

    expect(view.variant).toBe('hidden');
    expect(accessIndicatorVisible(view)).toBe(false);
  });

  it('гостю не предлагается ни план, ни период', () => {
    const view = accessIndicatorState({
      hasSession: false,
      anonymous: true,
      loading: true,
      access: null,
    });

    // Ни подписи, ни ссылки: у гостя в шапке уже есть «Войти».
    expect(view.label).toBe('');
    expect(view.href).toBeNull();
  });

  it('без сессии загрузка ничего не показывает', () => {
    // Провайдер всё равно сходит на сервер и получит 401. Рисовать
    // на это время место под индикатор значило бы дёргать шапку
    // гостя без всякой пользы.
    const view = accessIndicatorState({
      hasSession: false,
      anonymous: false,
      loading: true,
      access: null,
    });

    expect(view.variant).toBe('hidden');
  });
});

// ───────────────────── Сессия отдельно от ответа сервера ────────────────────

describe('токен есть, ответа ещё нет', () => {
  it('показывается ожидание, а не пустота', () => {
    /*
     * Здесь и был дефект: `anonymous` начинается с `true`, потому что
     * провайдер ещё не спрашивал. Пока индикатор смотрел только
     * на него, вошедший человек при каждой загрузке страницы
     * полсекунды считался гостем — элемент не рисовался, а затем
     * появлялся и сдвигал соседей.
     */
    const view = accessIndicatorState({
      hasSession: true,
      anonymous: true,
      loading: true,
      access: null,
    });

    expect(view.variant).toBe('pending');
  });

  it('после отказа сервера индикатор исчезает', () => {
    // Токен в браузере остался, но сервер его не признал. Показывать
    // состояние доступа нечему: человеку нужен вход.
    const view = accessIndicatorState({
      hasSession: true,
      anonymous: true,
      loading: false,
      access: null,
    });

    expect(view.variant).toBe('hidden');
  });

  it('загрузка и отказ различаются только по loading', () => {
    const during = accessIndicatorState({
      hasSession: true,
      anonymous: true,
      loading: true,
      access: null,
    });
    const after = accessIndicatorState({
      hasSession: true,
      anonymous: true,
      loading: false,
      access: null,
    });

    expect(during.variant).not.toBe(after.variant);
  });
});

// ──────────────────────────── 2. Первая загрузка ────────────────────────────

describe('2. первая загрузка', () => {
  const view = accessIndicatorState(input({ loading: true, anonymous: true, access: null }));

  it('состояние не выдумывается', () => {
    expect(view.variant).toBe('pending');
    expect(view.label).toBe('');
    expect(view.href).toBeNull();
  });

  it('«Выбрать план» не мелькает', () => {
    // Худший вариант: человек с оплаченным тарифом видит долю секунды,
    // что доступа у него нет.
    expect(view.label).not.toBe('Выбрать план');
    expect(view.tone).not.toBe('warn');
  });

  it('место в шапке всё равно занято', () => {
    // Индикатор не скрывается, иначе шапка дёрнется при ответе.
    expect(accessIndicatorVisible(view)).toBe(true);
    expect(view.accessibleLabel).toBeTruthy();
  });
});

// ───────────────────────── 3. Пробный период доступен ───────────────────────

describe('3. пробный период доступен', () => {
  const view = accessIndicatorState(
    input({ access: snapshot({ effectivePlan: 'EXPIRED', canStartTrial: true }) }),
  );

  it('подарок и короткая подпись', () => {
    expect(view.variant).toBe('trial-offer');
    expect(view.icon).toBe('gift');
    expect(view.label).toBe('Бесплатный доступ');
  });

  it('ведёт на страницу доступа, а не включает период', () => {
    expect(view.href).toBe('/access');
    // Единственный пробный период не тратится случайным нажатием
    // в шапке: включение требует явного выбора на своей странице.
    expect(view.href).not.toBe('/plans');
  });

  it('спокойный тон, а не предупреждение', () => {
    expect(view.tone).toBe('accent');
  });
});

// ──────────────────────── 4. Почта ещё не подтверждена ──────────────────────

describe('4. почта ещё не подтверждена', () => {
  const view = accessIndicatorState(
    input({ access: snapshot({ canStartTrial: true, emailVerified: false }) }),
  );

  it('предложение остаётся: подтверждение — шаг, а не отказ', () => {
    expect(view.variant).toBe('trial-offer');
    expect(view.href).toBe('/access');
  });

  it('подсказка честно называет предстоящий шаг', () => {
    // Вести к кнопке, за которой стоит отказ, — худший способ
    // познакомить человека с продуктом.
    expect(view.tooltip).toMatch(/подтвердить почту/i);
  });

  it('в шапке об этом ни слова', () => {
    // Подпись остаётся короткой: длинные предложения в top bar
    // и были исходной проблемой.
    expect(view.label).toBe('Бесплатный доступ');
  });
});

// ────────────────────────── 5. Пробный период идёт ──────────────────────────

describe('5. пробный период активен', () => {
  const view = accessIndicatorState(
    input({
      access: snapshot({
        effectivePlan: 'TRIAL',
        status: 'trial',
        canStartTrial: false,
        trialRemainingSeconds: 4 * 86_400 + 8 * 3_600,
      }),
      trialRemaining: '4 дн 8 ч',
      trialUntil: '30 августа, 11:29',
    }),
  );

  it('часы и остаток времени', () => {
    expect(view.variant).toBe('trial-active');
    expect(view.icon).toBe('clock');
    expect(view.label).toBe('Trial · 4 дн 8 ч');
  });

  it('остаток берётся готовым, а не считается здесь', () => {
    const withoutRemaining = accessIndicatorState(
      input({ access: snapshot({ effectivePlan: 'TRIAL', status: 'trial' }) }),
    );

    // Своего таймера нет: без присланного остатка подпись просто
    // короче, а не выдумывается из часов браузера.
    expect(withoutRemaining.label).toBe('Trial');
  });

  it('дата окончания — в подсказке, а не в подписи', () => {
    expect(view.tooltip).toContain('30 августа');
    expect(view.label).not.toContain('30 августа');
  });

  it('ведёт на тарифы', () => {
    expect(view.href).toBe('/plans');
  });
});

// ───────────────────────── 6. Пробный период закончился ─────────────────────

describe('6. пробный период закончился', () => {
  const view = accessIndicatorState(
    input({ access: snapshot({ effectivePlan: 'EXPIRED', canStartTrial: false }) }),
  );

  it('замок и приглашение выбрать план', () => {
    expect(view.variant).toBe('locked');
    expect(view.icon).toBe('lock');
    expect(view.label).toBe('Выбрать план');
    expect(view.href).toBe('/plans');
  });

  it('единственное место, где уместен предупреждающий тон', () => {
    expect(view.tone).toBe('warn');
  });

  it('без рассказа про закрытый радар и покупки', () => {
    // Это уже написано на `/access` и `/plans`. В шапке — короткая
    // подпись, иначе возвращается та же широкая полоса текста.
    expect(view.label.length).toBeLessThanOrEqual(16);
    expect(view.tooltip.length).toBeLessThanOrEqual(60);
  });
});

// ──────────────────────────── 7–9. Оплаченные планы ─────────────────────────

describe('7. оплаченный PRO', () => {
  const view = accessIndicatorState(
    input({ access: snapshot({ effectivePlan: 'PRO', status: 'active', canStartTrial: false }) }),
  );

  it('показывает настоящее название тарифа', () => {
    expect(view.variant).toBe('paid');
    expect(view.label).toBe('PRO');
    expect(view.icon).toBe('crown');
  });

  it('пробный период не предлагается', () => {
    expect(view.label).not.toMatch(/бесплатн/i);
    expect(view.tooltip).not.toMatch(/бесплатн/i);
  });

  it('даже если сервер почему-то разрешает пробный период', () => {
    // Действующий тариф важнее: предлагать его владельцу бесплатный
    // период значит намекать, что с оплатой что-то не так.
    const odd = accessIndicatorState(
      input({ access: snapshot({ effectivePlan: 'PRO', status: 'active', canStartTrial: true }) }),
    );

    expect(odd.variant).toBe('paid');
  });
});

describe('8. SEMI AUTO', () => {
  it('название читается через пробел, а не через подчёркивание', () => {
    const view = accessIndicatorState(
      input({
        access: snapshot({ effectivePlan: 'SEMI_AUTO', status: 'active', canStartTrial: false }),
      }),
    );

    expect(view.label).toBe('SEMI AUTO');
    expect(view.label).not.toContain('_');
    expect(planLabel('SEMI_AUTO')).toBe('SEMI AUTO');
  });
});

describe('9. FULL AUTO', () => {
  it('название читается через пробел', () => {
    const view = accessIndicatorState(
      input({
        access: snapshot({ effectivePlan: 'FULL_AUTO', status: 'active', canStartTrial: false }),
      }),
    );

    expect(view.label).toBe('FULL AUTO');
    expect(view.accessibleLabel).toBe('Тариф FULL AUTO');
  });
});

// ────────────────────────── 10. Служебный доступ ────────────────────────────

describe('10. служебный доступ', () => {
  const view = accessIndicatorState(
    input({
      // План при служебном доступе может быть любым, включая
      // истёкший: возможности даёт роль, а не тариф.
      access: snapshot({
        effectivePlan: 'EXPIRED',
        status: 'service',
        serviceAccess: true,
        canStartTrial: false,
      }),
    }),
  );

  it('щит и нейтральная подпись', () => {
    expect(view.variant).toBe('service');
    expect(view.icon).toBe('shield');
    expect(view.label).toBe('Service');
    expect(view.tone).toBe('neutral');
  });

  it('покупка не предлагается', () => {
    expect(view.label).not.toBe('Выбрать план');
    expect(view.href).not.toBe('/plans');
  });

  it('подтверждение почты и период не предлагаются', () => {
    expect(view.tooltip).not.toMatch(/почт/i);
    expect(view.tooltip).not.toMatch(/период ещё не использован/i);
  });

  it('служебный доступ важнее истёкшего плана', () => {
    // Проверь мы сначала план — администратор увидел бы замок.
    const withExpiredPlan = accessIndicatorState(
      input({
        access: snapshot({ effectivePlan: 'EXPIRED', serviceAccess: true, canStartTrial: false }),
      }),
    );

    expect(withExpiredPlan.variant).toBe('service');
  });
});

// ──────────────────────── 11. Фоновая перепроверка ──────────────────────────

describe('11. фоновая перепроверка', () => {
  it('состояние остаётся прежним', () => {
    const known = snapshot({ effectivePlan: 'PRO', status: 'active', canStartTrial: false });

    const idle = accessIndicatorState(input({ access: known }));
    // Перепроверка идёт поверх известного состояния: провайдер
    // его не стирает, поэтому и ответ не меняется.
    const during = accessIndicatorState(input({ access: known, loading: false }));

    expect(during).toEqual(idle);
  });

  it('шапка не дёргается: подпись той же длины', () => {
    const known = snapshot({ effectivePlan: 'TRIAL', status: 'trial' });

    const before = accessIndicatorState(input({ access: known, trialRemaining: '4 дн 8 ч' }));
    const after = accessIndicatorState(input({ access: known, trialRemaining: '4 дн 7 ч' }));

    expect(before.label.length).toBe(after.label.length);
  });
});

// ─────────────────── 12. Ошибка API поверх известного состояния ─────────────

describe('12. ошибка API при известном прошлом состоянии', () => {
  it('активный пользователь не становится истёкшим', () => {
    const known = snapshot({ effectivePlan: 'PRO', status: 'active', canStartTrial: false });

    // Провайдер при неудачной перепроверке сохраняет прежний ответ
    // и только выставляет `error`. Индикатор об ошибке не знает
    // и знать не должен: его дело — показать последнее известное.
    const view = accessIndicatorState(input({ access: known, loading: false }));

    expect(view.variant).toBe('paid');
    expect(view.label).toBe('PRO');
  });

  it('пробный период не превращается в замок', () => {
    const known = snapshot({ effectivePlan: 'TRIAL', status: 'trial', canStartTrial: false });

    const view = accessIndicatorState(input({ access: known, trialRemaining: '2 дн 1 ч' }));

    expect(view.variant).toBe('trial-active');
    expect(view.tone).not.toBe('warn');
  });

  it('без известного состояния ошибка даёт неизвестность, а не отказ', () => {
    // `anonymous` остаётся `false`: сервер не сказал «не авторизован»,
    // он вообще ничего не сказал. Это разные вещи, и ответ на них
    // разный — здесь ожидание, а при 401 индикатор исчезает.
    const view = accessIndicatorState(input({ access: null, anonymous: false, loading: false }));

    expect(view.variant).toBe('pending');
    expect(view.href).toBeNull();
  });
});

// ───────────────────────────── Общие правила ────────────────────────────────

describe('тон и длина текстов', () => {
  const all = [
    accessIndicatorState(input({ access: snapshot({ canStartTrial: true }) })),
    accessIndicatorState(input({ access: snapshot({ effectivePlan: 'TRIAL', status: 'trial' }) })),
    accessIndicatorState(input({ access: snapshot({ canStartTrial: false }) })),
    accessIndicatorState(
      input({ access: snapshot({ effectivePlan: 'PRO', status: 'active', canStartTrial: false }) }),
    ),
    accessIndicatorState(input({ access: snapshot({ serviceAccess: true }) })),
  ];

  it('в шапке нет длинных предложений', () => {
    for (const view of all) {
      expect(view.label.length, view.variant).toBeLessThanOrEqual(20);
    }
  });

  it('нет ложной срочности и обещаний прибыли', () => {
    const forbidden = /успей|гарантирован|иксы|заработ|прибыл|осталось всего|последний шанс/i;

    for (const view of all) {
      expect(forbidden.test(view.label), view.variant).toBe(false);
      expect(forbidden.test(view.tooltip), view.variant).toBe(false);
    }
  });

  it('предупреждающий цвет — только у закончившегося доступа', () => {
    const warned = all.filter((v) => v.tone === 'warn');

    expect(warned).toHaveLength(1);
    expect(warned[0]!.variant).toBe('locked');
  });

  it('у каждого видимого состояния есть доступное имя', () => {
    for (const view of all) {
      expect(view.accessibleLabel.length, view.variant).toBeGreaterThan(0);
    }
  });
});
