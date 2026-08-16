/**
 * Шкала риска для показа человеку.
 *
 * Отдельно от risk-model.ts, потому что решает другую задачу. Тот
 * отвечает на вопрос «пускать ли токен в торговлю» — там шесть
 * состояний, включая «не проверен» и «заблокирован», и они про допуск.
 * Здесь вопрос другой: «насколько это опасно» — и ответом должно быть
 * что-то, что читается за секунду.
 *
 * Три правила, которые здесь соблюдаются жёстко.
 *
 * Первое: цветом одним обойтись нельзя. Около восьми процентов мужчин
 * не различают красный и зелёный, и полоска, у которой всё значение
 * в оттенке, для них пуста. Поэтому уровень всегда несёт три признака
 * сразу — цвет, подпись и знак.
 *
 * Второе: направление шкалы должно быть очевидно. «Риск 50» само по себе
 * не говорит, много это или мало, и не говорит даже, больше — хуже или
 * лучше. Поэтому подпись идёт перед числом, а число со знаменателем:
 * «Средний риск · 50/100».
 *
 * Третье: ноль не означает безопасность. Он означает, что мы не нашли
 * причин, а это разные утверждения — особенно для токена, которому
 * двадцать минут от роду.
 */

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

export interface RiskBandInfo {
  band: RiskBand;
  /** Подпись для человека. Идёт перед числом. */
  label: string;
  /** Знак, дублирующий цвет. Читается без различения оттенков. */
  sign: string;
  /** Ключ цвета в палитре. Никогда не единственный носитель смысла. */
  tone: 'up' | 'warn' | 'riskHigh' | 'down';
  /** Нижняя граница диапазона включительно. */
  from: number;
  /** Верхняя граница включительно. */
  to: number;
}

/**
 * Ступени шкалы.
 *
 * Границы выбраны так, чтобы «средний» покрывал самую населённую
 * часть распределения: на мем-коинах нормальный токен набирает
 * тридцать-пятьдесят баллов за незалоченный пул и юный возраст,
 * и объявлять такое высоким риском значит обесценить слово «высокий».
 */
export const RISK_BANDS: RiskBandInfo[] = [
  { band: 'low', label: 'Низкий риск', sign: '✓', tone: 'up', from: 0, to: 29 },
  { band: 'medium', label: 'Средний риск', sign: '!', tone: 'warn', from: 30, to: 59 },
  { band: 'high', label: 'Высокий риск', sign: '!!', tone: 'riskHigh', from: 60, to: 79 },
  { band: 'critical', label: 'Критический риск', sign: '✕', tone: 'down', from: 80, to: 100 },
];

export function riskBand(score: number | null | undefined): RiskBandInfo | null {
  if (score == null || !Number.isFinite(score)) return null;
  const s = Math.max(0, Math.min(100, score));
  return RISK_BANDS.find((b) => s >= b.from && s <= b.to) ?? RISK_BANDS[RISK_BANDS.length - 1]!;
}

/** Полная подпись: «Средний риск · 50/100». */
export function riskLabel(score: number | null | undefined): string {
  const b = riskBand(score);
  if (!b) return 'Риск не оценён';
  return `${b.label} · ${Math.round(score!)}/100`;
}

// ─────────────────────────── Причины риска ──────────────────────────────────

/**
 * Человеческие названия для кодов причин.
 *
 * Коды машиночитаемы и по ним удобно фильтровать, но показывать
 * MINT_AUTHORITY_ACTIVE человеку — значит требовать от него знания
 * наших внутренностей. Здесь короткие подписи для плашек: не описание
 * проблемы, а её имя, чтобы поместилось в строку карточки.
 */
export const RISK_CODE_LABELS: Record<string, string> = {
  HONEYPOT: 'Ловушка: не продать',
  SELL_FAILED: 'Продажа не проходит',
  CANNOT_SELL_ALL: 'Продать можно не всё',
  HIGH_SELL_TAX: 'Высокий налог на продажу',
  MALICIOUS_CONTRACT: 'Вредоносный контракт',
  BALANCE_MUTABLE: 'Баланс можно изменить',
  TRANSFER_BLACKLIST: 'Чёрный список переводов',
  JUPITER_BANNED: 'Исключён из Jupiter',
  JUPITER_SUSPICIOUS: 'Подозрителен по версии Jupiter',
  FAKE_SYMBOL: 'Поддельный тикер',
  FAKE_RWA_TICKER: 'Поддельная акция',
  LOW_LIQUIDITY: 'Низкая ликвидность',
  CREATOR_CONTROLS_SUPPLY: 'Создатель владеет выпуском',
  FREEZE_AUTHORITY_ACTIVE: 'Freeze authority активен',
  DANGEROUS_TOKEN_EXTENSION: 'Опасное расширение токена',
  SOURCE_PRICE_MISMATCH: 'Источники расходятся в цене',
  IMPLAUSIBLE_METRICS: 'Неправдоподобные числа',
  OKX_HIGH_RISK: 'Высокий риск по версии OKX',
  RUGCHECK_CRITICAL: 'Критично по версии RugCheck',
  DEV_RUG_HISTORY: 'Создатель бросал токены',

  MINT_AUTHORITY_ACTIVE: 'Mint authority активен',
  UNLOCKED_LIQUIDITY: 'LP не заблокирован',
  OWNER_CAN_MODIFY: 'Владелец меняет правила',
  ELEVATED_SELL_TAX: 'Повышенный налог',
  HIGH_HOLDER_CONCENTRATION: 'Высокая концентрация',
  HIGH_TOP10_CONCENTRATION: 'Топ-10 держат много',
  HIGH_DEV_HOLDING: 'Большая доля создателя',
  HIGH_BUNDLE_HOLDING: 'Связанные кошельки',
  SUSPICIOUS_HOLDERS: 'Подозрительные адреса',
  HIGH_SNIPER_HOLDING: 'Много снайперов',
  DEV_SOLD_HOLDINGS: 'Создатель продаёт',
  FEW_HOLDERS: 'Мало держателей',
  SUSPICIOUS_VOLUME: 'Подозрительный оборот',
  ONE_SIDED_TRADING: 'Покупки без продаж',
  YOUNG_POOL: 'Юный пул',
  DUPLICATE_SYMBOL: 'Тикер не уникален',
  MINOR_CLONE: 'Клон крупного токена',
  COSTLY_ROUND_TRIP: 'Дорогой выход',
  SINGLE_SOURCE: 'Знает один источник',
  OKX_CAUTION: 'Замечания OKX',
  UNVERIFIED_RWA_CLAIM: 'Претензия на акцию',
  SECURITY_DATA_UNAVAILABLE: 'Контракт не проверен',
  MARKET_DATA_UNAVAILABLE: 'Нет рыночных данных',
};

export function riskCodeLabel(code: string): string {
  return RISK_CODE_LABELS[code] ?? code;
}

/**
 * Порядок показа причин.
 *
 * В карточке помещаются две, и это должны быть две самые весомые.
 * Сортировка по весу, а не по порядку появления: иначе наверх попадает
 * то, что проверялось первым, а не то, что важнее.
 */
export function sortReasonsByWeight<T extends { weight?: number; code: string }>(
  reasons: T[],
): T[] {
  return [...reasons].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

// ────────────────────────── Время и длительности ────────────────────────────

/**
 * Относительное время: «4 мин назад».
 *
 * Голое «04:06» на карточке находки читается как что угодно — время
 * обнаружения, возраст пула, время последнего обновления. Радар живёт
 * минутами, и человеку нужна давность, а не отметка на часах.
 */
export function timeAgo(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  if (!Number.isFinite(t)) return '—';

  const sec = Math.max(0, (now - t) / 1000);

  if (sec < 45) return 'только что';
  if (sec < 90) return '1 мин назад';

  const min = sec / 60;
  if (min < 60) return `${Math.round(min)} мин назад`;

  const h = min / 60;
  // До суток — часы с одним знаком только когда это что-то добавляет.
  if (h < 24) return `${Math.round(h)} ч назад`;

  const d = h / 24;
  if (d < 30) return `${Math.round(d)} д назад`;
  return `${Math.round(d / 30)} мес назад`;
}

/**
 * Длительность как свойство, а не как давность: «12 мин», «2 ч».
 *
 * Отдельно от timeAgo, потому что «возраст пула 12 мин» и «найден
 * 12 минут назад» — разные утверждения, и приписка «назад» во втором
 * случае обязательна, а в первом бессмысленна.
 *
 * Значение меньше минуты даёт «<1 мин», а не «0.0 ч». Ноль с десятичной
 * долей выглядит как сбой измерения и заставляет усомниться в остальных
 * числах на карточке.
 */
export function formatAge(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return '—';

  const min = hours * 60;
  if (min < 1) return '<1 мин';
  if (min < 60) return `${Math.round(min)} мин`;
  if (hours < 24) return hours < 10 ? `${hours.toFixed(1)} ч` : `${Math.round(hours)} ч`;

  const d = hours / 24;
  return d < 10 ? `${d.toFixed(1)} д` : `${Math.round(d)} д`;
}

/** Точное время обнаружения, когда нужна именно отметка: «Обнаружен в 04:06». */
export function exactTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// ──────────────────────────── Кратность ─────────────────────────────────────

export interface MultipleView {
  /** Показывать ли вообще: пока ничего не произошло, показывать нечего. */
  meaningful: boolean;
  /** «+18%» или «−32%». */
  currentPct: string;
  /** «1.32×». */
  peak: string;
  /** Текущее значение выше единицы. */
  isUp: boolean;
  /** Пик заметно выше текущего: момент упущен. */
  fadedFromPeak: boolean;
}

/**
 * Как показывать рост.
 *
 * Ключевое решение — что делать, когда ничего не произошло. Пара
 * «Пик 1.00× · Сейчас 1.00×», набранная крупно, занимает самое видное
 * место карточки и не сообщает ничего. Для только что найденного токена
 * это ещё и норма, а не исключение: наблюдение началось минуту назад.
 *
 * Поэтому у такого состояния отдельный признак, а интерфейс показывает
 * вместо двух чисел короткое «Изменений пока нет».
 */
export function multipleView(
  current: number | null | undefined,
  peak: number | null | undefined,
): MultipleView {
  const cur = current ?? null;
  const pk = peak ?? null;

  // Порог в один процент: движение меньше — это шум округления,
  // а не результат наблюдения.
  const moved =
    (cur != null && Math.abs(cur - 1) >= 0.01) || (pk != null && Math.abs(pk - 1) >= 0.01);

  const pct = cur == null ? 0 : (cur - 1) * 100;

  return {
    meaningful: moved,
    currentPct: `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`,
    peak: pk == null ? '—' : `${pk.toFixed(pk >= 10 ? 0 : 2)}×`,
    isUp: cur != null && cur >= 1,
    // Половина пути от пика потеряна — момент выхода упущен, и человеку
    // важно видеть это раньше, чем саму кратность.
    fadedFromPeak: cur != null && pk != null && pk > 1.2 && cur < 1 + (pk - 1) * 0.5,
  };
}
