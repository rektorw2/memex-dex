import type { Chain } from '@prisma/client';
import { Decimal } from 'decimal.js';
import {
  fetchHotTokens,
  fetchPriceInfo,
  isOkxConfigured as isOkxMarketConfigured,
  safeCall,
} from './okx-market.js';

/**
 * Клиент официального Web3 API OKX.
 *
 * Почему официальный API, а не разбор запросов страницы Signal/Radar:
 * внутренние эндпоинты интерфейса не документированы, меняются без
 * предупреждения и их использование прямо запрещено пользовательским
 * соглашением. Радар, который ломается при каждом обновлении чужого
 * фронтенда, — это не функция, а источник ложной тишины: уведомления
 * просто перестанут приходить, и заметить это будет нечем.
 *
 * Каждый запрос подписывается HMAC-SHA256 по схеме OKX:
 * подпись считается от строки timestamp + METHOD + path + body.
 */

/** Идентификаторы сетей в OKX. Robinhood Chain пока не поддерживается. */
const OKX_CHAIN: Record<Chain, string | null> = {
  ETHEREUM: '1',
  BNB: '56',
  BASE: '8453',
  SOLANA: '501',
  ROBINHOOD: null,
};

export function isOkxConfigured(): boolean {
  return isOkxMarketConfigured();
}

export function isOkxSupported(chain: Chain): boolean {
  return OKX_CHAIN[chain] !== null;
}

export interface OkxToken {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  logoUrl: string | null;
}

/**
 * Список токенов сети из агрегатора OKX.
 *
 * Это не «новые токены» — это перечень того, что OKX считает торгуемым.
 * Новизна определяется на нашей стороне: адрес, которого мы раньше
 * не видели, и есть новый токен. Такой подход честнее, чем доверять
 * чужому определению «нового», и не зависит от того, какие поля
 * поставщик решит отдавать завтра.
 */
export async function fetchOkxTokens(chain: Chain): Promise<OkxToken[]> {
  const chainId = OKX_CHAIN[chain];
  if (!chainId) return [];

  /*
   * Старый `/api/v5/dex/aggregator/all-tokens` снят с поддержки.
   * Для радара нужен не полный справочник из тысяч контрактов, а
   * свежие торгуемые кандидаты, поэтому используем уже проверенный
   * v6 market-клиент и его общий лимит запросов.
   */
  const data = await fetchHotTokens(chain as never, { limit: 100, liquidityMin: 0 });

  return data.map((t) => ({
    chain,
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals ?? (chain === 'SOLANA' ? 9 : 18),
    priceUsd: t.priceUsd,
    liquidityUsd: t.liquidityUsd,
    volume24hUsd: t.volume24hUsd,
    fdvUsd: t.marketCapUsd,
    logoUrl: t.logoUrl,
  }));
}

/** Подробности по конкретному токену: цена, объём, ликвидность. */
export async function fetchOkxTokenDetail(
  chain: Chain,
  address: string,
): Promise<Partial<OkxToken> | null> {
  const chainId = OKX_CHAIN[chain];
  if (!chainId) return null;

  // v6 принимает POST-пакет. Старый v5 GET отвечает
  // `Request method GET not supported` и оставляет карточку без цены.
  const result = await fetchPriceInfo([{ chain: chain as never, address }], { fresh: true });
  const d = [...result.prices.values()].find(
    (row) => row.chain === chain && row.address.toLowerCase() === address.toLowerCase(),
  );
  if (!d) return null;

  return {
    priceUsd: d.priceUsd,
    liquidityUsd: d.liquidityUsd,
    volume24hUsd: d.volume.h24,
    fdvUsd: d.marketCapUsd,
  };
}

// ─────────────────────── Проверка возможности выхода ────────────────────────

/**
 * Котировочные токены для проверки обмена.
 *
 * Берём нативный токен сети, а не USDC: пул с нативным есть почти
 * у каждого мем-коина, а с USDC — далеко не у всех, и отсутствие
 * маршрута через USDC ничего не говорит о токене.
 */
const NATIVE_TOKEN: Record<Chain, string | null> = {
  ETHEREUM: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  BNB: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  BASE: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  SOLANA: 'So11111111111111111111111111111111111111112',
  ROBINHOOD: null,
};

export interface RoundTripResult {
  /** Удалось ли получить котировку на покупку. */
  canBuy: boolean;
  /** Удалось ли получить котировку на продажу обратно. */
  canSell: boolean;
  /**
   * Доля от вложенного, которая вернётся при немедленном выходе.
   * 0.97 означает потерю в 3% — это нормальная цена двух обменов.
   * 0.1 означает ловушку.
   */
  returnRatio: number | null;
  reason: string;
}

/**
 * Актуальный v6-маршрут котировки.
 *
 * Вынесен в чистую функцию: версия и набор параметров являются
 * контрактом с провайдером и должны проверяться без живого ключа.
 */
export function quotePath(
  chainIndex: string,
  fromTokenAddress: string,
  toTokenAddress: string,
  amount: string,
): string {
  const params = new URLSearchParams({
    chainIndex,
    fromTokenAddress,
    toTokenAddress,
    amount,
    swapMode: 'exactIn',
  });
  return `/api/v6/dex/aggregator/quote?${params.toString()}`;
}

/**
 * Приводит количество в минимальных единицах токена к целой строке.
 *
 * OKX возвращает такие значения строками, потому что для 18 знаков после
 * запятой они быстро выходят за безопасный диапазон JavaScript number.
 * Преобразование через Number превращало их в `1.43e+23`; API котировки
 * такой формат не принимает и отвечал `Parameter amount error`.
 */
function atomicAmount(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
  } else if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const amount = new Decimal(value);
    if (!amount.isFinite() || !amount.isInteger() || amount.lte(0)) return null;
    return amount.toFixed(0);
  } catch {
    return null;
  }
}

/**
 * Замер полного круга: купить и сразу продать обратно.
 *
 * Это самая честная проверка из возможных, потому что она не полагается
 * на чужое мнение о токене. Списки безопасности отвечают «мы не нашли
 * признаков ловушки»; агрегатор отвечает «вот сколько вы получите,
 * если решите выйти прямо сейчас».
 *
 * Ловушку видно сразу и в двух видах. Либо котировка на продажу вообще
 * не строится — маршрута наружу нет. Либо она строится, но возвращает
 * десятую часть вложенного: продать формально можно, фактически некуда.
 *
 * Проверка стоит два запроса на токен, поэтому применяется выборочно —
 * к тем, кто уже прошёл остальные проверки и претендует на попадание
 * в витрину.
 */
export async function checkRoundTrip(
  chain: Chain,
  tokenAddress: string,
  probeUsd = 100,
): Promise<RoundTripResult> {
  const chainId = OKX_CHAIN[chain];
  const native = NATIVE_TOKEN[chain];

  if (!chainId || !native || !isOkxConfigured()) {
    return { canBuy: false, canSell: false, returnRatio: null, reason: 'Проверка недоступна' };
  }

  // Сумма пробы в единицах нативного токена. Точность здесь не важна:
  // проверяется не цена, а сама возможность обмена, и порядок величины
  // достаточен, чтобы маршрут строился по реальной ликвидности,
  // а не по пылинке.
  const probe = new Decimal(probeUsd);
  if (!probe.isFinite() || probe.lte(0)) {
    return { canBuy: false, canSell: false, returnRatio: null, reason: 'Некорректная сумма проверки' };
  }

  const probeAmount = chain === 'SOLANA'
    ? probe.mul('1000000000').div(150).round().toFixed(0) // ~SOL в лампортах
    : probe.mul('1000000000000000000').div(2500).round().toFixed(0); // ~ETH/BNB в wei

  const buy = await safeCall<any[]>(
    'GET',
    quotePath(chainId, native, tokenAddress, probeAmount),
  );

  const buyOut = atomicAmount(buy?.[0]?.toTokenAmount);
  if (buyOut === null) {
    return {
      canBuy: false,
      canSell: false,
      returnRatio: null,
      reason: 'Агрегатор не строит маршрут на покупку — ликвидности нет',
    };
  }

  // Обратный обмен на то количество, которое реально получили бы.
  const sell = await safeCall<any[]>(
    'GET',
    quotePath(chainId, tokenAddress, native, buyOut),
  );

  const sellOut = atomicAmount(sell?.[0]?.toTokenAmount);
  if (sellOut === null) {
    return {
      canBuy: true,
      canSell: false,
      returnRatio: 0,
      reason: 'Купить можно, продать нельзя — маршрут наружу не строится',
    };
  }

  const returnRatio = new Decimal(sellOut).div(probeAmount).toNumber();

  return {
    canBuy: true,
    canSell: true,
    returnRatio,
    reason: `Круг покупка-продажа возвращает ${(returnRatio * 100).toFixed(1)}% вложенного`,
  };
}
