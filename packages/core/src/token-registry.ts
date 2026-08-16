/**
 * Реестр подтверждённых токенов.
 *
 * Решает задачу, которую нельзя решить проверкой по тикеру. Прошлая
 * версия блокировала любой токен с символом NVDA — включая настоящую
 * токенизированную акцию, если бы она появилась. Это ложное
 * срабатывание, и для площадки оно хуже пропуска: пропущенную подделку
 * человек может распознать сам, а заблокированный настоящий актив он
 * просто не увидит и не узнает, что тот был.
 *
 * Правильная формулировка признака не «тикер известный», а «тикер
 * известный, но адрес не тот». Второе проверяемо, первое — нет.
 *
 * Идентификатор токена здесь и везде — пара сеть плюс адрес контракта.
 * Ни символ, ни название идентификаторами не являются: их может
 * присвоить кто угодно, и именно на этом строятся подделки.
 */

export type ChainKey = 'ETHEREUM' | 'BNB' | 'BASE' | 'SOLANA' | 'ROBINHOOD';

/** Числовые идентификаторы сетей. Solana их не использует. */
export const CHAIN_IDS: Record<ChainKey, number | null> = {
  ETHEREUM: 1,
  BNB: 56,
  BASE: 8453,
  SOLANA: null,
  ROBINHOOD: null,
};

export type AssetTag = 'stablecoin' | 'major' | 'stocks' | 'wrapped';

export interface RegistryEntry {
  chain: ChainKey;
  /** Адрес в нормализованном виде. */
  address: string;
  symbol: string;
  name: string;
  tags: AssetTag[];
}

/**
 * Нормализация адреса.
 *
 * У EVM регистр не значим — адрес в нижнем регистре и в контрольной
 * сумме это один адрес, и сравнивать их как строки нельзя. У Solana
 * регистр значим: base58 различает O и o, и приведение сломало бы
 * адрес.
 */
export function normalizeAddress(chain: ChainKey, address: string): string {
  const trimmed = address.trim();
  return chain === 'SOLANA' ? trimmed : trimmed.toLowerCase();
}

/** Единый идентификатор токена: сеть плюс адрес. Больше ничего. */
export function tokenKey(chain: ChainKey, address: string): string {
  return `${chain}:${normalizeAddress(chain, address)}`;
}

/**
 * Подтверждённые адреса.
 *
 * Список намеренно короткий и содержит только то, что проверено
 * вручную. Длинный автоматически собранный реестр опаснее короткого
 * ручного: в него попадает то, чего никто не смотрел, и доверие
 * к метке «проверен» обесценивается целиком.
 */
export const REGISTRY: RegistryEntry[] = [
  // ─── Стейблкоины ────────────────────────────────────────────────
  {
    chain: 'ETHEREUM',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC', name: 'USD Coin', tags: ['stablecoin'],
  },
  {
    chain: 'ETHEREUM',
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: 'USDT', name: 'Tether USD', tags: ['stablecoin'],
  },
  {
    chain: 'BASE',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC', name: 'USD Coin', tags: ['stablecoin'],
  },
  {
    chain: 'BNB',
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    symbol: 'USDC', name: 'USD Coin', tags: ['stablecoin'],
  },
  {
    chain: 'BNB',
    address: '0x55d398326f99059ff775485246999027b3197955',
    symbol: 'USDT', name: 'Tether USD', tags: ['stablecoin'],
  },
  {
    chain: 'SOLANA',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC', name: 'USD Coin', tags: ['stablecoin'],
  },
  {
    chain: 'SOLANA',
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT', name: 'Tether USD', tags: ['stablecoin'],
  },

  // ─── Обёрнутые нативные ─────────────────────────────────────────
  {
    chain: 'SOLANA',
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL', name: 'Wrapped SOL', tags: ['major', 'wrapped'],
  },
  {
    chain: 'ETHEREUM',
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH', name: 'Wrapped Ether', tags: ['major', 'wrapped'],
  },
  {
    chain: 'BASE',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH', name: 'Wrapped Ether', tags: ['major', 'wrapped'],
  },
  {
    chain: 'BNB',
    address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    symbol: 'WBNB', name: 'Wrapped BNB', tags: ['major', 'wrapped'],
  },

  // ─── Токенизированные акции ─────────────────────────────────────
  // Раздел пустой намеренно. Настоящие токенизированные акции
  // существуют, но их адреса нужно проверять поимённо у эмитента,
  // а не переписывать из агрегатора. Пока раздел пуст, любой токен
  // с тикером акции считается подделкой — это верно для всего,
  // что мы видели, и безопасно ошибается в нужную сторону.
];

/** Быстрый доступ по ключу. */
const BY_KEY = new Map(REGISTRY.map((e) => [tokenKey(e.chain, e.address), e]));

/** Символы, занятые подтверждёнными активами. */
const REGISTERED_SYMBOLS = new Set(REGISTRY.map((e) => normalizeSymbol(e.symbol)));

/**
 * Приведение символа к сравнимому виду.
 *
 * Подделки маскируются приписками и заменой похожих знаков: $NVDA,
 * N.V.D.A, H00D с нулями. Сводим к буквам и цифрам, затем заменяем
 * визуально неотличимые цифры на буквы.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I');
}

/**
 * Тикеры, которые мем-коин не может носить по совести.
 *
 * Две группы: крупные криптоактивы и бренды. Список неполон и таким
 * останется — он ловит частое. Полнота недостижима, а ложное
 * срабатывание на честном названии дороже пропуска.
 *
 * Биржевых тикеров здесь намеренно нет, хотя раньше были. Причина
 * в том, что статический список не различал подделку и настоящий
 * токенизированный актив: он блокировал бы и фальшивый NVDA,
 * и выпущенный xStocks. Для бумаг нужен реестр адресов эмитента,
 * а не перечень запрещённых имён, — этим занимается rwa.ts.
 *
 * Криптоактивы и бренды остаются здесь, потому что для них вопрос
 * решается однозначно: настоящий USDC есть в REGISTRY, а токенов
 * от NASA и Anthropic не существует вовсе.
 */
export const PROTECTED_SYMBOLS = new Set([
  // Крупные криптоактивы
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'TRX', 'TON',
  'USDT', 'USDC', 'DAI', 'BUSD', 'WBTC', 'WETH', 'WBNB', 'STETH',
  // Бренды и организации, токенов не выпускавшие
  'NIKE', 'TESLA', 'OPENAI', 'ANTHROPIC', 'NASA', 'FED', 'SEC',
  'BLACKROCK', 'VISA', 'PAYPAL',
]);

export interface AuthenticityCheck {
  /** Токен есть в реестре подтверждённых. */
  isVerified: boolean;
  /** Тикер защищён, но адрес не совпадает с подтверждённым. */
  isImpersonation: boolean;
  entry: RegistryEntry | null;
  reason: string | null;
}

/**
 * Проверка подлинности.
 *
 * Ключевое отличие от прежней логики: сначала смотрим адрес, потом
 * тикер. Токен из реестра проходит всегда, даже если его символ
 * защищён — он и есть тот, кого защищают.
 */
export function checkAuthenticity(
  chain: ChainKey,
  address: string,
  symbol: string,
): AuthenticityCheck {
  const entry = BY_KEY.get(tokenKey(chain, address)) ?? null;

  if (entry) {
    return {
      isVerified: true,
      isImpersonation: false,
      entry,
      reason: null,
    };
  }

  const norm = normalizeSymbol(symbol);

  if (PROTECTED_SYMBOLS.has(norm) || REGISTERED_SYMBOLS.has(norm)) {
    return {
      isVerified: false,
      isImpersonation: true,
      entry: null,
      reason:
        `Тикер ${symbol} принадлежит известному активу, но адрес контракта ` +
        'не совпадает с подтверждённым — это подделка',
    };
  }

  return { isVerified: false, isImpersonation: false, entry: null, reason: null };
}

/** Есть ли токен в реестре. */
export function isRegistered(chain: ChainKey, address: string): boolean {
  return BY_KEY.has(tokenKey(chain, address));
}

/**
 * Дедупликация по паре сеть-адрес.
 *
 * Отдельная функция, потому что дубликаты приходят из разных источников
 * с разным регистром адреса, и наивное сравнение строк их не ловит.
 * При совпадении остаётся первый — вызывающий сам решает порядок,
 * обычно по убыванию ликвидности.
 */
export function dedupeByAddress<T extends { chain: ChainKey; address: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of items) {
    const key = tokenKey(item.chain, item.address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}
