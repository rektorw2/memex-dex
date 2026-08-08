import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import type { CollectedFacts } from './token-intel.js';

/**
 * Трактовка собранных фактов моделью и поиск репутационной информации.
 *
 * Провайдер — Gemini: на бесплатном тарифе доступны модели Flash и
 * Flash-Lite с лимитом порядка 250-1000 запросов в сутки, чего с запасом
 * хватает при ручном запуске разбора администратором. Поиск в интернете
 * подключается инструментом google_search на стороне модели.
 *
 * Модуль полностью опционален: без ключа разбор не падает, а возвращает
 * null, и интерфейс показывает одни факты. Отсутствие AI не должно
 * лишать пользователя проверяемых данных о безопасности контракта.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AiVerdict {
  summary: string;
  /** Репутационный риск 0-100. Считается отдельно от технического. */
  riskScore: number;
  riskFactors: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  sources: Array<{ title: string; url: string }>;
  model: string;
}

export function isAiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

function buildPrompt(params: {
  symbol: string;
  name: string;
  chain: string;
  address: string;
  facts: CollectedFacts;
  marketSummary: string;
}): string {
  const { symbol, name, chain, address, facts, marketSummary } = params;
  const s = facts.security;
  const soc = facts.socials;

  return `Ты — аналитик крипторынка. Разбери токен и оцени репутационный риск.

ТОКЕН
Тикер: ${symbol}
Название: ${name}
Сеть: ${chain}
Адрес контракта: ${address}

РЫНОК
${marketSummary}

ПРОВЕРЕННЫЕ ФАКТЫ О КОНТРАКТЕ
${JSON.stringify(
  {
    ханипот: s.isHoneypot,
    можно_допечатать: s.mintable,
    можно_заморозить: s.freezable,
    владелец_может_менять_контракт: s.ownerCanModify,
    налог_покупки_пц: s.buyTaxPct,
    налог_продажи_пц: s.sellTaxPct,
    доля_создателя_пц: s.creatorPct,
    доля_топ10_пц: s.top10Pct,
    держателей: s.holderCount,
    ликвидность_залочена: s.lpLocked,
  },
  null,
  1,
)}

ИЗВЕСТНЫЕ КАНАЛЫ ПРОЕКТА
Сайт: ${soc.websites.join(', ') || 'не найден'}
X (Twitter): ${soc.twitter ? '@' + soc.twitter : 'не найден'}
Telegram: ${soc.telegram || 'не найден'}
Описание: ${soc.description || 'отсутствует'}

ЗАДАЧА
Найди в интернете информацию об этом токене. Проверь:
1. Активность и подлинность аккаунта в X: возраст, число подписчиков, признаки накрутки, менялось ли имя аккаунта.
2. Telegram-сообщество: размер, живость обсуждения, признаки ботов.
3. Упоминания в новостях и у крупных аналитиков.
4. Есть ли сообщения о скаме, rug pull, взломе или судебных претензиях.
5. Известна ли команда публично или проект анонимный.
6. Не выдаёт ли себя проект за другой, более известный.

ПРАВИЛА
— Опирайся на найденные источники, не выдумывай факты.
— Если информации нет, так и напиши: отсутствие данных о мем-коине — обычное дело, а не признак надёжности.
— Репутационный риск оценивай отдельно от технических метрик контракта: они уже посчитаны.
— Пиши по-русски, сухо и по делу, без рекламных формулировок.
— Не давай инвестиционных рекомендаций: ни «покупать», ни «продавать».

ФОРМАТ ОТВЕТА — строго JSON без markdown-обёртки:
{
  "summary": "3-5 предложений: что это за проект и что удалось найти",
  "riskScore": <0-100, где 0 — репутация чистая, 100 — явные признаки мошенничества>,
  "riskFactors": ["конкретные найденные проблемы, до 6 пунктов"],
  "sentiment": "positive|neutral|negative|unknown"
}`;
}

export async function researchToken(params: {
  symbol: string;
  name: string;
  chain: string;
  address: string;
  facts: CollectedFacts;
  marketSummary: string;
}): Promise<AiVerdict | null> {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;

  const model = env.GEMINI_MODEL;

  try {
    const res = await fetch(`${API}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(params) }] }],
        // Поиск выполняет сама модель: отдельный поисковый API не нужен,
        // а ссылки на источники возвращаются в метаданных ответа.
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2, // разбор рисков — не место для фантазии
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'AI-разбор не удался');
      return null;
    }

    const data: any = await res.json();
    const candidate = data?.candidates?.[0];
    const text: string = candidate?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (!text.trim()) return null;

    // Модель периодически оборачивает JSON в ```json несмотря на запрет.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const parsed = JSON.parse(cleaned.slice(start, end + 1));

    // Ссылки, на которые опиралась модель, — из метаданных поиска.
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .map((c: any) => ({
        title: c?.web?.title ?? '',
        url: c?.web?.uri ?? '',
      }))
      .filter((s: any) => s.url)
      .slice(0, 10);

    const score = Number(parsed.riskScore);
    const sentiment = ['positive', 'neutral', 'negative', 'unknown'].includes(parsed.sentiment)
      ? parsed.sentiment
      : 'unknown';

    return {
      summary: String(parsed.summary ?? '').slice(0, 3000),
      riskScore: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : 50,
      riskFactors: Array.isArray(parsed.riskFactors)
        ? parsed.riskFactors.map((x: unknown) => String(x).slice(0, 300)).slice(0, 6)
        : [],
      sentiment,
      sources,
      model,
    };
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'AI-разбор завершился ошибкой');
    return null;
  }
}
