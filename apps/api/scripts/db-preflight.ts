/**
 * Проверка боевой базы перед изменением схемы. Только чтение.
 *
 * Скрипт отвечает на один вопрос: безопасно ли применять ожидаемую
 * правку. Ничего не создаёт, не меняет и не удаляет — ни одной
 * записывающей операции здесь нет.
 *
 * Главный предмет проверки — не таблица избранного, а ограничение
 * уникальности на `User.telegramLinkCode`. На пустой базе оно
 * создаётся молча, на боевой может не создаться: если два
 * пользователя когда-то получили одинаковый код, Prisma предложит
 * `--accept-data-loss`. Согласиться, не посмотрев, значит разрешить
 * базе решить, чьи строки лишние.
 *
 * Наружу не выводится ни строка подключения, ни хост, ни имя
 * пользователя, ни сами коды привязки. Только числа и названия
 * объектов.
 *
 * Запуск: DATABASE_URL="<direct>" npm run db:preflight -w @memex/api
 */

import { prisma } from '../src/lib/prisma.js';
import {
  evaluatePreflight,
  looksLocal,
  PREFLIGHT_EXIT,
  type DbSnapshot,
} from '../src/lib/preflight-contract.js';

interface CountRow {
  n: bigint;
}

async function snapshot(): Promise<DbSnapshot> {
  // Наличие таблицы. Через системный каталог, а не через попытку
  // запроса: неудачный запрос к отсутствующей таблице в некоторых
  // настройках оставляет транзакцию в нерабочем состоянии.
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'WalletFavorite'
  `;

  const hasWalletFavoriteTable = tables.length > 0;

  // Уникальные индексы по интересующим нас таблицам.
  const uniques = await prisma.$queryRaw<Array<{ table_name: string; columns: string[] }>>`
    SELECT c.relname AS table_name,
           array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_class c
    JOIN pg_index ix ON c.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema()
      AND ix.indisunique
      AND c.relname IN ('WalletFavorite', 'User')
    GROUP BY c.relname, i.relname
  `;

  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

  const hasFavoriteUnique = uniques.some(
    (u) =>
      u.table_name === 'WalletFavorite' &&
      sameSet(u.columns, ['userId', 'chain', 'walletAddress']),
  );

  const hasTelegramLinkUnique = uniques.some(
    (u) => u.table_name === 'User' && sameSet(u.columns, ['telegramLinkCode']),
  );

  /*
   * Повторы кода привязки.
   *
   * Считаются два числа: сколько значений повторяется и сколько
   * строк этим затронуто. Сами значения не выбираются вовсе —
   * их нет ни в результате запроса, ни в выводе.
   */
  const dupes = await prisma.$queryRaw<Array<{ values: bigint; rows: bigint }>>`
    SELECT COUNT(*) AS values, COALESCE(SUM(cnt), 0) AS rows
    FROM (
      SELECT COUNT(*) AS cnt
      FROM "User"
      WHERE "telegramLinkCode" IS NOT NULL
      GROUP BY "telegramLinkCode"
      HAVING COUNT(*) > 1
    ) AS d
  `;

  const users = await prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS n FROM "User"`;

  let favoriteCount: number | null = null;
  if (hasWalletFavoriteTable) {
    const rows = await prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::bigint AS n FROM "WalletFavorite"
    `;
    favoriteCount = Number(rows[0]?.n ?? 0);
  }

  return {
    hasWalletFavoriteTable,
    hasFavoriteUnique,
    hasTelegramLinkUnique,
    duplicateLinkCodeValues: Number(dupes[0]?.values ?? 0),
    duplicateLinkCodeRows: Number(dupes[0]?.rows ?? 0),
    userCount: Number(users[0]?.n ?? 0),
    favoriteCount,
  };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error('DATABASE_URL не задан.');
    return PREFLIGHT_EXIT.noDatabaseUrl;
  }

  // Куда смотрит строка — печатается словом, а не значением.
  console.log(`Цель: ${looksLocal(url) ? 'локальная база' : 'внешняя база'}`);
  console.log('Режим: только чтение\n');

  let snap: DbSnapshot;
  try {
    snap = await snapshot();
  } catch (e: any) {
    // Только код. Текст ошибки драйвера содержит хост и пользователя.
    console.error('Базу опросить не удалось.');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    return PREFLIGHT_EXIT.unavailable;
  }

  const result = evaluatePreflight(snap);

  console.log('Состояние:');
  console.log(`  WalletFavorite: ${snap.hasWalletFavoriteTable ? 'есть' : 'нет'}`);
  console.log(`  уникальность избранного: ${snap.hasFavoriteUnique ? 'есть' : 'нет'}`);
  console.log(`  уникальность кода Telegram: ${snap.hasTelegramLinkUnique ? 'есть' : 'нет'}`);
  console.log(`  повторов кода Telegram: ${snap.duplicateLinkCodeValues}`);
  console.log(`  затронуто строк: ${snap.duplicateLinkCodeRows}`);

  if (result.pending.length > 0) {
    console.log('\nБудет создано:');
    for (const p of result.pending) console.log(`  · ${p}`);
  }

  if (result.notes.length > 0) {
    console.log('\nЗаметки:');
    for (const n of result.notes) console.log(`  · ${n}`);
  }

  if (result.blockers.length > 0) {
    console.log('\nПрепятствия:');
    for (const b of result.blockers) console.log(`  · ${b}`);
  }

  console.log(`\nВердикт: ${verdictWord(result.verdict)}`);

  return result.exitCode;
}

function verdictWord(v: string): string {
  if (v === 'ready') return 'PREFLIGHT_OK — применять безопасно';
  if (v === 'already_applied') return 'PREFLIGHT_OK — схема уже применена';
  if (v === 'blocked') return 'PREFLIGHT_BLOCKED — применять нельзя';
  return 'PREFLIGHT_UNKNOWN_STATE — разберитесь вручную';
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    console.error('Проверка прервалась.');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    process.exitCode = PREFLIGHT_EXIT.unavailable;
  })
  .finally(() => {
    // Соединение закрывается всегда: висящий слот на бесплатном
    // тарифе Neon стоит дороже, чем кажется.
    void prisma.$disconnect();
  });
