/**
 * Разбор вставленного пользователем текста в адреса токенов.
 *
 * Задача узкая, но нужная: человек, увидевший токен в стороннем
 * приложении, копирует оттуда что придётся — иногда адрес, чаще ссылку,
 * а бывает и целый абзац с несколькими токенами сразу. Требовать
 * «вставьте только адрес» значит гарантированно получать вставленное
 * не туда.
 *
 * Сети распознаются по форме адреса, а не по домену ссылки: домены
 * меняются, а base58 длиной 32-44 без символов 0OIl — это адрес Solana
 * и через год тоже.
 */

export type AddressFamily = 'solana' | 'evm';

export interface TokenRef {
  address: string;
  family: AddressFamily;
  /** Сеть, если её удалось определить по ссылке. */
  chainHint: string | null;
  /** Исходный фрагмент — показывается пользователю при ошибке. */
  raw: string;
}

const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
// Solana: base58 без 0, O, I, l. Длина 32-44.
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Сеть по фрагменту ссылки.
 *
 * Список намеренно неполный: если домен неизвестен, сеть остаётся
 * неопределённой и будет уточнена по данным рынка. Угадывать сеть
 * из адреса EVM нельзя — один и тот же адрес существует
 * в Ethereum, BNB и Base одновременно.
 */
const CHAIN_BY_SLUG: Array<[RegExp, string]> = [
  [/\b(solana|sol)\b/i, 'SOLANA'],
  [/\b(bsc|bnb|binance-smart-chain)\b/i, 'BNB'],
  [/\b(ethereum|eth|mainnet)\b/i, 'ETHEREUM'],
  [/\bbase\b/i, 'BASE'],
];

function detectChain(context: string): string | null {
  for (const [re, chain] of CHAIN_BY_SLUG) {
    if (re.test(context)) return chain;
  }
  return null;
}

/**
 * Ложные срабатывания base58.
 *
 * Хеши транзакций Solana имеют ту же форму, что и адреса, и отличить
 * их по виду невозможно. Зато в ссылках они всегда идут после /tx/.
 * Ещё отсеиваются известные системные адреса: программа токенов и
 * обёрнутый SOL попадают почти в каждую ссылку и адресами токенов
 * в нашем смысле не являются.
 */
const SYSTEM_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  '11111111111111111111111111111111', // System program
]);

/**
 * Извлечение адресов из произвольного текста.
 *
 * Порядок сохраняется, дубликаты убираются: человек, вставивший один
 * токен двумя ссылками, не должен получить две записи.
 */
export function parseTokenRefs(input: string, limit = 50): TokenRef[] {
  if (!input || typeof input !== 'string') return [];

  const seen = new Set<string>();
  const out: TokenRef[] = [];

  // Разбираем построчно: контекст для определения сети — та же строка,
  // где найден адрес. Иначе слово «solana» в первой строке приписало бы
  // Solana всем адресам ниже.
  for (const line of input.split(/[\n\r]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ссылки на транзакции пропускаем целиком: хеш неотличим от адреса.
    if (/\/tx\/|\/transaction\//i.test(trimmed)) continue;

    const chainHint = detectChain(trimmed);

    for (const m of trimmed.match(EVM_RE) ?? []) {
      const addr = m.toLowerCase();
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.push({ address: m, family: 'evm', chainHint, raw: trimmed.slice(0, 120) });
      if (out.length >= limit) return out;
    }

    for (const m of trimmed.match(SOLANA_RE) ?? []) {
      if (SYSTEM_ADDRESSES.has(m)) continue;
      // Адрес EVM без префикса не может совпасть с base58-шаблоном,
      // но hex-строка длиной 40 — может. Отсекаем по алфавиту.
      if (/^[0-9a-fA-F]{40}$/.test(m)) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      out.push({ address: m, family: 'solana', chainHint: chainHint ?? 'SOLANA', raw: trimmed.slice(0, 120) });
      if (out.length >= limit) return out;
    }
  }

  return out;
}

/**
 * Сети-кандидаты для проверки.
 *
 * Для Solana ответ однозначен. Для EVM без подсказки приходится
 * перебирать: один адрес живёт в нескольких сетях, и определить нужную
 * можно только запросом рыночных данных — где найдётся пул, та и верна.
 */
export function candidateChains(ref: TokenRef, supported: string[]): string[] {
  if (ref.family === 'solana') {
    return supported.includes('SOLANA') ? ['SOLANA'] : [];
  }

  if (ref.chainHint && supported.includes(ref.chainHint)) return [ref.chainHint];

  // Порядок перебора — по убыванию вероятности для мем-коинов.
  return ['BNB', 'BASE', 'ETHEREUM', 'ROBINHOOD'].filter((c) => supported.includes(c));
}
