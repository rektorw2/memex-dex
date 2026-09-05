import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useServerWakeup, isNetworkFailure } from './server-wakeup';

/**
 * Поведение при спящем сервере.
 *
 * Бесплатный сервис засыпает, и первый запрос ждёт до минуты.
 * Настоящее лечение — платный always-on план; здесь проверяется
 * другое: что эта минута не выглядит поломкой и что автоматический
 * повтор не превращается в пинговщик.
 */

const HEALTH = 'https://api.test/health';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Сервер, который отвечает после заданной задержки.
 *
 * До неё каждая попытка «обрывается» — ровно так ведёт себя запрос
 * к спящему сервису: соединение есть, ответа нет.
 */
function serverWakingAfter(ms: number) {
  const start = Date.now();
  return async () => {
    if (Date.now() - start < ms) throw new TypeError('Failed to fetch');
    return new Response('ok');
  };
}

describe('состояние при запуске сервера', () => {
  it('быстрый ответ не показывает объяснений', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));

    const { result } = renderHook(() => useServerWakeup(HEALTH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Подпись «запускаем сервер», мелькнувшая на 300 мс, только
    // тревожит: до порога не показывается ничего.
    expect(result.current.state).toBe('ready');
  });

  for (const seconds of [5, 15, 30, 60]) {
    it(`сервер, поднявшийся за ${seconds} с, доходит до готовности`, async () => {
      fetchMock.mockImplementation(serverWakingAfter(seconds * 1000));

      const { result } = renderHook(() => useServerWakeup(HEALTH));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      // Пока сервер молчит, человек видит объяснение, а не пустоту.
      expect(result.current.state).toBe('waking');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(seconds * 1000 + 30_000);
      });

      expect(result.current.state).toBe('ready');
    });
  }

  it('после исчерпания попыток предлагается ручной повтор', async () => {
    // Сервер не отвечает никогда.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useServerWakeup(HEALTH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    expect(result.current.state).toBe('unreachable');
  });

  it('повтор конечен: клиент не превращается в пинговщик', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderHook(() => useServerWakeup(HEALTH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400_000);
    });

    /*
     * Бесконечный повтор — это обход условий тарифа и помеха
     * поднимающемуся серверу. Попыток немного и они заканчиваются.
     */
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('паузы между попытками растут', async () => {
    const times: number[] = [];
    fetchMock.mockImplementation(async () => {
      times.push(Date.now());
      throw new TypeError('Failed to fetch');
    });

    renderHook(() => useServerWakeup(HEALTH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    // Первая пауза меньше последней: постоянный интервал бил бы
    // по серверу ровно тогда, когда он занят запуском.
    expect(gaps[0]!).toBeLessThan(gaps[gaps.length - 1]!);
  });

  it('выключенная проверка не ходит в сеть', async () => {
    renderHook(() => useServerWakeup(HEALTH, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('любой ответ сервера считается пробуждением', async () => {
    // Нас интересует, проснулся ли он, а не что он думает об адресе.
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));

    const { result } = renderHook(() => useServerWakeup(HEALTH));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.state).toBe('ready');
  });
});

describe('сбой связи отличается от ответа сервера', () => {
  it('обрыв связи — сбой', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFailure({ name: 'NetworkError' })).toBe(true);
    expect(isNetworkFailure({ name: 'AbortError' })).toBe(true);
  });

  for (const status of [401, 403, 409, 422]) {
    it(`${status} — это ответ, а не сбой`, () => {
      /*
       * Самая частая ошибка в такой логике, и путается она молча.
       * Запрос дошёл и был рассмотрен: повторять его бессмысленно,
       * а для регистрации ещё и опасно.
       */
      expect(isNetworkFailure({ name: 'ApiError', status })).toBe(false);
    });
  }

  it('код состояния решает, даже если имя ошибки сетевое', () => {
    /*
     * Самый коварный случай: обёртка над fetch может сохранить имя
     * `TypeError`, но при этом нести код ответа. Если полагаться
     * только на имя, отказ сервера будет повторён автоматически —
     * а для регистрации это второй аккаунт.
     */
    expect(isNetworkFailure({ name: 'TypeError', status: 409 })).toBe(false);
    expect(isNetworkFailure({ name: 'NetworkError', status: 401 })).toBe(false);
    expect(isNetworkFailure({ name: 'AbortError', status: 422 })).toBe(false);
    // Без кода состояния — по-прежнему сбой связи.
    expect(isNetworkFailure({ name: 'TypeError' })).toBe(true);
  });

  it('пустое значение сбоем не считается', () => {
    expect(isNetworkFailure(null)).toBe(false);
    expect(isNetworkFailure(undefined)).toBe(false);
    expect(isNetworkFailure('строка')).toBe(false);
  });
});
