/**
 * Отчёт о настройке OKX.
 *
 * Проверяется главным образом то, чего в отчёте быть не должно.
 * Ключи задаются в панели развёртывания, и добавить их не в тот
 * сервис — обычное дело; снаружи это неотличимо от спокойного рынка.
 * Отчёт должен различать эти случаи и при этом не показывать
 * ни одного символа значений.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { credentialConflicts } from './okx-config.js';

const KEYS = [
  'OKX_API_SECRET',
  'OKX_SECRET_KEY',
  'OKX_PASSPHRASE',
  'OKX_API_PASSPHRASE',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('расхождение написаний переменной', () => {
  it('одно имя — расхождения нет', () => {
    process.env.OKX_API_SECRET = 'значение';

    expect(credentialConflicts()).toEqual([]);
  });

  it('оба имени с одинаковым значением — расхождения нет', () => {
    // Так бывает при переезде: старое имя оставили, новое добавили.
    // Пока значения совпадают, выбирать не из чего.
    process.env.OKX_API_SECRET = 'одно и то же';
    process.env.OKX_SECRET_KEY = 'одно и то же';

    expect(credentialConflicts()).toEqual([]);
  });

  it('оба имени с разными значениями — расхождение', () => {
    // Угадывать нельзя: подписав запрос не тем секретом, мы получим
    // отказ авторизации, который объясняется чем угодно, кроме
    // настоящей причины.
    process.env.OKX_API_SECRET = 'первое';
    process.env.OKX_SECRET_KEY = 'второе';

    const conflicts = credentialConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.variables).toEqual(['OKX_API_SECRET', 'OKX_SECRET_KEY']);
  });

  it('разница только в пробелах расхождением не считается', () => {
    process.env.OKX_API_SECRET = 'значение';
    process.env.OKX_SECRET_KEY = '  значение  ';

    expect(credentialConflicts()).toEqual([]);
  });

  it('пустая строка не спорит с заполненной', () => {
    // Переменную часто заводят заранее и оставляют пустой.
    // Считать это расхождением значило бы выключить работающую
    // настройку.
    process.env.OKX_API_SECRET = 'значение';
    process.env.OKX_SECRET_KEY = '';

    expect(credentialConflicts()).toEqual([]);
  });

  it('парольная фраза проверяется отдельно от секрета', () => {
    process.env.OKX_PASSPHRASE = 'первая';
    process.env.OKX_API_PASSPHRASE = 'вторая';

    const conflicts = credentialConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.variables).toEqual(['OKX_PASSPHRASE', 'OKX_API_PASSPHRASE']);
  });

  it('в сообщении о расхождении нет самих значений', () => {
    // Отчёт уходит в журнал, а журнал переживает инциденты.
    process.env.OKX_API_SECRET = 'секрет-раз';
    process.env.OKX_SECRET_KEY = 'секрет-два';

    const text = JSON.stringify(credentialConflicts());

    expect(text).not.toContain('секрет-раз');
    expect(text).not.toContain('секрет-два');
    expect(text).toContain('OKX_API_SECRET');
  });
});
