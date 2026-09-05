import { describe, it, expect } from 'vitest';
import { appRelativePath, withNext } from './route-access.js';

/**
 * Префикс развёртывания добавляется ровно один раз.
 *
 * На production встречался адрес `/memex-dex/memex-dex/agent`. Это не
 * косметика: человека, которого попросили войти, возвращало после
 * успешного входа на несуществующую страницу — то есть ровно тогда,
 * когда он сделал всё правильно.
 *
 * Причина складывалась из двух верных по отдельности фактов: роутер
 * Next сам добавляет `basePath` к переходу, а `window.location.pathname`
 * этот префикс уже содержит.
 */

const BASE = '/memex-dex';
const rel = (path: string | null | undefined) => appRelativePath(path, BASE);

describe('снятие префикса развёртывания', () => {
  it('путь без префикса не меняется', () => {
    expect(rel('/agent')).toBe('/agent');
  });

  it('один префикс снимается', () => {
    expect(rel('/memex-dex/agent')).toBe('/agent');
  });

  it('двойной префикс снимается весь', () => {
    // Такие ссылки уже лежат в закладках и в открытых вкладках.
    // Они должны работать, а не приводить в никуда.
    expect(rel('/memex-dex/memex-dex/agent')).toBe('/agent');
  });

  it('тройной префикс тоже снимается', () => {
    expect(rel('/memex-dex/memex-dex/memex-dex/agent')).toBe('/agent');
  });

  it('параметры и якорь сохраняются', () => {
    // `/radar/alerts` без `?filter=new` — другой экран.
    expect(rel('/terminal?token=abc#chart')).toBe('/terminal?token=abc#chart');
    expect(rel('/memex-dex/terminal?token=abc#chart')).toBe('/terminal?token=abc#chart');
  });

  it('корень приложения под префиксом — это корень', () => {
    expect(rel('/memex-dex')).toBe('/');
    expect(rel('/memex-dex/')).toBe('/');
  });

  it('похожий на префикс путь не режется', () => {
    /*
     * `/memex-dexterity` начинается с тех же символов, но префиксом
     * не является. Наивная обрезка по длине превратила бы его
     * в `terity`.
     */
    expect(rel('/memex-dexterity')).toBe('/memex-dexterity');
  });

  it('префикс внутри пути остаётся на месте', () => {
    // Здесь это часть адреса, а не развёртывания.
    expect(rel('/agent/memex-dex/x')).toBe('/agent/memex-dex/x');
  });

  it('без настроенного префикса путь возвращается как есть', () => {
    expect(appRelativePath('/memex-dex/agent', '')).toBe('/memex-dex/agent');
    expect(appRelativePath('/agent', '')).toBe('/agent');
  });
});

describe('безопасность не теряется при снятии префикса', () => {
  it('абсолютный адрес отвергается', () => {
    expect(rel('https://evil.example/x')).toBeNull();
    expect(rel('//evil.example')).toBeNull();
  });

  it('чужой хост, спрятанный за префиксом, отвергается', () => {
    /*
     * Самый неочевидный случай. `/memex-dex//evil.example` проходит
     * первую проверку: он начинается с одной косой черты. После
     * снятия префикса остаётся `//evil.example` — открытый редирект
     * на чужой хост.
     *
     * Без повторной проверки на каждом шаге снятие префикса само
     * стало бы способом обойти защиту.
     */
    expect(rel('/memex-dex//evil.example')).toBeNull();
    expect(rel('/memex-dex/memex-dex//evil.example')).toBeNull();
  });

  it('обратная косая черта отвергается и под префиксом', () => {
    expect(rel('/memex-dex/\\evil.example')).toBeNull();
  });

  it('управляющие символы отвергаются', () => {
    expect(rel('/memex-dex/agent\n')).toBeNull();
    expect(rel('/agent\0')).toBeNull();
  });

  it('пустое и не-путь отвергаются', () => {
    expect(rel(null)).toBeNull();
    expect(rel('')).toBeNull();
    expect(rel('agent')).toBeNull();
  });
});

describe('сквозной путь: адрес → next → переход', () => {
  /**
   * Итоговый адрес в браузере.
   *
   * Роутер добавляет префикс сам — здесь это моделируется явно,
   * потому что именно это сложение и давало двойной префикс.
   */
  const finalUrl = (visited: string) => {
    const relative = rel(visited);
    const login = withNext('/login', relative);
    // Роутер добавляет префикс к тому, что ему передали.
    const loginUrl = `${BASE}${login}`;
    // После входа читаем `next` из адресной строки и переходим.
    const back = rel(new URL(loginUrl, 'https://x.test').searchParams.get('next'));
    return `${BASE}${back}`;
  };

  const cases = [
    '/agent',
    '/memex-dex/agent',
    '/memex-dex/memex-dex/agent',
  ];

  for (const visited of cases) {
    it(`${visited} → префикс встречается один раз`, () => {
      const url = finalUrl(visited);

      expect(url).toBe('/memex-dex/agent');
      expect(url.match(/memex-dex/g)).toHaveLength(1);
    });
  }

  it('/terminal?token=abc#chart сохраняет параметры и якорь', () => {
    const url = finalUrl('/memex-dex/terminal?token=abc#chart');

    expect(url).toBe('/memex-dex/terminal?token=abc#chart');
    expect(url.match(/memex-dex/g)).toHaveLength(1);
  });

  it('цикл редиректа невозможен: корень не попадает в next', () => {
    /*
     * `withNext` отбрасывает корень. Иначе вход возвращал бы на
     * первый экран, тот снова отправлял бы на вход — и так далее.
     */
    expect(withNext('/login', rel('/memex-dex'))).toBe('/login');
  });
});
