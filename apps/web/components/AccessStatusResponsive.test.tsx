import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { accessIndicatorState } from '@memex/core';
import type { AccessState } from '@/lib/access';

/**
 * Адаптивное поведение индикатора доступа.
 *
 * Ниже 1024 пикселей верхняя панель отдана логотипу, гамбургеру
 * и аккаунту; индикатор переезжает в выдвижную панель. Проверяется
 * не то, как это выглядит, а два утверждения, которые легко нарушить
 * незаметно: что оба представления показывают одно и то же состояние
 * и что порог у навигации и у индикатора один.
 *
 * Про ширины отдельно. `jsdom` не считает раскладку, поэтому здесь
 * проверяются классы, а не пиксели. Это честная граница возможностей
 * такого теста: он ловит рассогласование порогов — самую частую
 * причину того, что на планшете видно и гамбургер, и полное меню, —
 * но не заменяет взгляд на настоящий экран.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const nav = vi.hoisted(() => ({ pathname: '/terminal' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const state = vi.hoisted(() => ({
  current: {
    access: null as AccessState | null,
    loading: false,
    revalidating: false,
    coldStart: false,
    anonymous: false,
    hasSession: true,
    error: null as string | null,
  },
}));

vi.mock('@/lib/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/access')>('@/lib/access');

  return {
    ...actual,
    useAccess: () => ({ ...state.current, reload: async () => {}, can: () => false }),
  };
});

// Видимость разделов решает сторож прав; здесь важен не он,
// а то, что строка состояния стоит до списка и вне его.
vi.mock('@/lib/sections', () => ({
  useVisibleSections: (list: readonly { href: string; label: string }[]) => list,
}));

const { AccessStatusControl } = await import('./AccessStatusControl');
const { MobileNav } = await import('./MobileNav');
const { MainNav } = await import('./MainNav');

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

function setAccess(over: Partial<typeof state.current> = {}) {
  state.current = {
    access: null,
    loading: false,
    revalidating: false,
    coldStart: false,
    anonymous: false,
    hasSession: true,
    error: null,
    ...over,
  };
}

/** Панель меню как объект для поиска внутри неё. */
function openMenu() {
  const view = render(<MobileNav />);
  fireEvent.click(screen.getByLabelText('Открыть меню'));

  return { ...view, panel: screen.getByRole('dialog') };
}

beforeEach(() => {
  nav.pathname = '/terminal';
  setAccess({ access: access({ canStartTrial: false }) });
});

afterEach(cleanup);

// ─────────────── 1–2. Где живёт desktop-представление ───────────────────────

describe('1. desktop-представление только с lg', () => {
  it('пилюля скрыта до 1024 пикселей', () => {
    const { container } = render(<AccessStatusControl variant="compact" />);

    const box = container.firstElementChild!;

    expect(box.className).toContain('hidden');
    expect(box.className).toContain('lg:flex');
  });

  it('порог не md: именно там навигацию и подрезало', () => {
    const { container } = render(<AccessStatusControl variant="compact" />);

    expect(container.firstElementChild!.className).not.toContain('md:flex');
  });
});

describe('2. на узком экране индикатора в верхней панели нет', () => {
  it('строка в меню не наследует классы пилюли', () => {
    const { container } = render(<AccessStatusControl variant="menu" />);

    // Вариант `menu` живёт в панели и виден на любой ширине —
    // но саму панель скрывает `lg:hidden` у `MobileNav`.
    expect(container.firstElementChild!.className).not.toContain('lg:flex');
  });

  it('панель меню исчезает ровно с того же порога', () => {
    const { panel } = openMenu();

    expect(panel.className).toContain('lg:hidden');
    expect(screen.getByLabelText('Открыть меню').className).toContain('lg:hidden');
  });
});

// ─────────────── 3–4. Строка состояния внутри панели ────────────────────────

describe('3. в панели есть полная строка состояния', () => {
  it('подпись видна целиком, а не спрятана классом', () => {
    const { panel } = openMenu();

    const caption = within(panel).getByText('Выбрать план');

    // Требование прямое: в меню ширины хватает, и прятать подпись
    // через `hidden lg:inline` здесь незачем.
    expect(caption.className).not.toContain('hidden');
    expect(caption.className).not.toContain('lg:inline');
  });

  it('над состоянием стоит короткое слово «Доступ»', () => {
    const { panel } = openMenu();

    expect(within(panel).getByText('Доступ')).toBeTruthy();
  });

  it('строка занимает всю доступную ширину', () => {
    const { panel } = openMenu();

    const row = within(panel).getByLabelText('Доступ закрыт, выберите план');

    expect(row.className).toContain('w-full');
  });

  it('стоит после заголовка панели и до разделов', () => {
    const { panel } = openMenu();

    const row = within(panel).getByLabelText('Доступ закрыт, выберите план');
    const firstSection = within(panel).getByText('Терминал');
    const title = within(panel).getByLabelText('Закрыть меню');

    // `compareDocumentPosition` вместо индексов: порядок в разметке
    // проверяется напрямую, а не пересказывается.
    expect(title.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('4. оба представления берут одно состояние', () => {
  it('подпись совпадает', () => {
    setAccess({
      access: access({
        effectivePlan: 'TRIAL',
        status: 'trial',
        canStartTrial: false,
        trialRemainingSeconds: 4 * 86_400 + 8 * 3_600,
      }),
    });

    const compact = render(<AccessStatusControl variant="compact" />);
    const compactText = compact.container.textContent;
    cleanup();

    const menu = render(<AccessStatusControl variant="menu" />);

    expect(compactText).toContain('Trial · 4 дн 8 ч');
    expect(menu.container.textContent).toContain('Trial · 4 дн 8 ч');
  });

  it('адрес перехода совпадает', () => {
    setAccess({ access: access({ canStartTrial: true }) });

    const compact = render(<AccessStatusControl variant="compact" />);
    const compactHref = compact.container.querySelector('a')!.getAttribute('href');
    cleanup();

    const menu = render(<AccessStatusControl variant="menu" />);

    expect(menu.container.querySelector('a')!.getAttribute('href')).toBe(compactHref);
  });

  it('оба совпадают с чистой функцией', () => {
    setAccess({ access: access({ serviceAccess: true, canStartTrial: false }) });

    // Отдельного набора условий по тарифам ни в одном представлении
    // нет: разошлись бы они молча, и на телефоне человек видел бы
    // одно, а на ноутбуке другое.
    const expected = accessIndicatorState({
      hasSession: true,
      anonymous: false,
      loading: false,
      access: state.current.access!,
    });

    const compact = render(<AccessStatusControl variant="compact" />);
    expect(compact.container.textContent).toContain(expected.label);
    cleanup();

    const menu = render(<AccessStatusControl variant="menu" />);
    expect(menu.container.textContent).toContain(expected.label);
  });
});

// ─────────────── 5–7. Гость, ожидание, отказ ────────────────────────────────

describe('5. гость не получает пустого блока в меню', () => {
  it('в панели нет ни строки состояния, ни места под неё', () => {
    setAccess({ hasSession: false, anonymous: true, access: null });

    const { panel } = openMenu();

    expect(within(panel).queryByText('Доступ')).toBeNull();
    // Первым в панели остаётся заголовок, сразу за ним — разделы.
    expect(within(panel).getByText('Терминал')).toBeTruthy();
  });
});

describe('6. первая загрузка у вошедшего', () => {
  it('в шапке показывается ожидание, а не пустота', () => {
    setAccess({ hasSession: true, anonymous: true, loading: true, access: null });

    render(<AccessStatusControl variant="compact" />);

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('ширина зарезервирована, чтобы шапка не сдвинулась', () => {
    setAccess({ hasSession: true, anonymous: true, loading: true, access: null });

    const { container } = render(<AccessStatusControl variant="compact" />);

    expect(container.innerHTML).toContain('w-[92px]');
  });

  it('в меню резервирования нет: строка и так во всю ширину', () => {
    setAccess({ hasSession: true, anonymous: true, loading: true, access: null });

    const { container } = render(<AccessStatusControl variant="menu" />);

    expect(container.innerHTML).not.toContain('w-[92px]');
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('7. после 401 индикатор исчезает', () => {
  it('в шапке ничего не остаётся', () => {
    // Токен в браузере есть, но сервер его не признал.
    setAccess({ hasSession: true, anonymous: true, loading: false, access: null });

    const { container } = render(<AccessStatusControl variant="compact" />);

    expect(container.childNodes).toHaveLength(0);
  });

  it('в меню ничего не остаётся', () => {
    setAccess({ hasSession: true, anonymous: true, loading: false, access: null });

    const { container } = render(<AccessStatusControl variant="menu" />);

    expect(container.childNodes).toHaveLength(0);
  });
});

// ─────────────── 8–11. Куда ведёт каждое состояние ──────────────────────────

describe('маршруты состояний одинаковы в обоих представлениях', () => {
  const cases = [
    {
      name: '8. активный trial ведёт в /plans',
      access: access({ effectivePlan: 'TRIAL', status: 'trial', canStartTrial: false }),
      href: '/plans',
    },
    {
      name: '9. доступный trial ведёт в /access',
      access: access({ canStartTrial: true }),
      href: '/access',
    },
    {
      name: '10. использованный trial ведёт в /plans',
      access: access({ canStartTrial: false }),
      href: '/plans',
    },
  ];

  for (const c of cases) {
    it(`${c.name} — в шапке`, () => {
      setAccess({ access: c.access });
      render(<AccessStatusControl variant="compact" />);

      expect(screen.getByRole('link').getAttribute('href')).toBe(c.href);
    });

    it(`${c.name} — в меню`, () => {
      setAccess({ access: c.access });
      render(<AccessStatusControl variant="menu" />);

      expect(screen.getByRole('link').getAttribute('href')).toBe(c.href);
    });
  }

  it('11. служебный доступ не предлагает покупку', () => {
    setAccess({ access: access({ serviceAccess: true, status: 'service', canStartTrial: false }) });

    const menu = render(<AccessStatusControl variant="menu" />);

    expect(menu.container.textContent).toContain('Service');
    expect(menu.container.textContent).not.toMatch(/выбрать план/i);
    expect(screen.getByRole('link').getAttribute('href')).not.toBe('/plans');
  });
});

// ─────────────── 12–14. Поведение панели ────────────────────────────────────

describe('12. переход закрывает панель', () => {
  it('смена маршрута убирает панель с экрана', () => {
    const { panel, rerender } = openMenu();

    expect(panel.className).toContain('translate-x-0');

    // Отдельного обработчика закрытия у строки состояния нет:
    // панель реагирует на смену пути, и второй способ закрывать
    // её разошёлся бы с первым при первой же правке.
    nav.pathname = '/plans';
    rerender(<MobileNav />);

    expect(screen.getByRole('dialog').className).toContain('-translate-x-full');
  });

  it('строка состояния — обычная ссылка, а не кнопка со своим закрытием', () => {
    const { panel } = openMenu();

    const row = within(panel).getByLabelText('Доступ закрыт, выберите план');

    expect(row.tagName).toBe('A');
  });
});

describe('13. фокус остаётся внутри открытой панели', () => {
  it('Tab с последнего элемента возвращает на первый', () => {
    const { panel } = openMenu();

    const focusable = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('строка состояния попадает в цикл фокуса', () => {
    const { panel } = openMenu();

    const focusable = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const row = within(panel).getByLabelText('Доступ закрыт, выберите план');

    expect(focusable).toContain(row);
  });
});

describe('14. Escape закрывает панель', () => {
  it('панель уезжает, фокус возвращается на кнопку', () => {
    openMenu();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('dialog').className).toContain('-translate-x-full');
    expect(document.activeElement).toBe(screen.getByLabelText('Открыть меню'));
  });
});

// ─────────────── 15. Один порог на всю навигацию ────────────────────────────

describe('15. гамбургер и полная навигация не показываются вместе', () => {
  it('пороги дополняют друг друга', () => {
    const { container } = render(<MainNav />);
    const main = container.firstElementChild!;

    render(<MobileNav />);
    const burger = screen.getByLabelText('Открыть меню');

    // Полная навигация появляется с `lg`, гамбургер с `lg` исчезает.
    // Пока пороги были разными — `md` у одного и `md` у другого,
    // но индикатор жил в шапке всегда, — полоса 768–1023 оставалась
    // тесной, и пункты навигации подрезало.
    expect(main.className).toContain('lg:flex');
    expect(main.className).toContain('hidden');
    expect(burger.className).toContain('lg:hidden');
  });

  it('ни один из них не переключается на md', () => {
    const { container } = render(<MainNav />);
    render(<MobileNav />);

    expect(container.firstElementChild!.className).not.toContain('md:');
    expect(screen.getByLabelText('Открыть меню').className).not.toContain('md:');
    expect(screen.getByRole('dialog').className).not.toContain('md:');
  });
});
