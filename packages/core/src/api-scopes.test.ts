import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  SCOPE_LABELS,
  FORBIDDEN_SCOPE_WORDS,
  isApiScope,
  checkScope,
} from './api-scopes.js';

describe('ALL_SCOPES — запрет на вывод средств', () => {
  it('среди областей нет права на вывод, перевод или отправку', () => {
    // Смысл теста не в текущем состоянии — оно очевидно верно, —
    // а в будущем изменении. Кто-то добавит область ради удобства
    // скрипта, и вместе с ней приедет возможность увести деньги.
    // Проверка обязана сломаться в этот момент.
    for (const scope of ALL_SCOPES) {
      for (const word of FORBIDDEN_SCOPE_WORDS) {
        expect(
          scope.toLowerCase().includes(word),
          `область «${scope}» содержит запрещённое слово «${word}»`,
        ).toBe(false);
      }
    }
  });

  it('ни одна подпись области не обещает распоряжения средствами', () => {
    // Название может быть безобидным, а подпись — описывать вывод.
    // Пользователь читает подпись, а не идентификатор.
    for (const label of Object.values(SCOPE_LABELS)) {
      const l = label.toLowerCase();
      expect(l).not.toContain('вывод');
      expect(l).not.toContain('вывест');
      expect(l).not.toContain('перевод');
      expect(l).not.toContain('отправ');
    }
  });

  it('у каждой области есть человеческая подпись', () => {
    // Область без подписи попадёт в интерфейс идентификатором,
    // и владелец ключа не поймёт, что именно он выдаёт.
    for (const scope of ALL_SCOPES) {
      expect(SCOPE_LABELS[scope]).toBeTruthy();
      expect(SCOPE_LABELS[scope].length).toBeGreaterThan(5);
    }
  });

  it('областей ровно столько, сколько описано', () => {
    expect(ALL_SCOPES).toHaveLength(3);
    expect(Object.keys(SCOPE_LABELS)).toHaveLength(3);
  });
});

describe('isApiScope', () => {
  it('признаёт известные области', () => {
    expect(isApiScope('trade:write')).toBe(true);
    expect(isApiScope('radar:ingest')).toBe(true);
  });

  it('отвергает выдуманные', () => {
    expect(isApiScope('withdraw')).toBe(false);
    expect(isApiScope('trade:*')).toBe(false);
    expect(isApiScope('')).toBe(false);
    expect(isApiScope('TRADE:WRITE')).toBe(false);
  });
});

describe('checkScope', () => {
  it('пропускает при наличии нужной области', () => {
    const r = checkScope(['trade:read', 'trade:write'], 'trade:write');
    expect(r.allowed).toBe(true);
  });

  it('отказывает при её отсутствии и объясняет, чего не хватает', () => {
    const r = checkScope(['trade:read'], 'trade:write');
    expect(r.allowed).toBe(false);
    // Без указания области владелец ключа перебирает настройки вслепую
    // либо выдаёт ключу всё подряд — что хуже понятного сообщения.
    expect(r.reason).toContain('trade:write');
  });

  it('чтение не даёт права записи', () => {
    // Самая вероятная ошибка при выдаче ключа: считать, что «read»
    // это меньшая версия «write», а не другое право.
    expect(checkScope(['trade:read'], 'trade:write').allowed).toBe(false);
  });

  it('запись не подразумевает чтение', () => {
    // Обратное тоже: иерархии между областями нет, и полагаться
    // на неё нельзя.
    expect(checkScope(['trade:write'], 'trade:read').allowed).toBe(false);
  });

  it('приём в радар не даёт торговать', () => {
    expect(checkScope(['radar:ingest'], 'trade:write').allowed).toBe(false);
    expect(checkScope(['radar:ingest'], 'trade:read').allowed).toBe(false);
  });

  it('пустой список областей ничего не разрешает', () => {
    const r = checkScope([], 'trade:read');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('ни одной области');
  });

  it('неизвестные области не расширяют права', () => {
    // Строка из базы могла остаться от прежней версии схемы —
    // и точно не должна работать как «всё разрешено».
    expect(checkScope(['*'], 'trade:write').allowed).toBe(false);
    expect(checkScope(['admin', 'withdraw'], 'trade:write').allowed).toBe(false);
    expect(checkScope(['trade'], 'trade:write').allowed).toBe(false);
  });

  it('некорректный ввод не пропускает', () => {
    expect(checkScope(null as never, 'trade:read').allowed).toBe(false);
    expect(checkScope(undefined as never, 'trade:read').allowed).toBe(false);
  });
});
