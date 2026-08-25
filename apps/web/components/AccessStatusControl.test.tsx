import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AccessState } from '@/lib/access';

/**
 * Контракт индикатора доступа в верхней панели.
 *
 * Чистая функция состояний проверена в ядре; здесь проверяется
 * другое — что разметка действительно показывает то, что функция
 * вернула, и не делает ничего сверх этого. Между правильным решением
 * и правильным экраном лежит слой, в котором и жили прежние дефекты:
 * предложение войти уже вошедшему, мелькающее «Выбрать план»,
 * ссылка, тратящая единственный пробный период.
 */

// `next/link` вне Next не работает: ему нужен контекст маршрутизатора.
// Подменяем на обычную ссылку — проверяется адрес, а не переход.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const state = vi.hoisted(() => ({
  current: {
    access: null as AccessState | null,
    loading: true,
    revalidating: false,
    coldStart: false,
    anonymous: true,
    hasSession: true,
    error: null as string | null,
  },
}));

vi.mock('@/lib/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/access')>('@/lib/access');

  return {
    ...actual,
    // Провайдер не поднимается: он делает сетевой запрос, а проверяем
    // мы не его, а то, что индикатор рисует по готовому состоянию.
    useAccess: () => ({ ...state.current, reload: async () => {}, can: () => false }),
  };
});

const { AccessStatusControl } = await import('./AccessStatusControl');

const access = (over: Partial<AccessState> = {}): AccessState => ({
  effectivePlan: 'EXPIRED',
  status: 'expired',
  capabilities: [],
  trialStartedAt: null,
  trialExpiresAt: null,
  trialRemainingSeconds: 0,
  canStartTrial: true,
  emailVerified: true,
  serviceAccess: false,
  upgradeRequired: true,
  serverTime: '2026-08-25T11:29:00.000Z',
  ...over,
});

function show(over: Partial<typeof state.current> & { variant?: 'compact' | 'menu' } = {}) {
  const { variant = 'compact', ...access } = over;

  state.current = {
    access: null,
    loading: false,
    revalidating: false,
    coldStart: false,
    anonymous: false,
    // Токен есть: почти во всех проверках речь о вошедшем человеке.
    hasSession: true,
    error: null,
    ...access,
  };

  return render(<AccessStatusControl variant={variant} />);
}

afterEach(cleanup);

// ─────────────────────────────── 1. Гость ───────────────────────────────────

describe('гость', () => {
  it('индикатор не отрисован вовсе', () => {
    const { container } = show({ hasSession: false, anonymous: true, loading: false });

    // Не «скрыт стилем», а отсутствует: у гостя в шапке уже стоят
    // «Регистрация» и «Войти», третий элемент там лишний.
    expect(container.childNodes).toHaveLength(0);
  });

  it('гостю не показывают ни план, ни период даже во время загрузки', () => {
    const { container } = show({ hasSession: false, anonymous: true, loading: true });

    expect(container.textContent).toBe('');
  });
});

// ──────────────────────────── 2. Первая загрузка ────────────────────────────

describe('первая загрузка', () => {
  it('никакого утверждения о доступе', () => {
    show({ loading: true, anonymous: true, access: null });

    expect(screen.queryByText('Выбрать план')).toBeNull();
    expect(screen.queryByText('Бесплатный доступ')).toBeNull();
  });

  it('место занято, чтобы шапка не дёрнулась', () => {
    show({ loading: true, anonymous: true, access: null });

    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('нажимать не на что', () => {
    const { container } = show({ loading: true, anonymous: true, access: null });

    expect(container.querySelector('a')).toBeNull();
  });
});

// ───────────────────────── 3. Пробный период доступен ───────────────────────

describe('пробный период доступен', () => {
  it('короткая подпись и переход на страницу доступа', () => {
    show({ access: access({ canStartTrial: true }) });

    const link = screen.getByRole('link', { name: 'Доступен бесплатный период' });

    expect(link.getAttribute('href')).toBe('/access');
    expect(link.textContent).toContain('Бесплатный доступ');
  });

  it('период не включается нажатием в шапке', () => {
    show({ access: access({ canStartTrial: true }) });

    const link = screen.getByRole('link', { name: 'Доступен бесплатный период' });
    fireEvent.click(link);

    // Ни формы, ни кнопки активации: единственный пробный период
    // не тратится случайным нажатием.
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(link.getAttribute('href')).toBe('/access');
  });
});

// ──────────────────────── 4. Почта ещё не подтверждена ──────────────────────

describe('почта ещё не подтверждена', () => {
  it('предложение остаётся, а шаг назван в подсказке', () => {
    show({ access: access({ canStartTrial: true, emailVerified: false }) });

    const link = screen.getByRole('link', { name: 'Доступен бесплатный период' });

    expect(link.getAttribute('href')).toBe('/access');
    expect(screen.getByRole('tooltip').textContent).toMatch(/подтвердить почту/i);
  });

  it('в самой шапке про почту ни слова', () => {
    show({ access: access({ canStartTrial: true, emailVerified: false }) });

    const link = screen.getByRole('link', { name: 'Доступен бесплатный период' });

    expect(link.textContent).not.toMatch(/почт/i);
  });
});

// ────────────────────────── 5. Пробный период идёт ──────────────────────────

describe('пробный период активен', () => {
  const trial = () =>
    access({
      effectivePlan: 'TRIAL',
      status: 'trial',
      canStartTrial: false,
      trialRemainingSeconds: 4 * 86_400 + 8 * 3_600,
      trialExpiresAt: '2026-08-30T11:29:00.000Z',
    });

  it('остаток времени в подписи', () => {
    show({ access: trial() });

    expect(screen.getByRole('link').textContent).toContain('Trial · 4 дн 8 ч');
  });

  it('ведёт на тарифы', () => {
    show({ access: trial() });

    expect(screen.getByRole('link').getAttribute('href')).toBe('/plans');
  });

  it('дата окончания — в подсказке', () => {
    show({ access: trial() });

    expect(screen.getByRole('tooltip').textContent).toMatch(/Бесплатный период до/);
  });

  it('нет обратного отсчёта по часам браузера', () => {
    // Остаток берётся из секунд, присланных сервером. Своего таймера
    // здесь нет: интервал в шапке создавал бы срочность, которой нет,
    // и расходился бы с сервером при сбитых часах.
    vi.useFakeTimers();
    show({ access: trial() });

    const before = screen.getByRole('link').textContent;
    vi.advanceTimersByTime(3_600_000);

    expect(screen.getByRole('link').textContent).toBe(before);
    vi.useRealTimers();
  });
});

// ───────────────────────── 6. Пробный период закончился ─────────────────────

describe('пробный период закончился', () => {
  it('короткое приглашение выбрать план', () => {
    show({ access: access({ canStartTrial: false }) });

    const link = screen.getByRole('link', { name: 'Доступ закрыт, выберите план' });

    expect(link.textContent).toContain('Выбрать план');
    expect(link.getAttribute('href')).toBe('/plans');
  });

  it('без рассказа про радар и покупки', () => {
    const { container } = show({ access: access({ canStartTrial: false }) });

    // Именно этот текст и висел широкой полосой под шапкой.
    expect(container.textContent).not.toMatch(/радар/i);
    expect(container.textContent).not.toMatch(/вывод средств/i);
  });
});

// ──────────────────────────── 7–9. Оплаченные планы ─────────────────────────

describe('оплаченные планы', () => {
  const paid = (plan: AccessState['effectivePlan']) =>
    access({ effectivePlan: plan, status: 'active', canStartTrial: false, upgradeRequired: false });

  it('PRO показывается как PRO', () => {
    show({ access: paid('PRO') });

    expect(screen.getByRole('link', { name: 'Тариф PRO' }).textContent).toContain('PRO');
  });

  it('SEMI AUTO — через пробел', () => {
    show({ access: paid('SEMI_AUTO') });

    expect(screen.getByRole('link').textContent).toContain('SEMI AUTO');
    expect(screen.getByRole('link').textContent).not.toContain('_');
  });

  it('FULL AUTO — через пробел', () => {
    show({ access: paid('FULL_AUTO') });

    expect(screen.getByRole('link').textContent).toContain('FULL AUTO');
  });

  it('платящему не предлагают пробный период', () => {
    const { container } = show({ access: paid('PRO') });

    expect(container.textContent).not.toMatch(/бесплатн/i);
  });
});

// ────────────────────────── 10. Служебный доступ ────────────────────────────

describe('служебный доступ', () => {
  const service = () =>
    access({ status: 'service', serviceAccess: true, canStartTrial: false });

  it('нейтральная отметка Service', () => {
    show({ access: service() });

    expect(screen.getByRole('link', { name: 'Служебный доступ' }).textContent).toContain('Service');
  });

  it('администратору не предлагают покупку', () => {
    const { container } = show({ access: service() });

    expect(container.textContent).not.toMatch(/выбрать план/i);
    expect(screen.getByRole('link').getAttribute('href')).not.toBe('/plans');
  });

  it('не предлагают ни почту, ни активацию периода', () => {
    const { container } = show({ access: service() });

    expect(container.textContent).not.toMatch(/почт/i);
    expect(container.textContent).not.toMatch(/бесплатн/i);
  });
});

// ──────────────────────── 11. Фоновая перепроверка ──────────────────────────

describe('фоновая перепроверка', () => {
  it('состояние на экране не меняется', () => {
    const known = access({ effectivePlan: 'PRO', status: 'active', canStartTrial: false });

    const { container, rerender } = show({ access: known, revalidating: false });
    const before = container.innerHTML;

    state.current = { ...state.current, revalidating: true };
    rerender(<AccessStatusControl />);

    // Перепроверка идёт поверх известного состояния: интерфейс
    // не схлопывается и не мигает.
    expect(container.innerHTML).toBe(before);
  });
});

// ─────────────────── 12. Ошибка API поверх известного состояния ─────────────

describe('ошибка API при известном прошлом состоянии', () => {
  it('активный пользователь не превращается в истёкшего', () => {
    const known = access({ effectivePlan: 'PRO', status: 'active', canStartTrial: false });

    show({ access: known, error: 'Сервер не ответил вовремя' });

    expect(screen.getByRole('link').textContent).toContain('PRO');
    expect(screen.queryByText('Выбрать план')).toBeNull();
  });

  it('без известного состояния показывается неизвестность, а не отказ', () => {
    show({ access: null, anonymous: false, error: 'Сервер не ответил вовремя', loading: false });

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

// ──────────────────────── Доступность и поведение ───────────────────────────

describe('клавиатура и доступность', () => {
  it('состояние доступно без наведения: aria-label и title', () => {
    show({ access: access({ canStartTrial: false }) });

    const link = screen.getByRole('link');

    // На телефоне наведения нет вовсе, и это единственный способ
    // узнать состояние у значка без подписи.
    expect(link.getAttribute('aria-label')).toBe('Доступ закрыт, выберите план');
    expect(link.getAttribute('title')).toBe('Доступ закрыт, выберите план');
  });

  it('подсказка связана с элементом через aria-describedby', () => {
    show({ access: access({ canStartTrial: false }) });

    const id = screen.getByRole('link').getAttribute('aria-describedby');

    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBeTruthy();
  });

  it('фокус с клавиатуры показывает подсказку', () => {
    show({ access: access({ canStartTrial: false }) });

    const link = screen.getByRole('link');
    fireEvent.focus(link);

    expect(screen.getByRole('tooltip').className).toContain('opacity-100');
  });

  it('Escape снимает подсказку', () => {
    show({ access: access({ canStartTrial: false }) });

    fireEvent.focus(screen.getByRole('link'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('tooltip').className).toContain('opacity-0');
  });

  it('элемент попадает в обход с клавиатуры', () => {
    show({ access: access({ canStartTrial: false }) });

    const link = screen.getByRole('link');

    // Ссылка фокусируема по умолчанию; отрицательный tabindex
    // выкинул бы её из обхода незаметно.
    expect(link.getAttribute('tabindex')).not.toBe('-1');
  });
});

describe('вёрстка в шапке', () => {
  it('подпись видна целиком: пилюля существует только на широком экране', () => {
    show({ access: access({ canStartTrial: false }) });

    const caption = screen.getByText('Выбрать план');

    // Прежде подпись пряталась через `hidden lg:inline`, и в тесной
    // шапке оставался безымянный значок. Теперь на узких экранах
    // пилюли нет вовсе, а состояние живёт строкой в панели меню.
    expect(caption.className).not.toContain('hidden');
    expect(screen.getByRole('link').querySelector('svg')).toBeTruthy();
  });

  it('ничего не переносится и не растягивает шапку', () => {
    show({ access: access({ canStartTrial: false }) });

    expect(screen.getByRole('link').className).toContain('whitespace-nowrap');
  });

  it('пилюля скрыта до 1024 пикселей', () => {
    const { container } = show({ access: access({ canStartTrial: false }) });

    const box = container.firstElementChild!;

    // Тот же порог, что у гамбургера и полной навигации.
    expect(box.className).toContain('hidden');
    expect(box.className).toContain('lg:flex');
  });

  it('движение отключается по системной настройке', () => {
    show({ access: access({ canStartTrial: false }) });

    expect(screen.getByRole('link').className).toContain('motion-reduce:transition-none');
    expect(screen.getByRole('tooltip').className).toContain('motion-reduce:transition-none');
  });
});
