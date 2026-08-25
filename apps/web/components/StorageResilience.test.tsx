import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

/**
 * Интерфейс переживает недоступное Web Storage.
 *
 * ─── Что упало ──────────────────────────────────────────────────────
 *
 *     TypeError: Cannot read properties of undefined (reading 'getItem')
 *     MobileNav.tsx:107  localStorage.getItem('role')
 *
 * Вся выдвижная панель переставала отрисовываться из-за одной
 * справочной подсказки — показывать ли пункт «Админка».
 *
 * ─── Первопричина ───────────────────────────────────────────────────
 *
 * Не настройка тестовой среды, а обращение компонента к хранилищу.
 * Комментарий рядом обещал безопасность: «читаем после монтирования,
 * localStorage недоступен на сервере». Отсрочка до монтирования
 * закрывает ровно один случай из четырёх.
 *
 * Хранилища не бывает ещё и когда: Safari в приватном режиме и браузер
 * с запрещёнными cookie бросают `SecurityError` при обращении к самому
 * свойству; квота переполнена и бросает запись; среда без DOM вовсе
 * не имеет такого свойства. Проверка `typeof window !== 'undefined'`
 * не ловит ни один из трёх.
 *
 * ─── Как проверяется ────────────────────────────────────────────────
 *
 * Ниже воспроизводятся оба отказа: свойство отсутствует и свойство
 * бросает. Это ровно те два, что встречаются в жизни, и именно они
 * роняли панель.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/terminal',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/sections', () => ({
  useVisibleSections: (list: readonly { href: string; label: string }[]) => list,
}));

// Права приходят с сервера и к хранилищу отношения не имеют.
// Здесь проверяется устойчивость интерфейса, а не логика доступа.
vi.mock('@/lib/access', () => ({
  useAccess: () => ({
    access: null,
    loading: false,
    revalidating: false,
    coldStart: false,
    anonymous: true,
    hasSession: false,
    error: null,
    reload: async () => {},
    can: () => false,
  }),
  trialRemainingLabel: () => '',
  formatUntil: () => '',
}));

const { MobileNav } = await import('./MobileNav');
const { readStored, writeStored, storageAvailable } = await import('@/lib/storage');

/** Исходные описания свойств: возвращаются после каждой подмены. */
const original = {
  local: Object.getOwnPropertyDescriptor(window, 'localStorage'),
  session: Object.getOwnPropertyDescriptor(window, 'sessionStorage'),
};

/** Свойства нет вовсе — так выглядит среда без DOM. */
function removeStorage(kind: 'localStorage' | 'sessionStorage') {
  Object.defineProperty(window, kind, { configurable: true, value: undefined });
}

/** Обращение бросает — так ведёт себя Safari в приватном режиме. */
function forbidStorage(kind: 'localStorage' | 'sessionStorage') {
  Object.defineProperty(window, kind, {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

/** Рабочее хранилище с заданным содержимым. */
function withStorage(values: Record<string, string>) {
  const data = new Map(Object.entries(values));

  const fake: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };

  Object.defineProperty(window, 'localStorage', { configurable: true, value: fake });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: fake });
}

beforeEach(() => {
  if (original.local) Object.defineProperty(window, 'localStorage', original.local);
  if (original.session) Object.defineProperty(window, 'sessionStorage', original.session);
});

afterEach(() => {
  cleanup();
  if (original.local) Object.defineProperty(window, 'localStorage', original.local);
  if (original.session) Object.defineProperty(window, 'sessionStorage', original.session);
});

// ───────────────────── Панель монтируется всегда ────────────────────────────

describe('MobileNav при недоступном хранилище', () => {
  it('монтируется, когда свойства нет вовсе', () => {
    removeStorage('localStorage');
    removeStorage('sessionStorage');

    // Ровно то падение, что пришло с macOS:
    // Cannot read properties of undefined (reading 'getItem').
    expect(() => render(<MobileNav />)).not.toThrow();
  });

  it('монтируется, когда обращение бросает SecurityError', () => {
    forbidStorage('localStorage');
    forbidStorage('sessionStorage');

    // Приватный режим Safari и запрещённые cookie. Проверка
    // `typeof window !== 'undefined'` этот случай пропускает,
    // потому что окно есть, а хранилища нет.
    expect(() => render(<MobileNav />)).not.toThrow();
  });

  it('навигация остаётся рабочей без хранилища', () => {
    removeStorage('localStorage');
    removeStorage('sessionStorage');

    render(<MobileNav />);

    // Панель не просто «не упала»: разделы на месте и открываются.
    expect(screen.getByLabelText('Открыть меню')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Терминал')).toBeTruthy();
  });
});

// ─────────────────── Роль: подсказка, а не право ────────────────────────────

describe('роль при недоступном хранилище', () => {
  it('сохранённая роль ADMIN работает как прежде', () => {
    withStorage({ accessToken: 'token', role: 'ADMIN' });

    render(<MobileNav />);

    // Регрессия в обратную сторону: защита от отсутствия хранилища
    // не должна прятать пункт у того, у кого он был.
    expect(within(screen.getByRole('dialog')).getByText('Админка')).toBeTruthy();
  });

  it('отсутствие хранилища — это отсутствие подсказки, а не доступ', () => {
    removeStorage('localStorage');
    removeStorage('sessionStorage');

    render(<MobileNav />);

    // Не «администратор» и не «прав нет» — просто неизвестно,
    // и интерфейс показывает обычный вид.
    expect(within(screen.getByRole('dialog')).queryByText('Админка')).toBeNull();
  });

  it('роль без сессии не показывается', () => {
    // Запись осталась от прошлого пользователя, сессии уже нет.
    withStorage({ role: 'ADMIN' });

    render(<MobileNav />);

    expect(within(screen.getByRole('dialog')).queryByText('Админка')).toBeNull();
  });

  it('роль не даёт прав: сервер о хранилище браузера ничего не знает', () => {
    withStorage({ accessToken: 'token', role: 'ADMIN' });

    render(<MobileNav />);

    // Пункт ведёт на обычный маршрут, закрытый сторожем и сервером.
    // Подмена строки в консоли браузера даёт ссылку, а не доступ.
    const admin = within(screen.getByRole('dialog')).getByText('Админка');

    expect(admin.closest('a')!.getAttribute('href')).toBe('/admin');
  });
});

// ───────────────────── Общий доступ к хранилищу ─────────────────────────────

describe('readStored и writeStored', () => {
  it('чтение отсутствующего хранилища даёт null, а не бросает', () => {
    removeStorage('localStorage');

    expect(readStored('local', 'role')).toBeNull();
    expect(storageAvailable('local')).toBe(false);
  });

  it('чтение запрещённого хранилища даёт null', () => {
    forbidStorage('localStorage');

    expect(readStored('local', 'role')).toBeNull();
  });

  it('запись в недоступное хранилище сообщает о неудаче, но не бросает', () => {
    removeStorage('localStorage');

    // Значение не переживёт перезагрузку — но текущий сеанс работает.
    expect(writeStored('local', 'role', 'ADMIN')).toBe(false);
  });

  it('переполненная квота тоже не роняет', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } as Storage,
    });

    expect(writeStored('local', 'k', 'v')).toBe(false);
    // Чтение при этом исправно: отказ записи не делает хранилище
    // недоступным целиком.
    expect(readStored('local', 'k')).toBeNull();
  });

  it('рабочее хранилище читается и пишется', () => {
    withStorage({});

    expect(writeStored('local', 'role', 'ADMIN')).toBe(true);
    expect(readStored('local', 'role')).toBe('ADMIN');
  });
});
