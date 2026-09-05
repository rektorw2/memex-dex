'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Пробуждение спящего сервера.
 *
 * Бесплатный сервис засыпает после простоя, и первый запрос ждёт
 * до минуты. Настоящее лечение — платный always-on план, и оно
 * подготовлено в `render.yaml`. Здесь решается другая задача: сделать
 * так, чтобы эта минута не выглядела поломкой.
 *
 * Разница важна. Человек, впервые открывший продукт, видит форму,
 * которая не отвечает, и уходит — не потому, что продукт плохой, а
 * потому, что не понял, что происходит. Одна честная строка «сервер
 * запускается» удерживает его лучше любого ускорения.
 *
 * Чего здесь намеренно нет: постоянного пинга и фонового цикла,
 * поддерживающего сервис живым. Это обход условий тарифа, а не
 * решение — и он всё равно не спасает от холодного старта после
 * выкладки.
 */

export type WakeupState =
  /** Ещё не проверяли. */
  | 'idle'
  /** Первый запрос ушёл, ответа пока нет. */
  | 'checking'
  /** Ответ долго не приходит — вероятно, сервер поднимается. */
  | 'waking'
  /** Сервер ответил. */
  | 'ready'
  /** Не дозвонились за отведённые попытки. Доступен ручной повтор. */
  | 'unreachable';

/**
 * Порог, после которого молчание объясняется человеку.
 *
 * До него ничего не показывается: подпись «запускаем сервер»,
 * мелькнувшая на 300 мс, только тревожит.
 */
const EXPLAIN_AFTER_MS = 1_200;

/**
 * Паузы между попытками.
 *
 * Растущие и конечные. Бесконечный повтор превращает клиента в тот
 * самый пинговщик, которого мы не делаем, и мешает серверу
 * подниматься.
 *
 * Сумма подобрана под самый долгий наблюдаемый холодный старт.
 * Первая версия давала 43 секунды — и сервер, поднявшийся за
 * шестьдесят, до готовности не доходил: человек видел «не отвечает»
 * ровно в тот момент, когда сервер уже работал. Здесь около
 * восьмидесяти трёх секунд, с запасом.
 */
const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 20_000, 20_000] as const;

/** Таймаут одной попытки. Больше — и человек ждёт молча. */
const ATTEMPT_TIMEOUT_MS = 12_000;

export interface Wakeup {
  state: WakeupState;
  /** Сколько попыток уже сделано. Для отладки и тестов. */
  attempts: number;
  /** Повтор по нажатию. Разрешён всегда. */
  retry: () => void;
}

/**
 * Проверка доступности сервера при открытии онбординга.
 *
 * Метод `GET` и только он: повторять чтение безопасно, и именно
 * поэтому автоматический повтор здесь допустим. Ни регистрация,
 * ни вход сюда не попадают.
 */
export function useServerWakeup(healthUrl: string, enabled = true): Wakeup {
  const [state, setState] = useState<WakeupState>('idle');
  const [attempts, setAttempts] = useState(0);
  const [round, setRound] = useState(0);
  const cancelled = useRef(false);

  const run = useCallback(async () => {
    cancelled.current = false;
    setState('checking');
    setAttempts(0);

    const explainTimer = setTimeout(() => {
      // Только если ответа всё ещё нет.
      setState((current) => (current === 'checking' ? 'waking' : current));
    }, EXPLAIN_AFTER_MS);

    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (cancelled.current) return;
      if (BACKOFF_MS[attempt] > 0) await sleep(BACKOFF_MS[attempt]!);
      if (cancelled.current) return;

      setAttempts(attempt + 1);

      const ok = await probe(healthUrl);
      if (cancelled.current) return;

      if (ok) {
        clearTimeout(explainTimer);
        setState('ready');
        return;
      }
    }

    clearTimeout(explainTimer);
    setState('unreachable');
  }, [healthUrl]);

  useEffect(() => {
    if (!enabled) return;
    void run();
    return () => {
      cancelled.current = true;
    };
  }, [enabled, run, round]);

  const retry = useCallback(() => {
    cancelled.current = true;
    setRound((r) => r + 1);
  }, []);

  return { state, attempts, retry };
}

/**
 * Одна попытка достучаться.
 *
 * Любой ответ сервера считается успехом, включая ошибочный: нас
 * интересует, проснулся ли он, а не что он думает о конкретном
 * адресе. Неудачей считается только отсутствие ответа.
 */
async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

  try {
    await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    return true;
  } catch {
    // Сюда попадают обрыв связи и истёкший таймаут — и только они.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Можно ли повторить запрос сам, без участия человека.
 *
 * Ответ сервера — это ответ, а не сбой связи. `401`, `403`, `409` и
 * `422` означают, что запрос дошёл и был рассмотрен: повторять его
 * бессмысленно, а для регистрации ещё и опасно.
 *
 * Функция вынесена отдельно, потому что путать эти два случая —
 * самая частая ошибка в такой логике, и путается она молча.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const named = error as { name?: unknown; status?: unknown };
  // Ответ с кодом состояния — это ответ, каким бы он ни был.
  if (typeof named.status === 'number') return false;

  return named.name === 'NetworkError' || named.name === 'AbortError' || named.name === 'TypeError';
}
