import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { PASSWORD_MAX } from '@memex/core';

/**
 * Форма входа и регистрации.
 *
 * Сервер остаётся авторитетом; здесь проверяется то, чего сервер
 * не видит: доходит ли запрос до него вообще. Клиентская проверка
 * ценна ровно тем, что заранее известный отказ не стоит человеку
 * круга в сеть, — и проверить это можно только счётчиком вызовов.
 */

const nav = vi.hoisted(() => ({
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/login',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const apiCalls = vi.hoisted(() => [] as Array<{ path: string; body: any }>);
const apiImpl = vi.hoisted(() => ({ handler: async (_path: string, _body: any) => ({}) as any }));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');

  return {
    ...actual,
    api: async (path: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      apiCalls.push({ path, body });
      return apiImpl.handler(path, body);
    },
    setToken: vi.fn(),
  };
});

vi.mock('@/lib/access', () => ({
  useAccess: () => ({ reload: async () => {} }),
}));

vi.mock('@/lib/storage', () => ({ writeStored: vi.fn() }));

const { default: LoginPage } = await import('./page');
const { ApiError, NetworkError } = await import('@/lib/api');

const GOOD_PASSWORD = 'достаточно-длинный-пароль';

function open(mode: 'login' | 'register' = 'login') {
  nav.search = mode === 'register' ? 'mode=register' : '';
  return render(<LoginPage />);
}

const emailField = () => screen.getByLabelText('Email') as HTMLInputElement;
const passwordField = () => screen.getByLabelText('Пароль') as HTMLInputElement;
const totpField = () => screen.getByLabelText('Код 2FA') as HTMLInputElement;

function type(field: HTMLInputElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/**
 * Кнопка отправки.
 *
 * По типу, а не по названию: в режиме регистрации на форме две
 * кнопки со словом «Войти» — отправка и переключатель режима.
 */
const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

async function submit() {
  await act(async () => {
    fireEvent.click(submitButton());
    await Promise.resolve();
  });
}

beforeEach(() => {
  apiCalls.length = 0;
  apiImpl.handler = async () => ({});
  nav.push.mockClear();
  nav.replace.mockClear();
});

afterEach(cleanup);

// ────────────────────────────── Email ───────────────────────────────────────

describe('адрес почты', () => {
  it('некорректный не отправляется', async () => {
    open();
    type(emailField(), 'не-адрес');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    // Круг в сеть ради заранее известного отказа — только задержка.
    expect(apiCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/адрес/i);
  });

  it('пустой не отправляется', async () => {
    open();
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(apiCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Введите адрес/);
  });

  it('слишком длинный не отправляется', async () => {
    open();
    type(emailField(), `${'a'.repeat(250)}@example.com`);
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(apiCalls).toHaveLength(0);
  });

  it('нормализуется перед отправкой', async () => {
    open();
    type(emailField(), '  User@Example.COM  ');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(apiCalls[0]!.body.email).toBe('user@example.com');
  });

  it('во время ввода значение не переписывается', () => {
    open();
    const field = emailField();
    type(field, 'User@Ex');

    // Приведение на каждом нажатии переставляет курсор и мешает
    // печатать: заглавная буква исчезает под пальцами.
    expect(field.value).toBe('User@Ex');
  });

  it('приводится при потере фокуса', () => {
    open();
    const field = emailField();
    type(field, '  User@Example.COM  ');
    fireEvent.blur(field);

    expect(field.value).toBe('user@example.com');
  });

  it('ошибка связана с полем через aria', async () => {
    open();
    type(emailField(), 'плохо');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    const field = emailField();

    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)).toBeTruthy();
  });

  it('фокус переходит на первое ошибочное поле', async () => {
    open();
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(document.activeElement).toBe(emailField());
  });
});

// ───────────────────────── Пароль при регистрации ───────────────────────────

describe('пароль при регистрации', () => {
  const fill = (password: string) => {
    open('register');
    type(emailField(), 'user@example.com');
    type(passwordField(), password);
  };

  it('короткий не отправляется', async () => {
    fill('коротк');
    await submit();

    expect(apiCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Не короче/);
  });

  it('из одних пробелов не отправляется', async () => {
    fill('          ');
    await submit();

    expect(apiCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/пробел/i);
  });

  it('пустой даёт своё сообщение', async () => {
    fill('');
    await submit();

    expect(screen.getByRole('alert').textContent).toMatch(/Введите пароль/);
  });

  it('пробел внутри нормального пароля разрешён', async () => {
    fill('correct horse battery');
    await submit();

    // `trim` сломал бы вход тем, у кого пробел — часть пароля.
    expect(apiCalls[0]!.body.password).toBe('correct horse battery');
  });

  it('поле не даёт превысить верхнюю границу', () => {
    fill('a');

    expect(passwordField().maxLength).toBe(PASSWORD_MAX);
  });

  it('длиннее предела не отправляется', async () => {
    fill('a'.repeat(PASSWORD_MAX + 1));
    await submit();

    expect(apiCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Не длиннее/);
  });

  it('требования показаны, но без оценки надёжности', () => {
    fill('a');

    const hint = document.getElementById('auth-password-hint')!;

    expect(hint.textContent).toMatch(/10/);
    // Полоска «слабый/сильный» обещает знание, которого у нас нет.
    expect(hint.textContent).not.toMatch(/надёжн|сил[аь]|слаб/i);
  });
});

// ─────────────────────────── Пароль при входе ───────────────────────────────

describe('пароль при входе', () => {
  it('старый короткий пароль отправляется', async () => {
    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), 'старый');
    await submit();

    // Аккаунт мог быть заведён по прежним правилам: отказ из-за новой
    // нижней границы запер бы человека снаружи.
    expect(apiCalls).toHaveLength(1);
  });

  it('из одних пробелов — нет', async () => {
    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), '     ');
    await submit();

    expect(apiCalls).toHaveLength(0);
  });

  it('пустой — нет', async () => {
    open();
    type(emailField(), 'user@example.com');
    await submit();

    expect(apiCalls).toHaveLength(0);
  });
});

// ──────────────────────────────── 2FA ───────────────────────────────────────

describe('второй фактор', () => {
  async function requireTotp() {
    apiImpl.handler = async () => {
      throw new ApiError('Требуется код 2FA', 401, undefined, { need2fa: true });
    };

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);
    await submit();
  }

  it('поле появляется и получает фокус', async () => {
    await requireTotp();

    expect(totpField()).toBeTruthy();
    expect(document.activeElement).toBe(totpField());
  });

  it('буквы в поле не набираются', async () => {
    await requireTotp();
    type(totpField(), '12ab34');

    expect(totpField().value).toBe('1234');
  });

  it('больше шести цифр не набирается', async () => {
    await requireTotp();
    type(totpField(), '1234567890');

    expect(totpField().value).toBe('123456');
    expect(totpField().maxLength).toBe(6);
  });

  it('пять цифр не отправляются', async () => {
    await requireTotp();
    apiCalls.length = 0;
    apiImpl.handler = async () => ({ accessToken: 't', refreshToken: 'r', role: 'USER' });

    type(totpField(), '12345');
    await submit();

    expect(apiCalls).toHaveLength(0);
    expect(screen.getByText('Введите шестизначный код')).toBeTruthy();
  });

  it('шесть цифр уходят на сервер', async () => {
    await requireTotp();
    apiCalls.length = 0;
    apiImpl.handler = async () => ({ accessToken: 't', refreshToken: 'r', role: 'USER' });

    type(totpField(), '123456');
    await submit();

    expect(apiCalls[0]!.body.totp).toBe('123456');
  });
});

// ───────────────────────── Переключение режима ─────────────────────────────

describe('переключение входа и регистрации', () => {
  it('ручной переход на вход убирает mode=register из адреса', async () => {
    open('register');

    await act(async () => {
      screen.getByRole('button', { name: 'Уже есть аккаунт? Войти' }).click();
    });

    expect(screen.getByRole('heading').textContent).toBe('Вход');
    expect(nav.replace).toHaveBeenCalledWith('/login', { scroll: false });
  });

  it('ручной переход на регистрацию сохраняет next', async () => {
    nav.search = 'next=%2Fradar%3Ffilter%3Dnew';
    render(<LoginPage />);

    await act(async () => {
      screen.getByRole('button', { name: 'Нет аккаунта? Зарегистрироваться' }).click();
    });

    expect(screen.getByRole('heading').textContent).toBe('Регистрация');
    expect(nav.replace).toHaveBeenCalledWith(
      '/login?next=%2Fradar%3Ffilter%3Dnew&mode=register',
      { scroll: false },
    );
  });
});

// ────────────────────── Аккаунт уже существует ──────────────────────────────

describe('повторная регистрация', () => {
  async function registerExisting() {
    apiImpl.handler = async () => {
      throw new ApiError('Аккаунт уже существует — войдите', 409, undefined, {
        code: 'ACCOUNT_ALREADY_EXISTS',
      });
    };

    open('register');
    type(emailField(), 'User@Example.com');
    type(passwordField(), GOOD_PASSWORD);
    await submit();
  }

  it('код распознаётся, а не текст', async () => {
    // Формулировку правят при первой редактуре, код — нет.
    apiImpl.handler = async () => {
      throw new ApiError('совершенно другой текст', 409, undefined, {
        code: 'ACCOUNT_ALREADY_EXISTS',
      });
    };

    open('register');
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(screen.getByText('Аккаунт уже существует — войдите')).toBeTruthy();
  });

  it('«Аккаунт создан» не показывается', async () => {
    await registerExisting();

    // Иначе человек уходит ждать письма, которого не будет.
    expect(screen.queryByText(/Аккаунт создан/)).toBeNull();
  });

  it('предлагается кнопка «Войти»', async () => {
    await registerExisting();

    expect(within(screen.getByRole('status')).getByRole('button', { name: 'Войти' })).toBeTruthy();
  });

  it('нажатие переключает форму на вход', async () => {
    await registerExisting();

    await act(async () => {
      within(screen.getByRole('status')).getByRole('button', { name: 'Войти' }).click();
    });

    expect(screen.getByRole('heading').textContent).toBe('Вход');
  });

  it('адрес сохраняется нормализованным', async () => {
    await registerExisting();

    await act(async () => {
      within(screen.getByRole('status')).getByRole('button', { name: 'Войти' }).click();
    });

    expect(emailField().value).toBe('user@example.com');
  });

  it('пароль очищается', async () => {
    await registerExisting();

    expect(passwordField().value).toBe('');
  });

  it('адрес страницы меняется на /login без перезагрузки', async () => {
    await registerExisting();

    await act(async () => {
      within(screen.getByRole('status')).getByRole('button', { name: 'Войти' }).click();
    });

    expect(nav.replace).toHaveBeenCalledWith('/login', { scroll: false });
  });
});

// ───────────────────────── Успешная регистрация ─────────────────────────────

describe('успешная регистрация', () => {
  async function registerOk() {
    apiImpl.handler = async () => ({ ok: true });

    open('register');
    type(emailField(), ' User@Example.com ');
    type(passwordField(), GOOD_PASSWORD);
    await submit();
  }

  it('форма переключается на вход', async () => {
    await registerOk();

    expect(screen.getByRole('heading').textContent).toBe('Вход');
  });

  it('сообщение нейтральное', async () => {
    await registerOk();

    expect(screen.getByText('Аккаунт создан — теперь войдите')).toBeTruthy();
  });

  it('адрес сохраняется, пароль очищается', async () => {
    await registerOk();

    expect(emailField().value).toBe('user@example.com');
    expect(passwordField().value).toBe('');
  });

  it('сессия не создаётся сама', async () => {
    await registerOk();

    // Сервер токена не выдавал: переход в приложение был бы выдумкой.
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('адрес страницы обновляется', async () => {
    await registerOk();

    expect(nav.replace).toHaveBeenCalledWith('/login', { scroll: false });
  });
});

// ────────────────────── Повторная отправка и ошибки ─────────────────────────

describe('повторная отправка', () => {
  it('двойной клик даёт один запрос', async () => {
    let release: (v: unknown) => void = () => {};
    apiImpl.handler = () => new Promise((resolve) => { release = resolve; }) as any;

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);

    const button = submitButton();

    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(apiCalls).toHaveLength(1);

    await act(async () => {
      release({ accessToken: 't', refreshToken: 'r', role: 'USER' });
      await Promise.resolve();
    });
  });

  it('кнопка блокируется на время запроса', async () => {
    apiImpl.handler = () => new Promise(() => {}) as any;

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);

    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });

    expect(submitButton().disabled).toBe(true);
  });

  it('после серверной ошибки можно исправить и повторить', async () => {
    apiImpl.handler = async () => {
      throw new ApiError('Неверный email или пароль', 401, undefined, {});
    };

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), 'первый-длинный-пароль');
    await submit();

    apiImpl.handler = async () => ({ accessToken: 't', refreshToken: 'r', role: 'USER' });
    type(passwordField(), 'второй-длинный-пароль');
    await submit();

    expect(apiCalls).toHaveLength(2);
  });
});

describe('виды ошибок различаются', () => {
  it('401 при входе — общая ошибка без подсказки о существовании аккаунта', async () => {
    apiImpl.handler = async () => {
      throw new ApiError('Неверный email или пароль', 401, undefined, {});
    };

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    expect(screen.getByText('Неверный email или пароль')).toBeTruthy();
  });

  it('сетевой сбой отличается от неверного пароля', async () => {
    apiImpl.handler = async () => {
      throw new NetworkError('http://localhost:4000/api/v1/auth/login');
    };

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), GOOD_PASSWORD);
    await submit();

    const text = screen.getByRole('status').textContent ?? '';

    // Прежде оба показывались одинаково, и неподнятый бэкенд
    // выглядел как ошибка ввода.
    expect(text).not.toMatch(/Неверный email/);
    expect(text).toMatch(/не отвеча|API/i);
  });

  it('ни пароль, ни код не попадают в текст ошибки', async () => {
    apiImpl.handler = async () => {
      throw new ApiError('Неверный email или пароль', 401, undefined, {});
    };

    open();
    type(emailField(), 'user@example.com');
    type(passwordField(), 'секретная-строка-пароля');
    await submit();

    expect(document.body.textContent).not.toContain('секретная-строка-пароля');
  });
});
