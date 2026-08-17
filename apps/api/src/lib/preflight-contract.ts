/**
 * Что должно быть верно, прежде чем менять боевую схему.
 *
 * Чистая часть проверки: на вход снимок состояния базы, на выход
 * вердикт. Без Prisma и без сети — именно поэтому её можно проверить
 * тестами, а не надеждой.
 *
 * Проверка нужна из-за одного конкретного риска. Добавление
 * `@unique` к `User.telegramLinkCode` на пустой базе безобидно,
 * а на боевой — нет: если два пользователя когда-то получили
 * одинаковый код, создание ограничения не пройдёт, и Prisma предложит
 * `--accept-data-loss`. Согласиться на это, не посмотрев, значит
 * разрешить базе самой решить, чьи строки лишние.
 *
 * Поэтому дубликаты считаются заранее и отдельно. Наружу идут только
 * числа: сами коды — это ссылки на привязку Telegram, и в журнале
 * им места нет.
 */

export interface DbSnapshot {
  /** Есть ли таблица избранного. */
  hasWalletFavoriteTable: boolean;
  /** Есть ли уникальность по паре пользователь+кошелёк. */
  hasFavoriteUnique: boolean;
  /** Есть ли уникальность кода привязки Telegram. */
  hasTelegramLinkUnique: boolean;
  /**
   * Сколько значений кода встречается больше одного раза.
   * Значения не передаются — только количество.
   */
  duplicateLinkCodeValues: number;
  /** Сколько строк затронуто этими повторами. */
  duplicateLinkCodeRows: number;
  /** Размеры таблиц. Для понимания, на что мы влияем. */
  userCount: number;
  favoriteCount: number | null;
}

export type PreflightVerdict = 'ready' | 'already_applied' | 'blocked' | 'unknown_state';

export interface PreflightResult {
  verdict: PreflightVerdict;
  /** Что предстоит создать. */
  pending: string[];
  /** Что мешает применению. */
  blockers: string[];
  /** На что стоит посмотреть, но применению не мешает. */
  notes: string[];
  exitCode: number;
}

/**
 * Коды выхода.
 *
 * Ноль означает «применять безопасно» и ничего больше. Всё остальное
 * различается числом: конвейеру нужно знать не «упало», а что именно
 * не так.
 */
export const PREFLIGHT_EXIT = {
  ready: 0,
  alreadyApplied: 0,
  blocked: 2,
  unknownState: 3,
  noDatabaseUrl: 4,
  unavailable: 5,
} as const;

/**
 * Вердикт по снимку.
 *
 * Порядок важен: сначала то, что запрещает применение, потом то,
 * что делает его ненужным, и только потом разрешение.
 */
export function evaluatePreflight(s: DbSnapshot): PreflightResult {
  const pending: string[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!s.hasWalletFavoriteTable) pending.push('таблица WalletFavorite');
  if (!s.hasFavoriteUnique) pending.push('уникальность WalletFavorite(userId, chain, walletAddress)');
  if (!s.hasTelegramLinkUnique) pending.push('уникальность User.telegramLinkCode');

  // Дубликаты кода — единственная причина, по которой создание
  // ограничения может потребовать удаления строк. Считаем заранее,
  // чтобы не соглашаться на потерю данных вслепую.
  if (s.duplicateLinkCodeValues > 0) {
    blockers.push(
      `повторяющиеся значения telegramLinkCode: ${s.duplicateLinkCodeValues} ` +
        `(затронуто строк: ${s.duplicateLinkCodeRows})`,
    );
  }

  // Таблица есть, а уникальности нет — состояние, которого наша
  // схема не описывает. Значит, кто-то менял базу вручную,
  // и угадывать здесь нельзя.
  if (s.hasWalletFavoriteTable && !s.hasFavoriteUnique) {
    return {
      verdict: 'unknown_state',
      pending,
      blockers: [
        ...blockers,
        'таблица WalletFavorite существует без ожидаемой уникальности — схема изменялась вне проекта',
      ],
      notes,
      exitCode: PREFLIGHT_EXIT.unknownState,
    };
  }

  if (blockers.length > 0) {
    return { verdict: 'blocked', pending, blockers, notes, exitCode: PREFLIGHT_EXIT.blocked };
  }

  if (s.favoriteCount != null && s.favoriteCount > 0) {
    notes.push(`в избранном уже ${s.favoriteCount} записей`);
  }

  notes.push(`пользователей в базе: ${s.userCount}`);

  if (pending.length === 0) {
    return {
      verdict: 'already_applied',
      pending,
      blockers,
      notes,
      exitCode: PREFLIGHT_EXIT.alreadyApplied,
    };
  }

  return { verdict: 'ready', pending, blockers, notes, exitCode: PREFLIGHT_EXIT.ready };
}

// ─────────────────────── Проверка SQL по списку ──────────────────────────────

/**
 * Что разрешено делать этой правкой схемы.
 *
 * Список составлен по тому, что действительно требуется: создать
 * таблицу избранного, её индексы и два ограничения уникальности.
 * Всё остальное — повод остановиться, а не разбираться по ходу.
 */
export const FORBIDDEN_SQL = [
  'DROP TABLE',
  'DROP COLUMN',
  'DROP INDEX',
  'DROP CONSTRAINT',
  'TRUNCATE',
  'DELETE FROM',
  'ALTER COLUMN',
  'RENAME',
];

export interface SqlReviewResult {
  ok: boolean
  /** Найденные запрещённые операции. */
  violations: string[];
  /** Сколько операторов в наборе. */
  statements: number;
}

/**
 * Разбор SQL-разницы по списку запрещённого.
 *
 * Проверяется наличие опасных операций, а не отсутствие ожидаемых:
 * список безопасных операций пришлось бы держать полным, и любая
 * невинная новинка ломала бы проверку. Опасных операций конечное
 * число, и они не меняются.
 */
export function reviewSqlDiff(sql: string): SqlReviewResult {
  // Комментарии выбрасываем: слово DROP в пояснении не операция.
  const code = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .toUpperCase();

  const violations = FORBIDDEN_SQL.filter((op) => code.includes(op));

  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--')).length;

  return { ok: violations.length === 0, violations, statements };
}

/**
 * Указывает ли строка подключения на локальную базу.
 *
 * Нужна ровно одна проверка: не применить ли мы боевую правку
 * к машине разработчика или наоборот. Строка не возвращается
 * и никуда не печатается — только ответ «да» или «нет».
 */
export function looksLocal(url: string): boolean {
  return /(^|@|\/\/)(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:/]|$)/i.test(url);
}
