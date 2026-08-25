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
import {
  favoriteKey as walletKey,
  toggleFavorite,
  parseFavoriteKey,
  favoritesSyncOf,
  favoritesRetryable,
  favoritesRetryDelay,
  visibleFavoriteKeys,
  shouldMergeGuestFavorites,
  mayClearGuestFavorites,
  FAVORITES_RETRY_DELAYS_MS,
  type FavoritesSync,
} from '@memex/core';
import { api, ApiError, AUTH_CHANGED_EVENT, hasToken } from './api';

export type { FavoritesSync } from '@memex/core';

/**
 * Ключ кошелька берётся из ядра, а не строится здесь.
 *
 * Его же строит сервер при записи. Своя копия правила рано или поздно
 * разошлась бы с серверной, и выглядело бы это как звезда, горящая
 * на одном экране и погасшая на другом для того же кошелька.
 */
export { favoriteKey as walletKey } from '@memex/core';

const GUEST_STORAGE_KEY = 'memex.favorites.guest';

/**
 * Ошибка запроса в состояние синхронизации.
 *
 * Само правило живёт в ядре и там же проверено: «что означает 401»
 * — это правило, а не разметка, и держать его внутри компонента
 * значило бы оставить непроверенным. Здесь только распаковка:
 * из чего достать код ответа.
 */
function syncStateOf(e: unknown): FavoritesSync {
  // Не `ApiError` — значит ответа не было вовсе: обрыв или таймаут.
  return favoritesSyncOf(e instanceof ApiError ? e.status : null);
}

interface FavoritesValue {
  /** Множество ключей. Проверка избранности — операция за O(1). */
  keys: ReadonlySet<string>;
  isFavorite: (chain: string, address: string) => boolean;
  toggle: (chain: string, address: string) => Promise<void>;
  isGuest: boolean;
  /** Схема базы ещё не обновлена — сервер не может хранить отметки. */
  serverUnavailable: boolean;
  /** Точное состояние синхронизации. */
  sync: FavoritesSync;
  /** Повторить синхронизацию вручную. Кнопка для человека. */
  resync: () => void;
  /** Повторов после сбоя уже сделано. Ноль — идёт первая попытка. */
  retries: number;
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

  const [sync, setSync] = useState<FavoritesSync>('idle');
  const [retries, setRetries] = useState(0);

  /*
   * Последний успешно полученный серверный набор.
   *
   * Держится отдельно от `keys` потому, что при сбое `keys`
   * пересобирается, а этот набор — нет. Прежний код при сбое ставил
   * `setKeys(new Set(guestKeys))`, то есть заменял уже показанные
   * серверные звёзды гостевым набором: на экране они гасли, хотя
   * на сервере никуда не делись. Для человека это неотличимо
   * от потери данных.
   */
  const serverKeys = useRef<ReadonlySet<string>>(new Set());

  /** Перенос гостевых отметок уже выполняется. Второй не нужен. */
  const merging = useRef<Promise<unknown> | null>(null);

  /** Ручка запланированного повтора: снимается при размонтировании. */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Внешний повод перечитать: кнопка, возврат сети, вкладка на виду. */
  const [resyncNonce, setResyncNonce] = useState(0);

  const resync = useCallback(() => {
    setRetries(0);
    setResyncNonce((n) => n + 1);
  }, []);

  /*
   * Появился ли токен.
   *
   * Прежде здесь стоял опрос `sessionStorage` раз в секунду. Он
   * работал, но был обходным путём: `sessionStorage` не рассылает
   * `storage` в той вкладке, где запись произошла. Теперь запись
   * токена сама объявляет о себе событием — общего контекста
   * авторизации в проекте нет, и заводить его ради одного раздела
   * значило бы переписать заодно `api.ts` и `role.ts`.
   *
   * `storage` оставлен: он приносит новости из других вкладок,
   * куда наше событие не долетает.
   */
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    const read = () => setHasSession(hasToken());

    read();

    window.addEventListener(AUTH_CHANGED_EVENT, read);
    window.addEventListener('storage', read);

    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, []);

  /*
   * Возврат связи и возврат внимания.
   *
   * Оба — бесплатные поводы попробовать снова, и оба точнее любого
   * таймера: человек вернулся к вкладке или сеть поднялась именно
   * сейчас. Повтор идёт только при временном сбое: перечитывать
   * после 403 или 401 значит ходить за отказом по расписанию.
   */
  useEffect(() => {
    if (!favoritesRetryable(sync)) return;

    const onBack = () => {
      if (document.visibilityState === 'visible') resync();
    };

    window.addEventListener('online', resync);
    document.addEventListener('visibilitychange', onBack);

    return () => {
      window.removeEventListener('online', resync);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [sync, resync]);

  // ── Загрузка и восстановление ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const guestKeys = readGuestKeys();

      /*
       * Авторизован человек или нет — определяет только сессия.
       *
       * Ответ сервера на это не влияет вовсе, и здесь была главная
       * ошибка: `catch` ставил `setIsGuest(true)`, поэтому любой
       * сбой `/wallets/favorites` — 403 без права, таймаут,
       * холодный старт Render — превращал вошедшего в гостя,
       * и «Мои подписки» предлагали ему войти.
       *
       * Комментарий рядом с тем `setIsGuest(true)` обещал ровно
       * обратное: «помним, что человек вошёл».
       */
      if (!hasSession) {
        if (!cancelled) {
          setIsGuest(true);
          setServerUnavailable(false);
          setSync('idle');
          serverKeys.current = new Set();
          setKeys(new Set(guestKeys));
        }
        return;
      }

      // Токен есть — человек вошёл. Это утверждение больше ничем
      // не отменяется.
      if (!cancelled) {
        setIsGuest(false);
        setSync('loading');
      }

      try {
        /*
         * Гостевые отметки переносятся в аккаунт до чтения списка,
         * иначе человек вошёл бы и увидел, что его звёзды пропали.
         *
         * Ровно один перенос: повторные загрузки — после сбоя,
         * после возврата вкладки, после нажатия кнопки — ждут первый,
         * а не отправляют свой. Сам перенос идемпотентен на сервере,
         * но десять одинаковых запросов подряд от одной страницы —
         * это дефект, даже если сервер их переживёт.
         *
         * Локальное хранилище очищается только после подтверждённого
         * успеха. Очистка до ответа при обрыве связи потеряла бы
         * отметки безвозвратно: на сервер они не доехали, а в браузере
         * их уже нет.
         */
        if (
          shouldMergeGuestFavorites({
            hasSession: true,
            guestCount: guestKeys.length,
            mergeInFlight: merging.current != null,
          })
        ) {
          merging.current = api('/wallets/favorites/merge', {
            method: 'POST',
            body: JSON.stringify({ items: guestKeys.map(parseKey) }),
          });
        }

        if (merging.current) {
          try {
            await merging.current;
            if (mayClearGuestFavorites(true)) writeGuestKeys([]);
          } finally {
            merging.current = null;
          }
        }

        const res = await api<FavoritesResponse>('/wallets/favorites');

        if (cancelled) return;

        const fresh = new Set(res.favorites.map((f) => walletKey(f.chain, f.address)));

        serverKeys.current = fresh;
        setServerUnavailable(res.available === false);
        setSync(res.available === false ? 'schema-missing' : 'ready');
        setRetries(0);
        setKeys(fresh);
      } catch (e) {
        if (cancelled) return;

        /*
         * Сбой синхронизации — это сбой синхронизации.
         *
         * Человек остаётся авторизованным, уже полученные серверные
         * отметки остаются на экране, гостевые не стираются. Ни одна
         * звезда не гаснет из-за того, что запрос не дошёл.
         */
        const next = syncStateOf(e);

        setSync(next);
        setServerUnavailable(next === 'schema-missing' || next === 'unavailable');
        setKeys(visibleFavoriteKeys({ serverKeys: serverKeys.current, guestKeys }));

        // Повтор — только для того, что само проходит, и конечное
        // число раз.
        const delay = favoritesRetryDelay(retries);

        if (favoritesRetryable(next) && delay != null) {
          retryTimer.current = setTimeout(() => {
            setRetries((n) => n + 1);
          }, delay);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
    // `retries` в зависимостях намеренно: его рост и есть запуск
    // очередной попытки. Отдельный эффект-планировщик делал бы
    // то же самое, но двумя местами вместо одного.
  }, [hasSession, resyncNonce, retries]);

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

        // Сервер подтвердил — запоминаем в серверном наборе, иначе
        // ближайший сбой синхронизации откатит отметку на экране,
        // хотя на сервере она уже сохранена.
        const confirmed = new Set(serverKeys.current);
        if (wasFavorite) confirmed.delete(key);
        else confirmed.add(key);
        serverKeys.current = confirmed;
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

        // Состояние синхронизации ведётся по тем же правилам, что
        // и при загрузке: одно место решает, что означает код.
        const next = syncStateOf(e);
        setSync(next);

        if (next === 'schema-missing') {
          setServerUnavailable(true);
          setError('Избранное на сервере пока недоступно — обновите схему базы');
        } else if (next === 'expired') {
          setError('Сессия истекла. Войдите снова, чтобы сохранять избранное');
        } else if (next === 'forbidden') {
          setError('Избранное недоступно на текущем тарифе');
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
      sync,
      resync,
      retries,
      error,
      clearError: () => setError(null),
      revision,
    }),
    [keys, isFavorite, toggle, isGuest, serverUnavailable, sync, resync, retries, error, revision],
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
      sync: 'idle',
      resync: () => undefined,
      retries: 0,
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
