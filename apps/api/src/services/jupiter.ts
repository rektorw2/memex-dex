import { logger } from '../lib/logger.js';

/**
 * Jupiter Tokens API — проверка токенов Solana.
 *
 * Ценность именно для нашего случая: весь мусор, который мы видели
 * в терминале, был на Solana, а Jupiter ведёт по ней собственный
 * реестр с готовыми метками. Это не ещё один источник цены — это
 * чужое решение о токене, принятое площадкой, которая обрабатывает
 * основную долю обменов в сети.
 *
 * Ключа не требует. Лимит щедрый, но не бесконечный, поэтому ответы
 * кешируются: свойства токена в реестре меняются редко, а спрашивать
 * о них при каждом проходе воркера незачем.
 *
 * Метки, которые нас интересуют:
 *   verified — токен в проверенном списке Jupiter;
 *   banned   — исключён, обычно за мошенничество;
 *   isSus    — помечен как подозрительный по итогам их аудита.
 */

const API = 'https://lite-api.jup.ag/tokens/v2';

/** Свойства токена в реестре меняются редко — держим полчаса. */
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  /** Токен в проверенном списке. */
  isVerified: boolean;
  /** Исключён из реестра. */
  isBanned: boolean;
  /** Помечен аудитом как подозрительный. */
  isSuspicious: boolean;
  /** Доля предложения у топ-10 держателей, %. */
  topHoldersPct: number | null;
  /** Оценка органичности активности, 0-100. */
  organicScore: number | null;
  holderCount: number | null;
  /** Права эмитента: активны или отозваны. */
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  /** Метки Jupiter: lst, verified, strict и прочие. */
  tags: string[];
}

const cache = new Map<string, { value: JupiterToken | null; at: number }>();

function fromCache(address: string): { hit: boolean; value: JupiterToken | null } {
  const entry = cache.get(address);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return { hit: false, value: null };
  return { hit: true, value: entry.value };
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parse(raw: any): JupiterToken | null {
  if (!raw?.id && !raw?.address) return null;

  const tags: string[] = Array.isArray(raw.tags) ? raw.tags : [];
  const audit = raw.audit ?? {};

  return {
    address: raw.id ?? raw.address,
    symbol: raw.symbol ?? '',
    name: raw.name ?? '',
    isVerified: tags.includes('verified') || raw.isVerified === true,
    // Статус приходит строкой; сравниваем в нижнем регистре, потому что
    // регистр в ответах несогласован между версиями API.
    isBanned: String(raw.status ?? '').toLowerCase() === 'banned',
    isSuspicious: audit.isSus === true,
    topHoldersPct: num(audit.topHoldersPercentage),
    organicScore: num(raw.organicScore),
    holderCount: num(raw.holderCount),
    // Значение null означает «не сообщили», а не «отозвано»: путать
    // эти два случая в проверке безопасности нельзя.
    mintAuthorityActive:
      audit.mintAuthorityDisabled == null ? null : audit.mintAuthorityDisabled !== true,
    freezeAuthorityActive:
      audit.freezeAuthorityDisabled == null ? null : audit.freezeAuthorityDisabled !== true,
    tags,
  };
}

/**
 * Сведения о токене Solana.
 *
 * Возвращает null, если Jupiter о токене не знает. Незнание само по себе
 * слабый сигнал: реестр не обязан содержать всё, что торгуется. Но для
 * токена с защищённым тикером отсутствие в реестре — довод против:
 * настоящий актив там был бы.
 */
export async function fetchJupiterToken(address: string): Promise<JupiterToken | null> {
  const cached = fromCache(address);
  if (cached.hit) return cached.value;

  try {
    const res = await fetch(`${API}/search?query=${encodeURIComponent(address)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      logger.debug({ address, status: res.status }, 'Jupiter: запрос не удался');
      // Неудачу не кешируем: иначе временный сбой закрепится на полчаса
      // и токен всё это время будет считаться неизвестным.
      return null;
    }

    const json: any = await res.json();
    const list: any[] = Array.isArray(json) ? json : (json?.tokens ?? []);

    // Поиск возвращает похожие совпадения — берём точное по адресу.
    // Совпадение по символу здесь взяли бы подделку вместо оригинала.
    const exact = list.find((t) => (t?.id ?? t?.address) === address);
    const value = exact ? parse(exact) : null;

    cache.set(address, { value, at: Date.now() });
    return value;
  } catch (e: any) {
    logger.debug({ address, err: e?.message }, 'Jupiter недоступен');
    return null;
  }
}

/** Размер кеша — для диагностики. */
export function jupiterCacheSize(): number {
  return cache.size;
}
