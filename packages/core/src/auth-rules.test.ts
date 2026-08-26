import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  emailLooksValid,
  passwordIssue,
  totpIssue,
  logoDestination,
  guestHeaderActions,
  PASSWORD_MIN,
  PASSWORD_MAX,
} from './auth-rules.js';

/**
 * Правила входа, регистрации и первого перехода.
 *
 * Сервер остаётся авторитетом; смысл этих проверок в том, чтобы
 * клиент и сервер отвечали одинаково. Разошедшись, они дают форму,
 * которая пропускает значение, и сервер, который его отвергает.
 */

// ─────────────────────────────── Почта ──────────────────────────────────────

describe('нормализация адреса', () => {
  it('регистр и пробелы не создают второй ящик', () => {
    for (const raw of ['User@Example.com', ' user@example.com ', 'USER@EXAMPLE.COM']) {
      expect(normalizeEmail(raw)).toBe('user@example.com');
    }
  });

  it('нормализация идёт до сравнения, а не после', () => {
    // Иначе человек регистрируется одним написанием, входит другим
    // и получает «неверный email или пароль» при верном пароле.
    expect(normalizeEmail('A@B.co')).toBe(normalizeEmail('a@b.CO'));
  });
});

describe('проверка адреса', () => {
  it('обычные адреса проходят', () => {
    for (const email of ['user@example.com', 'a.b+tag@sub.domain.org']) {
      expect(emailLooksValid(email), email).toBe(true);
    }
  });

  it('без собаки, домена или с пробелом — нет', () => {
    for (const email of ['user', 'user@', '@example.com', 'user@example', 'a b@c.com', '']) {
      expect(emailLooksValid(email), email).toBe(false);
    }
  });

  it('две собаки — нет', () => {
    expect(emailLooksValid('a@b@c.com')).toBe(false);
  });

  it('слишком длинный адрес отклоняется', () => {
    // Длиннее предела RFC адресов не бывает, а попытки переполнить
    // поле длинной строкой — бывают.
    expect(emailLooksValid(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

// ─────────────────────────────── Пароль ─────────────────────────────────────

describe('пароль', () => {
  it('нормальный проходит', () => {
    expect(passwordIssue('a'.repeat(PASSWORD_MIN))).toBeNull();
  });

  it('короткий отклоняется', () => {
    expect(passwordIssue('a'.repeat(PASSWORD_MIN - 1))).toBe('TOO_SHORT');
  });

  it('пустой отличается от короткого', () => {
    // Разные сообщения: «введите пароль» и «пароль слишком короткий»
    // помогают по-разному.
    expect(passwordIssue('')).toBe('EMPTY');
  });

  it('из одних пробелов не принимается', () => {
    // Пробелы внутри пароля законны, но целиком из них человек
    // не наберёт его повторно никогда.
    expect(passwordIssue('          ')).toBe('WHITESPACE_ONLY');
  });

  it('пробел внутри пароля допустим', () => {
    expect(passwordIssue('correct horse battery')).toBeNull();
  });

  it('слишком длинный отклоняется', () => {
    // argon2 считает хэш от всей строки: мегабайтный «пароль» —
    // способ занять процессор сервера.
    expect(passwordIssue('a'.repeat(PASSWORD_MAX + 1))).toBe('TOO_LONG');
  });

  it('ровно предел ещё проходит', () => {
    expect(passwordIssue('a'.repeat(PASSWORD_MAX))).toBeNull();
  });
});

// ──────────────────────────────── 2FA ───────────────────────────────────────

describe('код 2FA', () => {
  it('шесть цифр проходят', () => {
    expect(totpIssue('123456')).toBeNull();
    expect(totpIssue(' 123456 ')).toBeNull();
  });

  it('пять и семь цифр — нет', () => {
    expect(totpIssue('12345')).toBe('NOT_SIX_DIGITS');
    expect(totpIssue('1234567')).toBe('NOT_SIX_DIGITS');
  });

  it('буквы — нет', () => {
    // «Шесть символов» пропустило бы вставленное не то.
    expect(totpIssue('12345a')).toBe('NOT_SIX_DIGITS');
  });

  it('пустой отличается от неверного формата', () => {
    expect(totpIssue('   ')).toBe('EMPTY');
  });
});

// ─────────────────── Куда ведёт логотип ─────────────────────────────────────

describe('назначение логотипа', () => {
  const base = { loading: false, anonymous: false, hasSession: true, serviceAccess: false };

  it('гость идёт на приветственную', () => {
    expect(
      logoDestination({ ...base, anonymous: true, hasSession: false, plan: null }),
    ).toBe('/');
  });

  it('во время загрузки адрес не меняется', () => {
    /*
     * Подставить `/plans` заранее значит увести оплатившего человека
     * на витрину тарифов; подставить `/terminal` — упереть гостя
     * в сторожа маршрута.
     */
    expect(logoDestination({ ...base, loading: true, plan: null })).toBe('/');
  });

  it('после отказа сервера — тоже на приветственную', () => {
    // Токен есть, но сервер его не признал: нужен вход.
    expect(logoDestination({ ...base, anonymous: true, plan: null })).toBe('/');
  });

  it('без доступа — на тарифы', () => {
    expect(logoDestination({ ...base, plan: 'EXPIRED' })).toBe('/plans');
  });

  it('пробный период — в терминал', () => {
    expect(logoDestination({ ...base, plan: 'TRIAL' })).toBe('/terminal');
  });

  it('оплаченный план — в терминал', () => {
    for (const plan of ['PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const) {
      expect(logoDestination({ ...base, plan }), plan).toBe('/terminal');
    }
  });

  it('служебный доступ — в терминал даже при истёкшем плане', () => {
    // Проверь мы сначала план, администратор попадал бы на витрину
    // тарифов: у него план может быть каким угодно.
    expect(logoDestination({ ...base, plan: 'EXPIRED', serviceAccess: true })).toBe('/terminal');
  });
});

// ─────────────── Гостевые кнопки в шапке ────────────────────────────────────

describe('кнопки шапки у гостя', () => {
  it('на обычной странице показываются обе', () => {
    expect(guestHeaderActions({ pathname: '/terminal', mode: null, hasSession: false })).toEqual({
      showLogin: true,
      showRegister: true,
    });
  });

  it('на форме регистрации своя кнопка не дублируется', () => {
    expect(guestHeaderActions({ pathname: '/login', mode: 'register', hasSession: false })).toEqual({
      showLogin: true,
      showRegister: false,
    });
  });

  it('на форме входа не дублируется «Войти»', () => {
    expect(guestHeaderActions({ pathname: '/login', mode: null, hasSession: false })).toEqual({
      showLogin: false,
      showRegister: true,
    });
  });

  it('режим читается из параметра, а не из пути', () => {
    // Вход и регистрация живут на одном маршруте и различаются
    // только им: смотреть на путь значит не различать их вовсе.
    const login = guestHeaderActions({ pathname: '/login', mode: null, hasSession: false });
    const register = guestHeaderActions({ pathname: '/login', mode: 'register', hasSession: false });

    expect(login).not.toEqual(register);
  });

  it('неизвестный режим считается входом', () => {
    expect(
      guestHeaderActions({ pathname: '/login', mode: 'что-то', hasSession: false }).showRegister,
    ).toBe(true);
  });

  it('с сессией гостевых кнопок нет вовсе', () => {
    expect(guestHeaderActions({ pathname: '/terminal', mode: null, hasSession: true })).toEqual({
      showLogin: false,
      showRegister: false,
    });
  });
});
