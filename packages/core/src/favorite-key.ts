/**
 * Ключ избранного кошелька.
 *
 * Вынесено в ядро потому, что ключ строят три стороны: сервер при
 * записи, браузер при показе звезды и локальное хранилище гостя.
 * Пока каждая строила его сама, расхождение было вопросом времени —
 * а проявилось бы оно как звезда, горящая на одном экране и погасшая
 * на другом для того же кошелька.
 *
 * Правило одно и простое: кошелёк — это сеть плюс нормализованный
 * адрес. Один и тот же набор символов в Ethereum и BNB Chain
 * принадлежит разным владельцам, и склеивать их значит показывать
 * человеку чужую историю сделок под видом его наблюдения.
 */

import { normalizeAddress, type ChainKey } from './token-registry.js';

export interface FavoriteRef {
  chain: string;
  address: string;
}

/** Ключ вида `СЕТЬ:адрес`. */
export function favoriteKey(chain: string, address: string): string {
  return `${chain}:${normalizeAddress(chain as ChainKey, address)}`;
}

/**
 * Ключ обратно в пару.
 *
 * Разделитель ищется первым вхождением: адрес двоеточия не содержит,
 * а имя сети — тем более.
 */
export function parseFavoriteKey(key: string): FavoriteRef {
  const index = key.indexOf(':');

  if (index < 0) return { chain: '', address: key };

  return { chain: key.slice(0, index), address: key.slice(index + 1) };
}

/**
 * Набор ключей без повторов.
 *
 * Один и тот же адрес попадает в локальный список дважды чаще, чем
 * кажется: из ленты он приходит в одном регистре, из карточки —
 * в другом, и без нормализации это две разные строки.
 */
export function uniqueFavorites(refs: FavoriteRef[]): FavoriteRef[] {
  const seen = new Map<string, FavoriteRef>();

  for (const ref of refs) {
    const key = favoriteKey(ref.chain, ref.address);
    if (!seen.has(key)) seen.set(key, parseFavoriteKey(key));
  }

  return [...seen.values()];
}

/**
 * Переключение отметки.
 *
 * Чистая функция над множеством: именно она проверяется тестами,
 * а не поведение кнопки. Возвращает новое множество, чтобы React
 * увидел изменение.
 */
export function toggleFavorite(
  keys: ReadonlySet<string>,
  chain: string,
  address: string,
): { next: Set<string>; added: boolean } {
  const key = favoriteKey(chain, address);
  const next = new Set(keys);

  if (next.has(key)) {
    next.delete(key);
    return { next, added: false };
  }

  next.add(key);
  return { next, added: true };
}
