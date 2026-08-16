/**
 * RugCheck: независимая проверка токенов Solana.
 *
 * Нужен потому, что на Solana нечем заменить симуляцию продажи —
 * аналога Honeypot.is там нет. RugCheck заполняет эту нишу с другой
 * стороны: он смотрит на распределение владения, состояние пула
 * и полномочия по контракту, и выдаёт список найденных проблем
 * с указанием серьёзности.
 *
 * К их итоговому баллу мы не привязываемся. Шкала чужая, её пороги
 * заданы под их представление о риске, и подмешивать чужое число
 * в своё значит потерять контроль над тем, что означает результат.
 * Берём отдельные найденные проблемы и оцениваем их своей мерой.
 */

import { logger } from '../lib/logger.js';
import { cached, withRetry, RateLimit } from '../lib/cache.js';

const API = 'https://api.rugcheck.xyz/v1';

const limiter = new RateLimit(5, 1_000);

export interface RugcheckRisk {
  name: string;
  description: string | null;
  /** danger | warn — уровень по мнению RugCheck. */
  level: string | null;
  score: number | null;
}

/**
 * Находки, означающие невозможность выйти из позиции.
 *
 * Только они блокируют токен. Всё остальное — активная эмиссия,
 * высокая концентрация, незалоченный пул — RugCheck тоже помечает
 * уровнем danger, и на мем-коинах это встречается у подавляющего
 * большинства. Принимать их метку за приговор значит заблокировать
 * почти всю Solana и подменить своё правило чужим.
 *
 * Сравнение идёт по ключевым словам названия, а не по точному
 * совпадению: RugCheck меняет формулировки, и жёсткий список названий
 * молча перестал бы срабатывать — самый неприятный вид поломки,
 * потому что выглядит как отсутствие проблем.
 */
const ABSOLUTE_FINDINGS = ['honeypot', 'cannot sell', 'transfer disabled', 'blacklist'];

export function isAbsoluteFinding(name: string): boolean {
  const n = name.toLowerCase();
  return ABSOLUTE_FINDINGS.some((k) => n.includes(k));
}

export interface RugcheckResult {
  /** Найденные проблемы. Пустой список означает «проверили, чисто». */
  risks: RugcheckRisk[];
  /**
   * Найдено то, что делает выход невозможным. Не то же самое, что
   * «RugCheck поставил danger»: их шкала строже нашей задачи.
   */
  hasCritical: boolean;
  /** Помечено уровнем danger по их шкале. Учитывается как повод, не приговор. */
  dangerCount: number;
  /** Доля предложения у крупнейших держателей, если сервис её посчитал. */
  topHoldersPct: number | null;
  /** Полномочия эмиссии отозваны. */
  mintAuthorityRevoked: boolean | null;
  /** Полномочия заморозки отозваны. */
  freezeAuthorityRevoked: boolean | null;
  /** Доля залоченной ликвидности. */
  lpLockedPct: number | null;
}

export async function checkRugcheck(mint: string): Promise<RugcheckResult | null> {
  const url = `${API}/tokens/${encodeURIComponent(mint)}/report/summary`;

  const hit = await cached(
    `rugcheck:${mint}`,
    async () => {
      await limiter.take();

      return withRetry(
        async () => {
          const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            const err: any = new Error(`RugCheck ${res.status}`);
            // 404 означает «токен не найден» — повторять незачем.
            err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
            throw err;
          }
          return parseRugcheck(await res.json());
        },
        { label: 'rugcheck', attempts: 2 },
      );
    },
    { ttlMs: 20 * 60_000, staleMs: 2 * 3_600_000 },
  ).catch((e) => {
    logger.debug({ mint, err: e?.message }, 'RugCheck недоступен');
    return null;
  });

  return hit?.value ?? null;
}

export function parseRugcheck(json: any): RugcheckResult {
  const rawRisks = Array.isArray(json?.risks) ? json.risks : [];

  const risks: RugcheckRisk[] = rawRisks.map((r: any) => ({
    name: String(r?.name ?? 'unknown'),
    description: typeof r?.description === 'string' ? r.description : null,
    level: typeof r?.level === 'string' ? r.level : null,
    score: Number.isFinite(Number(r?.score)) ? Number(r.score) : null,
  }));

  return {
    risks,
    // Блокирует только невозможность выйти. Прежде здесь стояло
    // `r.level === 'danger'`, и это заблокировало 137 токенов
    // из 173: на мем-коинах RugCheck помечает уровнем danger
    // и активную эмиссию, и концентрацию у топ-10 — то есть норму.
    hasCritical: risks.some((r) => isAbsoluteFinding(r.name)),
    dangerCount: risks.filter((r) => r.level === 'danger').length,
    topHoldersPct: num(json?.topHolders ?? json?.topHoldersPct),
    mintAuthorityRevoked: bool(json?.mintAuthority === null || json?.mintAuthorityRevoked),
    freezeAuthorityRevoked: bool(json?.freezeAuthority === null || json?.freezeAuthorityRevoked),
    lpLockedPct: num(json?.lpLockedPct ?? json?.markets?.[0]?.lp?.lpLockedPct),
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
