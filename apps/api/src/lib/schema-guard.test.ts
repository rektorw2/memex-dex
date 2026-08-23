/**
 * Проверка соответствия базы коду.
 *
 * Сравнение вынесено в чистую функцию именно ради этих тестов:
 * полный, неполный и пустой снимок проверяются без Postgres,
 * а значит проверяются вообще — база в тестовом окружении
 * недоступна, и «проверим на живой» означало бы «не проверим».
 */

import { describe, it, expect } from 'vitest';
import {
  compareSchema,
  REQUIRED_TABLES,
  REQUIRED_UNIQUES,
  type DbSnapshot,
} from './schema-contract.js';

/** Снимок базы, полностью соответствующей коду. */
function fullSnapshot(): DbSnapshot {
  const tables: Record<string, string[]> = {};

  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    // Лишние колонки добавлены намеренно: база, ушедшая вперёд кода,
    // — это нормальная ситуация при откате версии, и она не должна
    // считаться поломкой.
    tables[table] = [...columns, 'createdAt', 'updatedAt'];
  }

  return {
    tables,
    uniques: REQUIRED_UNIQUES.map((u) => ({ table: u.table, columns: [...u.columns] })),
  };
}

describe('полная схема', () => {
  it('не сообщает о недостающем', () => {
    expect(compareSchema(fullSnapshot())).toEqual([]);
  });

  it('лишние таблицы и колонки не считаются поломкой', () => {
    const snapshot = fullSnapshot();
    snapshot.tables.SomethingElse = ['id'];
    snapshot.tables.WalletActivity!.push('futureColumn');

    expect(compareSchema(snapshot)).toEqual([]);
  });

  it('порядок колонок в уникальном индексе не важен', () => {
    // unique(chain, walletAddress) и unique(walletAddress, chain)
    // дают одну и ту же гарантию неповторимости.
    const snapshot = fullSnapshot();
    snapshot.uniques = snapshot.uniques.map((u) => ({ ...u, columns: [...u.columns].reverse() }));

    expect(compareSchema(snapshot)).toEqual([]);
  });
});

describe('неполная схема', () => {
  it('пустая база даёт список таблиц, а не список колонок', () => {
    // Перечислять сорок отсутствующих колонок, когда нет самой
    // таблицы, значит утопить причину в следствиях.
    const missing = compareSchema({ tables: {}, uniques: [] });

    expect(missing).toHaveLength(Object.keys(REQUIRED_TABLES).length);
    for (const item of missing) expect(item).toContain('таблица отсутствует');
  });

  it('находит недостающую колонку поколения', () => {
    const snapshot = fullSnapshot();
    snapshot.tables.WalletSyncQueue = snapshot.tables.WalletSyncQueue!.filter(
      (c) => c !== 'generation',
    );

    expect(compareSchema(snapshot)).toContain('WalletSyncQueue.generation');
  });

  it('находит недостающие поля аренды', () => {
    const snapshot = fullSnapshot();
    snapshot.tables.WalletSyncQueue = snapshot.tables.WalletSyncQueue!.filter(
      (c) => !['lockedBy', 'leaseToken', 'lockedUntil'].includes(c),
    );

    const missing = compareSchema(snapshot);

    expect(missing).toContain('WalletSyncQueue.lockedBy');
    expect(missing).toContain('WalletSyncQueue.leaseToken');
    expect(missing).toContain('WalletSyncQueue.lockedUntil');
  });

  it('находит недостающие поля состояния события', () => {
    const snapshot = fullSnapshot();
    snapshot.tables.WalletActivity = snapshot.tables.WalletActivity!.filter(
      (c) => c !== 'ledgerState',
    );

    expect(compareSchema(snapshot)).toContain('WalletActivity.ledgerState');
  });

  it('находит отсутствующее поле подтверждения почты', () => {
    const snapshot = fullSnapshot();
    snapshot.tables.User = snapshot.tables.User!.filter((c) => c !== 'emailCodeHash');

    expect(compareSchema(snapshot)).toContain('User.emailCodeHash');
  });

  it('не считает схему готовой без таблицы подписок', () => {
    const snapshot = fullSnapshot();
    delete snapshot.tables.Subscription;

    expect(compareSchema(snapshot)).toContain('Subscription (таблица отсутствует)');
  });

  it('не запускает живой Signal без его таблицы', () => {
    const snapshot = fullSnapshot();
    delete snapshot.tables.OkxSignal;

    expect(compareSchema(snapshot)).toContain('OkxSignal (таблица отсутствует)');
  });

  it('отсутствие уникальности очереди — поломка, а не мелочь', () => {
    // Без неё два процесса создадут две задачи на один кошелёк
    // и будут пересчитывать его одновременно, получая разные
    // промежуточные состояния одной позиции.
    const snapshot = fullSnapshot();
    snapshot.uniques = snapshot.uniques.filter((u) => u.table !== 'WalletSyncQueue');

    expect(compareSchema(snapshot)).toContain(
      'WalletSyncQueue(chain, walletAddress) — нет уникальности',
    );
  });

  it('отсутствие уникальности канонического ключа — поломка', () => {
    // Без неё повторная строка истории создаст вторую запись
    // и удвоит объём позиции.
    const snapshot = fullSnapshot();
    snapshot.uniques = snapshot.uniques.filter((u) => u.table !== 'WalletEconomicTrade');

    expect(compareSchema(snapshot)).toContain('WalletEconomicTrade(key) — нет уникальности');
  });

  it('уникальность по другому набору колонок не засчитывается', () => {
    const snapshot = fullSnapshot();
    snapshot.uniques = snapshot.uniques.map((u) =>
      u.table === 'WalletSyncQueue' ? { table: u.table, columns: ['walletAddress'] } : u,
    );

    expect(compareSchema(snapshot)).toContain(
      'WalletSyncQueue(chain, walletAddress) — нет уникальности',
    );
  });

  it('про индексы отсутствующей таблицы отдельно не сообщается', () => {
    const snapshot = fullSnapshot();
    delete snapshot.tables.WalletSyncQueue;
    snapshot.uniques = snapshot.uniques.filter((u) => u.table !== 'WalletSyncQueue');

    const missing = compareSchema(snapshot);

    expect(missing).toContain('WalletSyncQueue (таблица отсутствует)');
    expect(missing.filter((m) => m.includes('нет уникальности'))).toEqual([]);
  });
});

describe('состав требований', () => {
  it('проверяет поля, от которых зависит регистрация и подтверждение почты', () => {
    expect(REQUIRED_TABLES.User).toEqual(
      expect.arrayContaining([
        'email',
        'passwordHash',
        'emailVerifiedAt',
        'emailCodeHash',
        'emailCodeIssuedAt',
        'emailCodeExpires',
        'emailCodeAttempts',
      ]),
    );
  });

  it('очередь проверяется по dueAt — так поле называется в схеме', () => {
    // Сверяться надо с тем, что есть. Проверка по выдуманному имени
    // сообщала бы о поломке там, где её нет, и выключала бы воркер
    // на исправной базе.
    expect(REQUIRED_TABLES.WalletSyncQueue).toContain('dueAt');
    expect(REQUIRED_TABLES.WalletSyncQueue).not.toContain('nextRunAt');
  });

  it('в списке недостающего нет ни SQL, ни строки подключения', () => {
    // Этот список уходит в открытый ответ маршрута состояния.
    const missing = compareSchema({ tables: {}, uniques: [] });
    const text = missing.join(' ');

    expect(text).not.toMatch(/postgres|password|SELECT|@/i);
  });
});
