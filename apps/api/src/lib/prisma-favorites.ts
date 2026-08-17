/**
 * Доступ к таблице избранного.
 *
 * Обёртка нужна из-за порядка работ, а не из-за архитектуры. Клиент
 * Prisma порождается из схемы, а схема в этом проекте применяется
 * вручную: между появлением модели в `schema.prisma` и выполнением
 * `db:generate` типа `walletFavorite` в клиенте ещё нет.
 *
 * Тип делегата выводится из самого клиента, а не описывается заново:
 *
 *   есть в клиенте  → берётся оттуда, и любое расхождение с моделью
 *                     остаётся ошибкой компиляции, как и должно быть;
 *   ещё нет         → берётся запасное описание, чтобы код собирался.
 *
 * Это важнее, чем кажется. Простое приведение к `any` сняло бы
 * проверку навсегда: после `db:generate` ошибки в именах полей
 * продолжали бы проходить молча. Здесь же проверка включается
 * сама, как только клиент порождён.
 */

import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

/** Запасное описание. Действует только до `npm run db:generate`. */
interface FallbackFavoriteDelegate {
  findMany(args?: unknown): Promise<
    Array<{
      id: string;
      userId: string;
      chain: string;
      walletAddress: string;
      note: string | null;
      createdAt: Date;
    }>
  >;
  upsert(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  createMany(args: unknown): Promise<{ count: number }>;
  count(args?: unknown): Promise<number>;
}

type FavoriteDelegate = PrismaClient extends { walletFavorite: infer D }
  ? D
  : FallbackFavoriteDelegate;

/**
 * Таблица избранного.
 *
 * Обращение идёт к тому же клиенту: на выполнение запроса обёртка
 * не влияет никак. Если таблицы в базе ещё нет, Prisma вернёт код
 * P2021, и обработка этого случая — задача вызывающего.
 */
export const favorites = (prisma as unknown as { walletFavorite: FavoriteDelegate })
  .walletFavorite;
