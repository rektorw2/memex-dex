/**
 * Словари типов кошельков.
 *
 * Главный тест здесь — тот, что доказывает: словари разные.
 * Ошибка «взять один enum на оба эндпоинта» не даёт ни исключения,
 * ни расхождения в числах. Она молча меняет подпись под адресами,
 * и обнаруживается только тогда, когда кто-то повторил сделку
 * за «умными деньгами», оказавшимися снайпером.
 */

import { describe, it, expect } from 'vitest';
import {
  walletCategoryFromSignalList,
  walletCategoryFromLeaderboard,
  signalListWalletType,
  leaderboardWalletType,
  isCopyable,
  isAdverse,
  WALLET_CATEGORY_LABEL,
  type WalletCategory,
} from './okx-wallet-type.js';

describe('словари не совпадают', () => {
  it('единица означает разное в двух эндпоинтах', () => {
    // Latest Signal List: 1 = Smart Money
    // Leaderboard:        1 = KOL
    expect(walletCategoryFromSignalList('1')).toBe('smart_money');
    expect(walletCategoryFromLeaderboard('1')).toBe('kol');
  });

  it('тройка означает разное в двух эндпоинтах', () => {
    // Latest Signal List: 3 = Whale
    // Leaderboard:        3 = Smart Money
    expect(walletCategoryFromSignalList('3')).toBe('whale');
    expect(walletCategoryFromLeaderboard('3')).toBe('smart_money');
  });

  it('двойка означает разное в двух эндпоинтах', () => {
    expect(walletCategoryFromSignalList('2')).toBe('kol');
    expect(walletCategoryFromLeaderboard('2')).toBe('developer');
  });

  it('первые три кода не совпадают ни в одной позиции', () => {
    // Если этот тест когда-нибудь пройдёт «совпадением», значит
    // один из словарей переписали с чужого.
    for (const code of ['1', '2', '3']) {
      expect(walletCategoryFromSignalList(code)).not.toBe(
        walletCategoryFromLeaderboard(code),
      );
    }
  });
});

describe('разбор кодов сигналов', () => {
  it('три известных значения', () => {
    expect(walletCategoryFromSignalList('1')).toBe('smart_money');
    expect(walletCategoryFromSignalList('2')).toBe('kol');
    expect(walletCategoryFromSignalList('3')).toBe('whale');
  });

  it('код вне словаря не становится умными деньгами', () => {
    // OKX добавляет категории. Молчаливое отнесение новой цифры
    // к копируемым — худшее из возможных умолчаний.
    expect(walletCategoryFromSignalList('4')).toBe('unknown');
    expect(walletCategoryFromSignalList('99')).toBe('unknown');
  });

  it('число и строка разбираются одинаково', () => {
    // OKX присылает то одно, то другое; `1 !== '1'` обнулило бы
    // всю таблицу без единой ошибки.
    expect(walletCategoryFromSignalList(1)).toBe('smart_money');
    expect(walletCategoryFromSignalList('1')).toBe('smart_money');
  });

  it('мусор даёт неизвестность', () => {
    expect(walletCategoryFromSignalList(null)).toBe('unknown');
    expect(walletCategoryFromSignalList(undefined)).toBe('unknown');
    expect(walletCategoryFromSignalList({})).toBe('unknown');
    expect(walletCategoryFromSignalList('')).toBe('unknown');
    expect(walletCategoryFromSignalList(NaN)).toBe('unknown');
  });

  it('пробелы по краям не мешают', () => {
    expect(walletCategoryFromSignalList(' 2 ')).toBe('kol');
  });
});

describe('разбор кодов лидерборда', () => {
  const cases: Array<[string, WalletCategory]> = [
    ['1', 'kol'],
    ['2', 'developer'],
    ['3', 'smart_money'],
    ['4', 'whale'],
    ['5', 'new_wallet'],
    ['6', 'insider'],
    ['7', 'sniper'],
    ['8', 'phishing_suspect'],
    ['9', 'bundled_trader'],
    ['10', 'pump_smart_money'],
  ];

  for (const [code, category] of cases) {
    it(`${code} → ${category}`, () => {
      expect(walletCategoryFromLeaderboard(code)).toBe(category);
    });
  }

  it('одиннадцатого значения в словаре нет', () => {
    expect(walletCategoryFromLeaderboard('11')).toBe('unknown');
  });

  it('десятка не путается с единицей и нулём', () => {
    // Строковое сравнение: «10» не должно попасть в «1».
    expect(walletCategoryFromLeaderboard('10')).toBe('pump_smart_money');
    expect(walletCategoryFromLeaderboard(10)).toBe('pump_smart_money');
  });
});

describe('обратное преобразование', () => {
  it('код для запроса берётся из своего словаря', () => {
    expect(signalListWalletType('smart_money')).toBe('1');
    expect(leaderboardWalletType('smart_money')).toBe('3');
  });

  it('кита в сигналах и в лидерборде запрашивают разными кодами', () => {
    expect(signalListWalletType('whale')).toBe('3');
    expect(leaderboardWalletType('whale')).toBe('4');
  });

  it('категории, которой нет в эндпоинте, соответствует null', () => {
    // Снайпера в списке сигналов не существует. Подставить туда
    // любой код значило бы запросить не то и не заметить.
    expect(signalListWalletType('sniper')).toBeNull();
    expect(signalListWalletType('developer')).toBeNull();
    expect(leaderboardWalletType('unknown')).toBeNull();
  });

  it('круговое преобразование сохраняет категорию', () => {
    for (const category of ['smart_money', 'kol', 'whale'] as const) {
      const code = signalListWalletType(category)!;
      expect(walletCategoryFromSignalList(code)).toBe(category);
    }
  });
});

describe('пригодность для копирования', () => {
  it('умные деньги, инфлюенсеры и киты копируются', () => {
    expect(isCopyable('smart_money')).toBe(true);
    expect(isCopyable('kol')).toBe(true);
    expect(isCopyable('whale')).toBe(true);
  });

  it('снайпер не копируется', () => {
    // Входит в первом блоке и выходит через минуту. Повторять
    // за ним значит покупать у него же.
    expect(isCopyable('sniper')).toBe(false);
  });

  it('подозрение на фишинг не копируется', () => {
    expect(isCopyable('phishing_suspect')).toBe(false);
  });

  it('связанная торговля не копируется', () => {
    // Пакетные покупки создают видимость спроса, а не спрос.
    expect(isCopyable('bundled_trader')).toBe(false);
  });

  it('неизвестная категория не копируется', () => {
    // Самое важное умолчание во всём модуле.
    expect(isCopyable('unknown')).toBe(false);
  });

  it('опасные категории ухудшают оценку, а не просто не копируются', () => {
    expect(isAdverse('phishing_suspect')).toBe(true);
    expect(isAdverse('bundled_trader')).toBe(true);
    expect(isAdverse('sniper')).toBe(true);
    expect(isAdverse('insider')).toBe(true);

    expect(isAdverse('smart_money')).toBe(false);
    expect(isAdverse('new_wallet')).toBe(false);
  });
});

describe('названия', () => {
  it('у каждой категории есть подпись', () => {
    const categories = Object.keys(WALLET_CATEGORY_LABEL) as WalletCategory[];

    for (const c of categories) {
      expect(WALLET_CATEGORY_LABEL[c].length).toBeGreaterThan(0);
    }
  });

  it('неизвестность названа неизвестностью, а не пустотой', () => {
    // Пустая подпись в интерфейсе читается как «обычный кошелёк».
    expect(WALLET_CATEGORY_LABEL.unknown).toContain('неизвестна');
  });
});
