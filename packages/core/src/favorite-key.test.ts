/**
 * Ключ избранного.
 *
 * Проверяется главным образом одно: одинаковый набор символов
 * в разных сетях — разные кошельки, а один и тот же адрес в разном
 * регистре в EVM — один. Ошибка в любую сторону видна человеку как
 * звезда, которая горит на одном экране и не горит на другом.
 */

import { describe, it, expect } from 'vitest';
import {
  favoriteKey,
  parseFavoriteKey,
  uniqueFavorites,
  toggleFavorite,
} from './favorite-key.js';

const EVM = '0xBD57A3C017B340AEC66C0762E5AC626363DF79BC';
const SOL = 'HN7cABqLq46Es1jh92dQQpjPnKUiRVMPzZ6PjMuU5FYr';

describe('нормализация адреса', () => {
  it('EVM приводится к нижнему регистру', () => {
    // В EVM регистр несёт лишь контрольную сумму, и один кошелёк
    // встречается записанным по-разному.
    expect(favoriteKey('ETHEREUM', EVM)).toBe(`ETHEREUM:${EVM.toLowerCase()}`);
  });

  it('EVM в разном регистре даёт один ключ', () => {
    expect(favoriteKey('BNB', EVM)).toBe(favoriteKey('BNB', EVM.toLowerCase()));
  });

  it('Solana сохраняет регистр', () => {
    // Там регистр значим: приведение сделало бы адрес другим,
    // и отметка указывала бы на несуществующий кошелёк.
    expect(favoriteKey('SOLANA', SOL)).toBe(`SOLANA:${SOL}`);
    expect(favoriteKey('SOLANA', SOL)).not.toBe(favoriteKey('SOLANA', SOL.toLowerCase()));
  });

  it('пробелы по краям не создают второй ключ', () => {
    expect(favoriteKey('SOLANA', `  ${SOL}  `)).toBe(favoriteKey('SOLANA', SOL));
  });
});

describe('сеть входит в ключ', () => {
  it('один адрес в разных сетях — разные кошельки', () => {
    // Один и тот же набор символов в Ethereum и BNB Chain
    // принадлежит разным владельцам. Склеить их значит показать
    // человеку чужую историю сделок.
    expect(favoriteKey('ETHEREUM', EVM)).not.toBe(favoriteKey('BNB', EVM));
  });

  it('ключ разбирается обратно без потерь', () => {
    const ref = parseFavoriteKey(favoriteKey('BASE', EVM));

    expect(ref.chain).toBe('BASE');
    expect(ref.address).toBe(EVM.toLowerCase());
  });

  it('строка без разделителя не роняет разбор', () => {
    expect(parseFavoriteKey('мусор')).toEqual({ chain: '', address: 'мусор' });
  });
});

describe('переключение', () => {
  it('добавляет, когда отметки не было', () => {
    const { next, added } = toggleFavorite(new Set(), 'BNB', EVM);

    expect(added).toBe(true);
    expect(next.has(favoriteKey('BNB', EVM))).toBe(true);
  });

  it('удаляет, когда отметка была', () => {
    const start = new Set([favoriteKey('BNB', EVM)]);
    const { next, added } = toggleFavorite(start, 'BNB', EVM);

    expect(added).toBe(false);
    expect(next.size).toBe(0);
  });

  it('повторное добавление не создаёт второй записи', () => {
    let keys: Set<string> = new Set();

    keys = toggleFavorite(keys, 'BNB', EVM).next;
    keys = toggleFavorite(keys, 'BNB', EVM).next; // убрали
    keys = toggleFavorite(keys, 'BNB', EVM).next; // вернули

    expect(keys.size).toBe(1);
  });

  it('добавление в другом регистре не создаёт второй записи', () => {
    let keys: Set<string> = new Set([favoriteKey('BNB', EVM)]);
    keys = toggleFavorite(keys, 'BNB', EVM.toLowerCase()).next;

    // Тот же кошелёк — значит снятие отметки, а не вторая запись.
    expect(keys.size).toBe(0);
  });

  it('повторное удаление не ошибка', () => {
    let keys: Set<string> = new Set();

    keys = toggleFavorite(keys, 'BNB', EVM).next;
    keys = toggleFavorite(keys, 'BNB', EVM).next;
    keys = toggleFavorite(keys, 'BNB', EVM).next;
    keys = toggleFavorite(keys, 'BNB', EVM).next;

    expect(keys.size).toBe(0);
  });

  it('исходное множество не изменяется', () => {
    // React увидит изменение только по новой ссылке; правка
    // на месте оставила бы экран непереключённым.
    const start = new Set<string>();
    const { next } = toggleFavorite(start, 'BNB', EVM);

    expect(start.size).toBe(0);
    expect(next).not.toBe(start);
  });

  it('соседние кошельки не задеваются', () => {
    let keys: Set<string> = new Set([favoriteKey('SOLANA', SOL)]);
    keys = toggleFavorite(keys, 'BNB', EVM).next;

    expect(keys.size).toBe(2);

    keys = toggleFavorite(keys, 'BNB', EVM).next;

    expect(keys.has(favoriteKey('SOLANA', SOL))).toBe(true);
  });
});

describe('слияние списков', () => {
  it('повторы схлопываются', () => {
    const merged = uniqueFavorites([
      { chain: 'BNB', address: EVM },
      { chain: 'BNB', address: EVM.toLowerCase() },
      { chain: 'BNB', address: `  ${EVM}  ` },
    ]);

    expect(merged).toHaveLength(1);
  });

  it('разные сети остаются раздельными', () => {
    const merged = uniqueFavorites([
      { chain: 'BNB', address: EVM },
      { chain: 'ETHEREUM', address: EVM },
    ]);

    expect(merged).toHaveLength(2);
  });

  it('адреса возвращаются уже нормализованными', () => {
    const merged = uniqueFavorites([{ chain: 'BASE', address: EVM }]);

    expect(merged[0]!.address).toBe(EVM.toLowerCase());
  });

  it('пустой список остаётся пустым', () => {
    expect(uniqueFavorites([])).toEqual([]);
  });
});
