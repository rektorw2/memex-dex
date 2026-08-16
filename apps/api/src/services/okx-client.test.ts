import { describe, it, expect } from 'vitest';
import { buildPreHash, signPreHash, okxTimestamp } from './okx-client.js';

/**
 * Подпись — самое хрупкое место интеграции: ошибка даёт 401 без
 * объяснения, какая часть строки не сошлась. Поэтому она проверяется
 * тестами, а не подбором по ответу сервера.
 */

describe('строка подписи', () => {
  const ts = '2026-08-16T12:00:00.000Z';

  it('собирается в порядке timestamp + метод + путь + тело', () => {
    expect(buildPreHash(ts, 'GET', '/api/v6/dex/market/leaderboard/list')).toBe(
      `${ts}GET/api/v6/dex/market/leaderboard/list`,
    );
  });

  it('метод приводится к верхнему регистру', () => {
    expect(buildPreHash(ts, 'get', '/x')).toBe(`${ts}GET/x`);
  });

  it('query string входит в подпись', () => {
    // Самая частая ошибка: путь подписывают без параметров,
    // и сервер отвечает 401 без указания причины.
    const withQuery = '/api/v6/dex/market/leaderboard/list?chainIndex=501&timeFrame=3';
    expect(buildPreHash(ts, 'GET', withQuery)).toContain('?chainIndex=501&timeFrame=3');
    expect(buildPreHash(ts, 'GET', withQuery)).not.toBe(
      buildPreHash(ts, 'GET', '/api/v6/dex/market/leaderboard/list'),
    );
  });

  it('тело POST входит ровно в том виде, в каком уходит', () => {
    const body = '{"tokens":[{"chainIndex":"501"}]}';
    expect(buildPreHash(ts, 'POST', '/x', body)).toBe(`${ts}POST/x${body}`);
  });

  it('пустое тело ничего не добавляет', () => {
    expect(buildPreHash(ts, 'GET', '/x', '')).toBe(`${ts}GET/x`);
  });
});

describe('подпись', () => {
  it('устойчива: одна строка даёт один результат', () => {
    const a = signPreHash('abc', 'secret');
    const b = signPreHash('abc', 'secret');
    expect(a).toBe(b);
  });

  it('в формате base64', () => {
    expect(signPreHash('abc', 'secret')).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('разный секрет даёт разную подпись', () => {
    expect(signPreHash('abc', 's1')).not.toBe(signPreHash('abc', 's2'));
  });

  it('изменение любой части строки меняет подпись', () => {
    const base = signPreHash(buildPreHash('2026-01-01T00:00:00.000Z', 'GET', '/a'), 'k');
    expect(signPreHash(buildPreHash('2026-01-01T00:00:01.000Z', 'GET', '/a'), 'k')).not.toBe(base);
    expect(signPreHash(buildPreHash('2026-01-01T00:00:00.000Z', 'POST', '/a'), 'k')).not.toBe(base);
    expect(signPreHash(buildPreHash('2026-01-01T00:00:00.000Z', 'GET', '/b'), 'k')).not.toBe(base);
  });

  it('секрет не появляется в подписи', () => {
    const secret = 'СЕКРЕТНАЯ_СТРОКА_12345';
    expect(signPreHash('данные', secret)).not.toContain(secret);
  });
});

describe('отметка времени', () => {
  it('в формате ISO 8601 UTC', () => {
    expect(okxTimestamp(new Date('2026-08-16T12:00:00Z'))).toBe('2026-08-16T12:00:00.000Z');
  });

  it('всегда заканчивается на Z — часовой пояс сервера роли не играет', () => {
    expect(okxTimestamp()).toMatch(/Z$/);
  });
});
