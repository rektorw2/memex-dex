/**
 * Подделки под известные названия и клоны внутри витрины.
 *
 * Проверка контракта этот класс не ловит вообще: у токена может быть
 * сожжённая ликвидность, отключённый mint и честные налоги — и при этом
 * он называется NVDA и выдаёт себя за акцию NVIDIA. Формально придраться
 * не к чему, покупает его человек по недоразумению.
 *
 * Признаков два, и они разные по природе.
 *
 * Первый — присвоение чужого имени. Тикеры публичных компаний, крупных
 * криптоактивов и известных брендов у мем-коина взяться неоткуда:
 * настоящая NVIDIA токенов не выпускала.
 *
 * Второй — клоны. Три токена с тикером NVDA и разными адресами — это
 * не совпадение, а рассылка одного шаблона. Даже если один из них
 * «оригинал», отличить его снаружи невозможно, и показывать в списке
 * все три означает гарантированно направить часть людей не туда.
 */

/**
 * Тикеры, которые мем-коин не может носить по совести.
 *
 * Три группы: акции, крупные криптоактивы, бренды. Список заведомо
 * неполон и таким останется — он ловит не всё, а самое частое.
 * Полнота здесь недостижима, а вред от каждого пропущенного меньше,
 * чем от ложного срабатывания на честном названии.
 */
export const PROTECTED_TICKERS = new Set([
  // Акции, которые чаще всего подделывают
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOG', 'GOOGL',
  'HOOD', 'COIN', 'MSTR', 'AMD', 'INTC', 'NFLX', 'SPY', 'QQQ',
  'GME', 'AMC', 'PLTR', 'BABA', 'DIS', 'JPM', 'V', 'MA',

  // Крупные криптоактивы: подделка под них — классика
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'TRX', 'TON',
  'USDT', 'USDC', 'DAI', 'BUSD', 'WBTC', 'WETH', 'STETH',

  // Бренды и организации
  'NIKE', 'TESLA', 'OPENAI', 'NASA', 'FED', 'SEC', 'BLACKROCK',
  'VISA', 'PAYPAL', 'MCDONALDS', 'STARBUCKS',
]);

export interface ImpersonationSignals {
  symbol: string;
  name: string;
  /**
   * Сколько токенов с тем же тикером есть в витрине, включая этот.
   * Единица означает, что клонов нет.
   */
  sameSymbolCount: number;
  /**
   * Ликвидность этого токена и наибольшая среди одноимённых.
   * Нужны, чтобы отличить «оригинал» от копий: у копий ликвидность
   * на порядок меньше.
   */
  liquidityUsd: number | null;
  maxSameSymbolLiquidityUsd: number | null;
}

export interface ImpersonationVerdict {
  /** Токен присвоил защищённое имя. */
  impersonatesKnown: boolean;
  /** Существуют одноимённые токены. */
  hasClones: boolean;
  /** Этот экземпляр — не самый ликвидный среди одноимённых. */
  isMinorClone: boolean;
  reasons: string[];
}

/** Приведение тикера к сравнимому виду. */
function normalize(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    // Подделки часто добавляют доллар, точки и нули вместо букв:
    // $NVDA, N-V-D-A, NVDΑ. Сводим к буквам и цифрам.
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I');
}

export function checkImpersonation(s: ImpersonationSignals): ImpersonationVerdict {
  const reasons: string[] = [];
  const norm = normalize(s.symbol);

  const impersonatesKnown = PROTECTED_TICKERS.has(norm);
  if (impersonatesKnown) {
    reasons.push(`Тикер ${s.symbol} принадлежит известному активу — это подделка`);
  }

  const hasClones = s.sameSymbolCount > 1;

  // «Младший клон» — тот, чья ликвидность заметно меньше лидера.
  // Порог в десять раз, а не любое отличие: у двух честных токенов
  // с совпавшим тикером ликвидность может отличаться вдвое, и это
  // ещё не повод прятать один из них.
  const isMinorClone =
    hasClones &&
    s.liquidityUsd != null &&
    s.maxSameSymbolLiquidityUsd != null &&
    s.maxSameSymbolLiquidityUsd > 0 &&
    s.liquidityUsd * 10 < s.maxSameSymbolLiquidityUsd;

  if (isMinorClone) {
    reasons.push(
      `Ещё ${s.sameSymbolCount - 1} токен(ов) с тикером ${s.symbol}, и этот из них не крупнейший`,
    );
  } else if (hasClones) {
    reasons.push(`Токенов с тикером ${s.symbol} в списке: ${s.sameSymbolCount}`);
  }

  return { impersonatesKnown, hasClones, isMinorClone, reasons };
}

/**
 * Правдоподобность рыночных величин.
 *
 * Отдельно от подделок, но по той же причине: проверка контракта такое
 * не видит. Ликвидность в три с половиной миллиарда у мем-коина на Base
 * означает либо ошибку источника, либо пул, накачанный собственным
 * токеном, — и в обоих случаях число нельзя показывать как факт.
 */
export interface SanityInput {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  priceChange24h: number | null;
}

/**
 * Потолок ликвидности для токена вне первой сотни.
 *
 * Пятьсот миллионов — с большим запасом: у крупнейших мем-коинов
 * ликвидность держится в десятках миллионов. Всё выше почти наверняка
 * посчитано по паре с собственным токеном проекта.
 */
export const MAX_PLAUSIBLE_LIQUIDITY_USD = 500_000_000;

/** Рост за сутки, выше которого цена почти всегда нарисована. */
export const MAX_PLAUSIBLE_CHANGE_PCT = 10_000;

export function checkSanity(s: SanityInput): string[] {
  const problems: string[] = [];

  if (s.liquidityUsd != null && s.liquidityUsd > MAX_PLAUSIBLE_LIQUIDITY_USD) {
    problems.push(
      `Ликвидность $${(s.liquidityUsd / 1e9).toFixed(2)}B неправдоподобна — ` +
        'скорее всего пул оценён по собственному токену проекта',
    );
  }

  if (s.fdvUsd != null && s.liquidityUsd != null && s.liquidityUsd > 0) {
    // Капитализация в тысячи раз выше ликвидности означает, что почти
    // всё предложение неторгуемо: продать сколько-нибудь заметный объём
    // не получится ни по какой цене.
    const ratio = s.fdvUsd / s.liquidityUsd;
    if (ratio > 1000) {
      problems.push(
        `Капитализация в ${Math.round(ratio)} раз выше ликвидности — выйти из позиции будет не по чем`,
      );
    }
  }

  if (
    s.priceChange24h != null &&
    Math.abs(s.priceChange24h) > MAX_PLAUSIBLE_CHANGE_PCT
  ) {
    problems.push(
      `Изменение цены ${s.priceChange24h > 0 ? '+' : ''}${Math.round(s.priceChange24h)}% за сутки — ` +
        'такое движение на мелком пуле создаётся одной сделкой',
    );
  }

  return problems;
}
