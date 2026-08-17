'use client';

/**
 * Избранные кошельки: единое состояние на всё приложение.
 *
 * Общий контекст, а не запрос в каждом компоненте. Причина простая:
 * звезда стоит в трёх местах — в списке кошельков, в карточке
 * и в ленте активности, — и все три обязаны показывать одно и то же.
 * Отдельные запросы дали бы три источника правды, которые
 * расходятся ровно в тот момент, когда человек нажал на звезду
 * в одном из них.
 *
 * Второе соображение — стоимость. Лента обновляется раз в двадцать
 * секунд и содержит до полусотни строк. Спрашивать про избранность
 * каждой строки значит делать полсотни запросов каждые двадцать
 * секунд. Здесь весь набор берётся один раз и лежит множеством
 * ключей.
 *
 * Гость тоже может отмечать кошельки. Запрещать это до входа значит
 * требовать регистрацию прежде, чем человек понял, зачем она ему.
 * Отметки живут в браузере и переносятся в аккаунт при входе.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { favoriteKey as walletKey, toggleFavorite, parseFavoriteKey } from '@memex/core';
import { api, ApiError } from './api';

/**
 * Ключ кошелька берётся из ядра, а не строится здесь.
 *
 * Его же строит сервер при записи. Своя копия правила рано или поздно
 * разошлась бы с серверной, и выглядело бы это как звезда, горящая
 * на одном экране и погасшая на другом для того же кошелька.
 */
export { favoriteKey as walletKey } from '@memex/core';

const GUEST_STORAGE_KEY = 'memex.favorites.guest';

interface FavoritesValue {
  /** Множество ключей. Проверка избранности — операция за O(1). */
  keys: ReadonlySet<string>;
  isFavorite: (chain: string, address: string) => boolean;
  toggle: (chain: string, address: string) => Promise<void>;
  isGuest: boolean;
  /** Схема базы ещё не обновлена — сервер не может хранить отметки. */
  serverUnavailable: boolean;
  error: string | null;
  clearError: () => void;
  /** Счётчик изменений: по нему обновляется список подписок. */
  revision: number;
}

const FavoritesContext = createContext<FavoritesValue | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [isGuest, setIsGuest] = useState(true);
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  /**
   * Запросы, уже отправленные по каждому ключу.
   *
   * Быстрое двойное нажатие иначе отправило бы два запроса, и порядок
   * их выполнения решал бы итог. Здесь второй запрос по тому же ключу
   * ждёт первого.
   */
  const inFlight = useRef(new Map<string, Promise<unknown>>());

  // ── Начальная загрузка ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const guestKeys = readGuestKeys();

      // Гость и вошедший различаются по наличию токена, а не по
      // ответу сервера: неудачный запрос не должен молча превращать
      // вошедшего в гостя и терять его серверные отметки.
      const token =
        typeof window !== 'undefined' ? sessionStorage.getItem('accessToken') : null;

      if (!token) {
        if (!cancelled) {
          setIsGuest(true);
          setKeys(new Set(guestKeys));
        }
        return;
      }

      try {
        // Гостевые отметки переносятся в аккаунт до чтения списка,
        // иначе человек вошёл бы и увидел, что его звёзды пропали.
        if (guestKeys.length > 0) {
          await api('/wallets/favorites/merge', {
            method: 'POST',
            body: JSON.stringify({ items: guestKeys.map(parseKey) }),
          }).catch(() => undefined);

          writeGuestKeys([]);
        }

        const res = await api<FavoritesResponse>('/wallets/favorites');

        if (cancelled) return;

        setIsGuest(false);
        setServerUnavailable(res.available === false);
        setKeys(new Set(res.favorites.map((f) => walletKey(f.chain, f.address))));
      } catch (e) {
        if (cancelled) return;

        // Сервер недоступен — работаем как гость, но помним, что
        // человек вошёл: его отметки на сервере никуда не делись.
        setIsGuest(true);
        setKeys(new Set(guestKeys));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const isFavorite = useCallback(
    (chain: string, address: string) => keys.has(walletKey(chain, address)),
    [keys],
  );

  /**
   * Переключение.
   *
   * Состояние меняется сразу, до ответа сервера: ожидание сети
   * в ответ на нажатие звезды воспринимается как «не сработало»,
   * и человек нажимает второй раз. При отказе состояние возвращается
   * ровно к тому, что было.
   */
  const toggle = useCallback(
    async (chain: string, address: string) => {
      const key = walletKey(chain, address);

      // Запрос по этому кошельку уже в пути — ждём его, а не
      // отправляем второй.
      const pending = inFlight.current.get(key);
      if (pending) {
        await pending.catch(() => undefined);
        return;
      }

      const wasFavorite = keys.has(key);
      const { next } = toggleFavorite(keys, chain, address);

      setKeys(next);
      setRevision((r) => r + 1);
      setError(null);

      if (isGuest) {
        writeGuestKeys([...next]);
        return;
      }

      const [c, a] = splitKey(key);
      const request = api(`/wallets/favorites/${c}/${encodeURIComponent(a)}`, {
        method: wasFavorite ? 'DELETE' : 'PUT',
      });

      inFlight.current.set(key, request);

      try {
        await request;
      } catch (e) {
        // Откат к прежнему состоянию: показывать звезду
        // загоревшейся, когда сервер её не сохранил, — значит
        // обещать то, чего нет.
        setKeys((current) => {
          const rolled = new Set(current);
          if (wasFavorite) rolled.add(key);
          else rolled.delete(key);
          return rolled;
        });
        setRevision((r) => r + 1);

        if (e instanceof ApiError && e.status === 503) {
          setServerUnavailable(true);
          setError('Избранное на сервере пока недоступно — обновите схему базы');
        } else if (e instanceof ApiError && e.status === 401) {
          setError('Войдите, чтобы сохранять избранное в аккаунте');
        } else {
          setError('Не удалось сохранить. Попробуйте ещё раз');
        }
      } finally {
        inFlight.current.delete(key);
      }
    },
    [keys, isGuest],
  );

  const value = useMemo<FavoritesValue>(
    () => ({
      keys,
      isFavorite,
      toggle,
      isGuest,
      serverUnavailable,
      error,
      clearError: () => setError(null),
      revision,
    }),
    [keys, isFavorite, toggle, isGuest, serverUnavailable, error, revision],
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

/**
 * Доступ к избранному.
 *
 * Вне провайдера возвращает безопасную заглушку, а не бросает
 * исключение: звезда — украшение экрана, и её отсутствие не повод
 * ронять всю страницу.
 */
export function useFavorites(): FavoritesValue {
  const ctx = useContext(FavoritesContext);

  return (
    ctx ?? {
      keys: new Set<string>(),
      isFavorite: () => false,
      toggle: async () => undefined,
      isGuest: true,
      serverUnavailable: false,
      error: null,
      clearError: () => undefined,
      revision: 0,
    }
  );
}

// ─────────────────────────── Гостевое хранилище ─────────────────────────────

interface FavoritesResponse {
  available: boolean;
  requiredAction: string | null;
  favorites: Array<{ chain: string; address: string }>;
}

function readGuestKeys(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(GUEST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];

    // Чужие данные под нашим ключом — повод вернуть пустой список,
    // а не уронить приложение при разборе.
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeGuestKeys(keys: string[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Переполненное или запрещённое хранилище: отметка не переживёт
    // перезагрузку, но текущий сеанс работает.
  }
}

/** Ключ обратно в пару. Адрес может содержать двоеточие только в теории. */
function splitKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

function parseKey(key: string): { chain: string; address: string } {
  return parseFavoriteKey(key);
}
