'use client';

/**
 * Избранные токены.
 *
 * Это отдельное состояние от избранных кошельков. Контракт токена
 * технически тоже адрес, но добавление его в WalletFavorite запустило
 * бы интерфейс наблюдения за кошельком и смешало две разные сущности.
 *
 * Пока список хранится в браузере. Такой первый слой работает и у
 * гостя, не требует новой миграции боевой базы и легко переносится
 * в серверную таблицу позднее без изменения интерфейса компонента.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { favoriteKey, toggleFavorite } from '@memex/core';

const STORAGE_KEY = 'memex.token-favorites.v1';

interface TokenFavoritesValue {
  keys: ReadonlySet<string>;
  isFavorite: (chain: string, address: string) => boolean;
  toggle: (chain: string, address: string) => void;
}

const TokenFavoritesContext = createContext<TokenFavoritesValue | null>(null);

export function TokenFavoritesProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setKeys(readKeys());

    // Две одновременно открытые вкладки терминала не должны показывать
    // разное состояние одной и той же звезды.
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setKeys(readKeys());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const isFavorite = useCallback(
    (chain: string, address: string) => keys.has(favoriteKey(chain, address)),
    [keys],
  );

  const toggle = useCallback((chain: string, address: string) => {
    setKeys((current) => {
      const next = toggleFavorite(current, chain, address).next;
      writeKeys(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ keys, isFavorite, toggle }), [keys, isFavorite, toggle]);

  return (
    <TokenFavoritesContext.Provider value={value}>
      {children}
    </TokenFavoritesContext.Provider>
  );
}

export function useTokenFavorites(): TokenFavoritesValue {
  return (
    useContext(TokenFavoritesContext) ?? {
      keys: new Set<string>(),
      isFavorite: () => false,
      toggle: () => undefined,
    }
  );
}

function readKeys(): Set<string> {
  if (typeof window === 'undefined') return new Set();

  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeKeys(keys: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // В приватном режиме запись может быть запрещена. Звезда всё равно
    // работает до перезагрузки благодаря состоянию React.
  }
}
