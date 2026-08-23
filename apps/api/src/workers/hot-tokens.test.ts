import { describe, it, expect, beforeEach } from 'vitest';
import {
  markHot,
  markHotFromList,
  listMarkBudgetLeft,
  hotTokens,
  isHot,
  hotCount,
  resetHotTokensForTests,
  HOT_LIMIT,
  HOT_TTL_MS,
  LIST_HOT_LIMIT,
  LIST_MARK_BUDGET_PER_MIN,
} from './hot-tokens.js';

/**
 * Кто ждёт ответа прямо сейчас.
 *
 * Один список на свечи, цены и проверку. Три отдельных множества
 * разошлись бы при первой правке: открытый токен получал бы свежие
 * свечи и вчерашнюю цену.
 */

const NOW = Date.parse('2026-08-23T12:00:00Z');

beforeEach(() => resetHotTokensForTests());

describe('метка', () => {
  it('открытый токен становится горячим', () => {
    markHot('wif', NOW);
    expect(isHot('wif', NOW)).toBe(true);
  });

  it('неоткрытый — нет', () => {
    expect(isHot('bonk', NOW)).toBe(false);
  });

  it('самый свежий запрос идёт первым', () => {
    // Ждёт тот, кто открыл последним.
    markHot('a', NOW);
    markHot('b', NOW + 1);

    expect(hotTokens(NOW + 2)[0]).toBe('b');
  });
});

describe('срок жизни', () => {
  it('метка гаснет без обновления', () => {
    /*
     * Уйти со страницы браузер нам не сообщает. Без срока токен
     * оставался бы горячим вечно, и «горячим» стало бы всё,
     * то есть ничего.
     */
    markHot('wif', NOW);

    expect(isHot('wif', NOW + HOT_TTL_MS)).toBe(true);
    expect(isHot('wif', NOW + HOT_TTL_MS + 1)).toBe(false);
  });

  it('повторный запрос продлевает метку', () => {
    // Пока человек смотрит, клиент опрашивает сервер и продлевает
    // метку сам.
    markHot('wif', NOW);
    markHot('wif', NOW + HOT_TTL_MS - 1);

    expect(isHot('wif', NOW + HOT_TTL_MS + 10)).toBe(true);
  });

  it('протухшие не попадают в список', () => {
    markHot('old', NOW);
    markHot('fresh', NOW + HOT_TTL_MS);

    expect(hotTokens(NOW + HOT_TTL_MS + 1)).toEqual(['fresh']);
  });

  it('счётчик считает только живые метки', () => {
    markHot('old', NOW);
    expect(hotCount(NOW + HOT_TTL_MS + 1)).toBe(0);
  });
});

describe('предел размера', () => {
  it('список не раздувается', () => {
    // Иначе его наполнит кто угодно, открывая карточки подряд.
    for (let i = 0; i < HOT_LIMIT + 20; i++) markHot(`t-${i}`, NOW + i);

    expect(hotCount(NOW + HOT_LIMIT + 20)).toBe(HOT_LIMIT);
  });

  it('при переполнении вытесняется самый давний', () => {
    for (let i = 0; i < HOT_LIMIT; i++) markHot(`t-${i}`, NOW + i);
    markHot('newcomer', NOW + HOT_LIMIT);

    expect(isHot('t-0', NOW + HOT_LIMIT)).toBe(false);
    expect(isHot('newcomer', NOW + HOT_LIMIT)).toBe(true);
  });

  it('повторный запрос спасает от вытеснения', () => {
    for (let i = 0; i < HOT_LIMIT; i++) markHot(`t-${i}`, NOW + i);

    // Токен снова спросили — он больше не самый давний.
    markHot('t-0', NOW + HOT_LIMIT);
    markHot('newcomer', NOW + HOT_LIMIT + 1);

    expect(isHot('t-0', NOW + HOT_LIMIT + 1)).toBe(true);
    expect(isHot('t-1', NOW + HOT_LIMIT + 1)).toBe(false);
  });
});

describe('отметка из серверного списка', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `t-${i}`);

  it('показанные токены становятся горячими', () => {
    markHotFromList(['a', 'b'], NOW);

    expect(isHot('a', NOW)).toBe(true);
    expect(isHot('b', NOW)).toBe(true);
  });

  it('помечается только начало выдачи', () => {
    /*
     * Ответ отдаёт до двухсот токенов, на экране помещается десяток.
     * Пометить все двести значит вытеснить открытые карточки
     * и объявить горячим полкаталога.
     */
    const marked = markHotFromList(list(200), NOW);

    expect(marked).toBe(LIST_HOT_LIMIT);
    expect(hotCount(NOW)).toBe(LIST_HOT_LIMIT);
  });

  it('дубликаты не тратят двойную квоту', () => {
    // Один токен в двух списках — одна отметка.
    expect(markHotFromList(['a', 'a', 'a'], NOW)).toBe(1);
  });

  it('пустой список ничего не делает', () => {
    expect(markHotFromList([], NOW)).toBe(0);
    expect(hotCount(NOW)).toBe(0);
  });

  it('повторная загрузка продлевает только показанное', () => {
    markHotFromList(['visible', 'scrolled-away'], NOW);

    // Второй ответ содержит другой набор: список отсортировался иначе.
    markHotFromList(['visible'], NOW + HOT_TTL_MS - 1);

    expect(isHot('visible', NOW + HOT_TTL_MS + 10)).toBe(true);
    expect(isHot('scrolled-away', NOW + HOT_TTL_MS + 10)).toBe(false);
  });

  it('срок жизни тот же, что у открытой карточки', () => {
    markHotFromList(['a'], NOW);
    expect(isHot('a', NOW + HOT_TTL_MS + 1)).toBe(false);
  });
});

describe('бюджет отметок', () => {
  it('публичный клиент не может греть каталог бесконечно', () => {
    /*
     * Без предела публичный маршрут превращается в способ заставить
     * нас опрашивать провайдера по всей витрине: достаточно
     * перебирать страницы и сортировки.
     */
    let marked = 0;
    for (let page = 0; page < 100; page++) {
      marked += markHotFromList(
        Array.from({ length: 12 }, (_, i) => `p${page}-${i}`),
        NOW,
      );
    }

    expect(marked).toBe(LIST_MARK_BUDGET_PER_MIN);
  });

  it('исчерпанный бюджет отклоняет дальнейшие отметки', () => {
    for (let page = 0; page < 100; page++) {
      markHotFromList(
        Array.from({ length: 12 }, (_, i) => `p${page}-${i}`),
        NOW,
      );
    }

    expect(listMarkBudgetLeft(NOW)).toBe(0);
    expect(markHotFromList(['fresh'], NOW)).toBe(0);
    expect(isHot('fresh', NOW)).toBe(false);
  });

  it('бюджет восстанавливается через минуту', () => {
    // Предел защищает от злоупотребления, а не запрещает работу.
    for (let page = 0; page < 100; page++) {
      markHotFromList(
        Array.from({ length: 12 }, (_, i) => `p${page}-${i}`),
        NOW,
      );
    }

    expect(markHotFromList(['later'], NOW + 60_001)).toBe(1);
  });

  it('открытая карточка бюджетом списков не ограничена', () => {
    /*
     * Прямое обращение к карточке — это уже одно обращение к серверу
     * на один токен, и ограничивать его тем же счётчиком незачем:
     * злоупотребление здесь ловится обычным rate limit, а не квотой
     * на отметки.
     */
    for (let page = 0; page < 100; page++) {
      markHotFromList(
        Array.from({ length: 12 }, (_, i) => `p${page}-${i}`),
        NOW,
      );
    }

    markHot('opened', NOW);
    expect(isHot('opened', NOW)).toBe(true);
  });

  it('размер горячего списка остаётся в пределах', () => {
    // Бюджет разрешает больше отметок, чем вмещает список: вытеснение
    // обязано работать и здесь.
    for (let page = 0; page < 100; page++) {
      markHotFromList(
        Array.from({ length: 12 }, (_, i) => `p${page}-${i}`),
        NOW,
      );
    }

    expect(hotCount(NOW)).toBeLessThanOrEqual(HOT_LIMIT);
  });
});
