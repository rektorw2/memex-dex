import { describe, it, expect } from 'vitest';
import { apiBaseFor, ROOT_API_PREFIXES } from './api-base.js';

/**
 * Выбор базы для маршрута.
 *
 * Ошибка здесь даёт 404, а 404 на необязательном запросе гасится
 * страницей и выглядит не как поломка, а как пустой ответ сервера.
 * Именно так страница тарифов однажды и осталась без цен: три
 * запроса ушли под `/api/v1`, где их нет, и никто не заметил.
 */

describe('маршруты доступа и оплаты живут под /api', () => {
  it.each([
    '/access/me',
    '/access/plans',
    '/access/trial/activate',
    '/access/email/code',
    '/access/email/verify',
    '/payments/catalog',
    '/payments/status',
    '/payments/checkout',
    '/payments/onboarding',
  ])('%s — root', (path) => {
    expect(apiBaseFor(path)).toBe('root');
  });
});

describe('торговые маршруты живут под /api/v1', () => {
  it.each([
    '/portfolio',
    '/portfolio/history',
    '/orders',
    '/tokens',
    '/tokens/tok-1/candles',
    '/market/summary',
    '/radar/subscription',
    '/wallets',
    '/wallets/assets',
    '/copy/leaders',
    '/admin/overview',
    // Вход и регистрация зарегистрированы под `/api/v1`, хотя
    // по смыслу и просятся к маршрутам доступа. Таблица описывает
    // факт, а не смысл.
    '/auth/login',
    '/auth/register',
    '/auth/refresh',
    '/auth/logout',
    '/auth/2fa/setup',
  ])('%s — v1', (path) => {
    expect(apiBaseFor(path)).toBe('v1');
  });
});

describe('разбор пути', () => {
  it('не зависит от строки запроса', () => {
    expect(apiBaseFor('/payments/catalog?x=1')).toBe('root');
    expect(apiBaseFor('/tokens?sort=gainers&limit=1')).toBe('v1');
  });

  it('узнаёт модуль и без хвоста', () => {
    expect(apiBaseFor('/payments')).toBe('root');
    expect(apiBaseFor('/access')).toBe('root');
  });

  it('не путает похожие начала', () => {
    // `/accessories` — не про доступ, и отправлять его на другую
    // базу из-за совпадения первых семи букв нельзя.
    expect(apiBaseFor('/accessories')).toBe('v1');
    expect(apiBaseFor('/payments-report')).toBe('v1');
  });

  it('незнакомый маршрут считается версионированным', () => {
    // Их подавляющее большинство, и новый торговый маршрут
    // не должен требовать правки списка.
    expect(apiBaseFor('/что-то-новое')).toBe('v1');
  });

  it('каждый префикс записан со слэшем на конце', () => {
    // Иначе `/payments` совпало бы с `/payments-report`.
    for (const p of ROOT_API_PREFIXES) {
      expect(p.startsWith('/'), p).toBe(true);
      expect(p.endsWith('/'), p).toBe(true);
    }
  });
});
