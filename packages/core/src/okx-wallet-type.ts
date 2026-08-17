/**
 * Типы кошельков OKX: у каждого эндпоинта свой словарь.
 *
 * Это не осторожность на всякий случай, а исправление конкретной
 * ловушки, проверенной по официальной документации.
 *
 *   Latest Signal List:  1 = Smart Money, 2 = KOL,        3 = Whale
 *   Smart Money Leaderboard:
 *                        1 = KOL,         2 = Developer,  3 = Smart Money,
 *                        4 = Whale,       5 = New Wallet, 6 = Insider,
 *                        7 = Sniper,      8 = Phishing,   9 = Bundled,
 *                        10 = Pump Smart Money
 *
 * Единица означает «умные деньги» в одном месте и «инфлюенсер»
 * в другом. Тройка — «кит» и «умные деньги». Один общий словарь
 * переименовал бы каждый кошелёк в списке, и ошибка не выдала бы
 * себя ничем: адреса на месте, числа на месте, подпись под ними
 * чужая.
 *
 * Цена такой ошибки — не косметическая. Копирование сделок за
 * «умными деньгами», которые на деле снайперы или подозреваемые
 * в фишинге, означает покупку того, что покупают ради обмана.
 *
 * Поэтому разбор делается отдельной функцией на каждый эндпоинт,
 * а общей функции преобразования не существует вовсе.
 */

/**
 * Наши категории.
 *
 * Список шире, чем у сигналов: лидерборд различает больше видов,
 * и терять эти различия при переводе нельзя — снайпер и умные
 * деньги ведут себя противоположно.
 */
export type WalletCategory =
  | 'smart_money'
  | 'kol'
  | 'whale'
  | 'developer'
  | 'new_wallet'
  | 'insider'
  | 'sniper'
  | 'phishing_suspect'
  | 'bundled_trader'
  | 'pump_smart_money'
  | 'unknown';

/**
 * Категории, за которыми имеет смысл повторять покупки.
 *
 * Всё остальное — либо шум, либо прямая опасность. Снайпер входит
 * в первом блоке и выходит через минуту; подозреваемый в фишинге
 * покупает то, что продаёт жертвам; сборщик пакетов создаёт видимость
 * спроса. Повторять за ними — покупать чужую приманку.
 */
export const COPYABLE_CATEGORIES: ReadonlySet<WalletCategory> = new Set([
  'smart_money',
  'kol',
  'whale',
  'pump_smart_money',
]);

/**
 * Категории, само присутствие которых — повод насторожиться.
 *
 * Отдельно от «не копировать»: эти адреса не просто бесполезны
 * как ориентир, их покупка ухудшает оценку токена.
 */
export const ADVERSE_CATEGORIES: ReadonlySet<WalletCategory> = new Set([
  'phishing_suspect',
  'bundled_trader',
  'sniper',
  'insider',
]);

// ─────────────────── Latest Signal List: /signal/list ───────────────────────

/**
 * Словарь эндпоинта свежих сигналов.
 *
 * Ровно три значения. Всё, что вне их, — `unknown`, а не догадка:
 * OKX добавляет категории, и молчаливое отнесение новой цифры
 * к умным деньгам было бы худшим из возможных умолчаний.
 */
const SIGNAL_LIST_WALLET_TYPES: Record<string, WalletCategory> = {
  '1': 'smart_money',
  '2': 'kol',
  '3': 'whale',
};

/** Разбор `walletType` из ответа Latest Signal List. */
export function walletCategoryFromSignalList(raw: unknown): WalletCategory {
  return SIGNAL_LIST_WALLET_TYPES[normalizeCode(raw)] ?? 'unknown';
}

/** Код для запроса к Latest Signal List. null — категории там нет. */
export function signalListWalletType(category: WalletCategory): string | null {
  const found = Object.entries(SIGNAL_LIST_WALLET_TYPES).find(([, v]) => v === category);
  return found?.[0] ?? null;
}

// ───────────── Smart Money Leaderboard: /leaderboard/list ────────────────────

/**
 * Словарь лидерборда.
 *
 * Десять значений, и первые четыре не совпадают с сигнальными
 * ни в одной позиции. Проверено по документации эндпоинта
 * `GET /api/v6/dex/market/leaderboard/list`.
 */
const LEADERBOARD_WALLET_TYPES: Record<string, WalletCategory> = {
  '1': 'kol',
  '2': 'developer',
  '3': 'smart_money',
  '4': 'whale',
  '5': 'new_wallet',
  '6': 'insider',
  '7': 'sniper',
  '8': 'phishing_suspect',
  '9': 'bundled_trader',
  '10': 'pump_smart_money',
};

/** Разбор `walletType` из ответа лидерборда. */
export function walletCategoryFromLeaderboard(raw: unknown): WalletCategory {
  return LEADERBOARD_WALLET_TYPES[normalizeCode(raw)] ?? 'unknown';
}

/** Код для запроса к лидерборду. null — категории там нет. */
export function leaderboardWalletType(category: WalletCategory): string | null {
  const found = Object.entries(LEADERBOARD_WALLET_TYPES).find(([, v]) => v === category);
  return found?.[0] ?? null;
}

// ───────────────────────────── Общее ────────────────────────────────────────

/**
 * Приведение кода к строке.
 *
 * OKX присылает то число, то строку, в зависимости от эндпоинта
 * и версии. Сравнивать их напрямую нельзя: `1 !== '1'`, и вся
 * таблица тихо перестала бы находить совпадения.
 */
function normalizeCode(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  if (typeof raw === 'string') return raw.trim();
  return '';
}

/** Название категории для интерфейса. */
export const WALLET_CATEGORY_LABEL: Record<WalletCategory, string> = {
  smart_money: 'Умные деньги',
  kol: 'Инфлюенсер',
  whale: 'Кит',
  developer: 'Разработчик',
  new_wallet: 'Новый кошелёк',
  insider: 'Инсайдер',
  sniper: 'Снайпер',
  phishing_suspect: 'Подозрение на фишинг',
  bundled_trader: 'Связанная торговля',
  pump_smart_money: 'Умные деньги pump',
  unknown: 'Категория неизвестна',
};

/** Стоит ли повторять покупки этой категории. */
export function isCopyable(category: WalletCategory): boolean {
  return COPYABLE_CATEGORIES.has(category);
}

/** Ухудшает ли присутствие этой категории оценку токена. */
export function isAdverse(category: WalletCategory): boolean {
  return ADVERSE_CATEGORIES.has(category);
}
