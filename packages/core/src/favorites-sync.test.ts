import { describe, it, expect } from 'vitest';
import {
  favoritesSyncOf,
  favoritesRetryable,
  favoritesRetryDelay,
  visibleFavoriteKeys,
  shouldMergeGuestFavorites,
  mayClearGuestFavorites,
  FAVORITES_RETRY_DELAYS_MS,
} from './favorites-sync.js';

/**
 * Поведение избранного при сбоях.
 *
 * Дефект, ради которого это написано: любой отказ сервера приводил
 * к одному и тому же — человек становился гостем, а его серверные
 * звёзды гасли. «Мои подписки» предлагали войти тому, кто уже вошёл.
 */

describe('отказы различаются', () => {
  it('401 — истёкшая сессия, а не недоступность', () => {
    expect(favoritesSyncOf(401)).toBe('expired');
    // Ждать бесполезно: сервер отвечает по существу, нужен новый вход.
    expect(favoritesRetryable('expired')).toBe(false);
  });

  it('403 — отказ по тарифу', () => {
    expect(favoritesSyncOf(403)).toBe('forbidden');
    expect(favoritesRetryable('forbidden')).toBe(false);
  });

  it('503 — схема базы не обновлена', () => {
    expect(favoritesSyncOf(503)).toBe('schema-missing');
    // Отказ администратора: сам собой не пройдёт.
    expect(favoritesRetryable('schema-missing')).toBe(false);
  });

  it('500 — временный сбой, повтор уместен', () => {
    expect(favoritesSyncOf(500)).toBe('unavailable');
    expect(favoritesRetryable('unavailable')).toBe(true);
  });

  it('таймаут без ответа тоже временный', () => {
    expect(favoritesSyncOf(null)).toBe('unavailable');
    expect(favoritesSyncOf(undefined)).toBe('unavailable');
  });

  it('четыре разных случая дают четыре разных состояния', () => {
    const states = [401, 403, 500, 503].map(favoritesSyncOf);

    expect(new Set(states).size).toBe(4);
  });
});

describe('повторы конечны', () => {
  it('паузы растут', () => {
    const delays = FAVORITES_RETRY_DELAYS_MS;

    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('первая пауза учитывает холодный старт', () => {
    // Мгновенный повтор во время пробуждения Render бесполезен.
    expect(favoritesRetryDelay(0)!).toBeGreaterThanOrEqual(2_000);
  });

  it('после последней попытки повторов больше нет', () => {
    expect(favoritesRetryDelay(FAVORITES_RETRY_DELAYS_MS.length - 1)).not.toBeNull();
    expect(favoritesRetryDelay(FAVORITES_RETRY_DELAYS_MS.length)).toBeNull();
  });
});

describe('серверные отметки переживают сбой', () => {
  it('остаются видимыми при недоступном сервере', () => {
    const visible = visibleFavoriteKeys({
      serverKeys: ['SOLANA:aaa', 'SOLANA:bbb'],
      guestKeys: [],
    });

    // Прежде здесь ставился гостевой набор, и обе звезды гасли.
    expect(visible.has('SOLANA:aaa')).toBe(true);
    expect(visible.has('SOLANA:bbb')).toBe(true);
  });

  it('объединяются с локальными, а не замещаются ими', () => {
    const visible = visibleFavoriteKeys({
      serverKeys: ['SOLANA:aaa'],
      guestKeys: ['SOLANA:ccc'],
    });

    expect([...visible].sort()).toEqual(['SOLANA:aaa', 'SOLANA:ccc']);
  });

  it('одна и та же отметка с обеих сторон не двоится', () => {
    const visible = visibleFavoriteKeys({
      serverKeys: ['SOLANA:aaa'],
      guestKeys: ['SOLANA:aaa'],
    });

    expect(visible.size).toBe(1);
  });

  it('после восстановления показывается свежий серверный набор', () => {
    // Восстановление — это удачный ответ, и он даёт новый serverKeys.
    const afterRecovery = visibleFavoriteKeys({
      serverKeys: ['SOLANA:aaa', 'SOLANA:ccc'],
      guestKeys: [],
    });

    expect(afterRecovery.size).toBe(2);
  });
});

describe('перенос гостевых отметок', () => {
  it('выполняется один раз', () => {
    const first = shouldMergeGuestFavorites({
      hasSession: true,
      guestCount: 3,
      mergeInFlight: false,
    });

    // Второй вызов, пока первый в пути, не отправляет ничего.
    const second = shouldMergeGuestFavorites({
      hasSession: true,
      guestCount: 3,
      mergeInFlight: true,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('после успеха переносить нечего', () => {
    expect(
      shouldMergeGuestFavorites({ hasSession: true, guestCount: 0, mergeInFlight: false }),
    ).toBe(false);
  });

  it('гостю переносить некуда', () => {
    expect(
      shouldMergeGuestFavorites({ hasSession: false, guestCount: 3, mergeInFlight: false }),
    ).toBe(false);
  });

  it('локальное хранилище не очищается до подтверждения', () => {
    // Очистка до ответа при обрыве связи потеряла бы отметки
    // безвозвратно: на сервер они не доехали, а в браузере их уже нет.
    expect(mayClearGuestFavorites(false)).toBe(false);
    expect(mayClearGuestFavorites(true)).toBe(true);
  });
});
