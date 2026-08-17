/**
 * Проверка перед изменением боевой схемы.
 *
 * Вердикт вынесен в чистую функцию именно ради этих тестов: все
 * состояния боевой базы — с дубликатами, с половиной применённой
 * схемы, с ручными правками — проверяются без подключения куда-либо.
 *
 * Главное утверждение: согласие на потерю данных не выдаётся молча.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePreflight,
  reviewSqlDiff,
  looksLocal,
  PREFLIGHT_EXIT,
  type DbSnapshot,
} from './preflight-contract.js';

/** База до правки: таблицы нет, ограничений нет, дубликатов нет. */
const clean: DbSnapshot = {
  hasWalletFavoriteTable: false,
  hasFavoriteUnique: false,
  hasTelegramLinkUnique: false,
  duplicateLinkCodeValues: 0,
  duplicateLinkCodeRows: 0,
  userCount: 12,
  favoriteCount: null,
};

describe('вердикт', () => {
  it('чистая база готова к применению', () => {
    const r = evaluatePreflight(clean);

    expect(r.verdict).toBe('ready');
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.ready);
    expect(r.pending).toHaveLength(3);
  });

  it('дубликаты кода Telegram запрещают применение', () => {
    // Создание уникальности на таких данных не пройдёт, и Prisma
    // предложит согласиться на потерю строк. Соглашаться, не глядя,
    // значит разрешить базе решить, чьи строки лишние.
    const r = evaluatePreflight({
      ...clean,
      duplicateLinkCodeValues: 2,
      duplicateLinkCodeRows: 5,
    });

    expect(r.verdict).toBe('blocked');
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.blocked);
    expect(r.blockers[0]).toContain('2');
    expect(r.blockers[0]).toContain('5');
  });

  it('в сообщении о дубликатах нет самих кодов', () => {
    // Код привязки — это ссылка на аккаунт Telegram. В журнале
    // ему места нет.
    const r = evaluatePreflight({ ...clean, duplicateLinkCodeValues: 1, duplicateLinkCodeRows: 2 });
    const text = JSON.stringify(r);

    expect(text).not.toMatch(/telegramLinkCode['"]?\s*[:=]\s*['"][^'"]+/);
  });

  it('уже применённая схема не требует действий', () => {
    const r = evaluatePreflight({
      ...clean,
      hasWalletFavoriteTable: true,
      hasFavoriteUnique: true,
      hasTelegramLinkUnique: true,
      favoriteCount: 3,
    });

    expect(r.verdict).toBe('already_applied');
    expect(r.exitCode).toBe(0);
    expect(r.pending).toEqual([]);
  });

  it('таблица без уникальности — состояние, которого схема не описывает', () => {
    // Кто-то менял базу вручную. Догадываться, что делать, нельзя.
    const r = evaluatePreflight({ ...clean, hasWalletFavoriteTable: true, favoriteCount: 0 });

    expect(r.verdict).toBe('unknown_state');
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.unknownState);
  });

  it('неизвестное состояние важнее дубликатов', () => {
    // Сначала надо понять, что с базой вообще происходит.
    const r = evaluatePreflight({
      ...clean,
      hasWalletFavoriteTable: true,
      duplicateLinkCodeValues: 3,
      duplicateLinkCodeRows: 7,
    });

    expect(r.verdict).toBe('unknown_state');
  });

  it('непустое избранное отмечается, но не мешает', () => {
    const r = evaluatePreflight({
      ...clean,
      hasWalletFavoriteTable: true,
      hasFavoriteUnique: true,
      hasTelegramLinkUnique: true,
      favoriteCount: 42,
    });

    expect(r.verdict).toBe('already_applied');
    expect(r.notes.join(' ')).toContain('42');
  });

  it('число пользователей попадает в заметки', () => {
    expect(evaluatePreflight(clean).notes.join(' ')).toContain('12');
  });

  it('успешный код выхода только у безопасных исходов', () => {
    const blocked = evaluatePreflight({ ...clean, duplicateLinkCodeValues: 1, duplicateLinkCodeRows: 2 });
    expect(blocked.exitCode).not.toBe(0);
  });
});

describe('разбор SQL по списку запрещённого', () => {
  it('создание таблицы и индексов проходит', () => {
    const sql = `
      CREATE TABLE "WalletFavorite" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL);
      CREATE UNIQUE INDEX "WalletFavorite_userId_chain_walletAddress_key"
        ON "WalletFavorite"("userId", "chain", "walletAddress");
      CREATE UNIQUE INDEX "User_telegramLinkCode_key" ON "User"("telegramLinkCode");
      ALTER TABLE "WalletFavorite" ADD CONSTRAINT "WalletFavorite_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
    `;

    const r = reviewSqlDiff(sql);

    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.statements).toBe(4);
  });

  it('удаление таблицы не проходит', () => {
    const r = reviewSqlDiff('DROP TABLE "RadarEvent";');

    expect(r.ok).toBe(false);
    expect(r.violations).toContain('DROP TABLE');
  });

  it('удаление колонки не проходит', () => {
    const r = reviewSqlDiff('ALTER TABLE "User" DROP COLUMN "totpSecret";');
    expect(r.ok).toBe(false);
  });

  it('смена типа колонки не проходит', () => {
    // Это перезапись данных под видом правки схемы.
    const r = reviewSqlDiff('ALTER TABLE "Token" ALTER COLUMN "priceUsd" TYPE numeric(12,4);');
    expect(r.ok).toBe(false);
  });

  it('удаление строк не проходит', () => {
    const r = reviewSqlDiff('DELETE FROM "User" WHERE "telegramLinkCode" IS NOT NULL;');
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('DELETE FROM');
  });

  it('переименование требует отдельного решения', () => {
    const r = reviewSqlDiff('ALTER TABLE "Old" RENAME TO "New";');
    expect(r.ok).toBe(false);
  });

  it('слово DROP в комментарии не считается операцией', () => {
    const sql = `
      -- DROP TABLE здесь не выполняется, это пояснение
      CREATE TABLE "WalletFavorite" ("id" TEXT NOT NULL);
    `;

    expect(reviewSqlDiff(sql).ok).toBe(true);
  });

  it('запрещённая операция среди разрешённых всё равно останавливает', () => {
    // Применять часть разницы нельзя: половина правки хуже целой.
    const sql = `
      CREATE TABLE "WalletFavorite" ("id" TEXT NOT NULL);
      DROP INDEX "Token_address_idx";
    `;

    expect(reviewSqlDiff(sql).ok).toBe(false);
  });

  it('пустая разница не содержит операторов', () => {
    expect(reviewSqlDiff('').statements).toBe(0);
  });
});

describe('распознавание локальной базы', () => {
  it('localhost и петля распознаются', () => {
    expect(looksLocal('postgresql://u:p@localhost:5432/db')).toBe(true);
    expect(looksLocal('postgresql://u:p@127.0.0.1:5432/db')).toBe(true);
    expect(looksLocal('postgresql://u:p@[::1]:5432/db')).toBe(true);
  });

  it('внешний хост не считается локальным', () => {
    expect(looksLocal('postgresql://u:p@ep-example.eu-central-1.aws.neon.tech/db')).toBe(false);
  });

  it('строка не возвращается наружу', () => {
    // Функция отвечает «да» или «нет» и ничего больше: значение
    // не должно просочиться в вывод через возврат.
    expect(typeof looksLocal('postgresql://u:p@localhost/db')).toBe('boolean');
  });
});
