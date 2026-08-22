'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { gainerDisplay, formatMultiple } from '@memex/core';
import { fetcher, fmtUsd, fmtPrice } from '@/lib/api';
import { TokenLogo } from '@/components/TokenLogo';
import { CHAIN_LABEL } from '@/components/terminal/types';

/**
 * Лидер роста за сутки.
 *
 * Метрика одна на всё приложение и берётся у сервера, а не считается
 * здесь: `sort=gainers` — это рост цены за 24 часа среди тех, кто
 * прошёл пороги ликвидности и оборота. Пороги существуют не для
 * красоты: без них лидером всегда оказывался бы токен с ликвидностью
 * в полсотни долларов и ростом в девять тысяч процентов, то есть
 * ровно то, на чём теряют деньги.
 *
 * Второго определения «лучшего токена» в проекте нет намеренно.
 * Карточка на первом экране и первая строка в терминале обязаны
 * называть лидером один и тот же токен — иначе первое, что человек
 * замечает в продукте, это что продукт сам себе противоречит.
 *
 * Рост показывается иксами и процентами разом: «4× (+300%)». Иксами
 * о мем-коинах и говорят, а процент рядом оставляет число
 * проверяемым. Одного икса мало — «4×» без процента невозможно
 * сверить с биржей; одного процента мало — «+300%» требует пересчёта
 * в уме ровно в тот момент, когда человек решает, интересно ему это
 * или нет.
 *
 * Ничего не придумывается. Нет данных — так и написано.
 */

interface GainerToken {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  address: string;
  logoUrl: string | null;
  priceUsd: string | null;
  priceChange24h: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
}

/** Период, за который считается рост. Показывается человеку дословно. */
export const GAINER_WINDOW_LABEL = '24 ч';

export function TopGainerCard() {
  const { data, isLoading, error } = useSWR<GainerToken[]>(
    '/tokens?sort=gainers&limit=1&safeOnly=true',
    fetcher,
    { refreshInterval: 60_000, shouldRetryOnError: false },
  );

  const token = data?.[0] ?? null;

  /*
   * Икс и процент приходят вместе или не приходят вовсе.
   *
   * Решение живёт в ядре и покрыто тестами: раньше оно было здесь
   * и однажды разъехалось — форматтер возвращал прочерк на
   * непосчитанном значении, а компонент подставлял вместо прочерка
   * процент, то есть объявлял рост там, где считать его было
   * не из чего.
   */
  const display = gainerDisplay(token?.priceChange24h, formatMultiple);

  if (isLoading) {
    return (
      <div className="panel w-full max-w-sm p-5">
        <div className="mb-3 h-3 w-24 animate-pulse rounded bg-raised" />
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 animate-pulse rounded-full bg-raised" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-20 animate-pulse rounded bg-raised" />
            <div className="h-3 w-28 animate-pulse rounded bg-raised" />
          </div>
        </div>
      </div>
    );
  }

  // Пусто и ошибка выглядят одинаково намеренно: и то и другое означает
  // «сейчас сказать нечего». Показать вместо этого вчерашний токен
  // или прочерк с процентами значило бы выдумать.
  if (error || !token || !display) {
    return (
      <div className="panel w-full max-w-sm p-5">
        <p className="text-xs uppercase tracking-wide text-muted">
          Лидер роста · {GAINER_WINDOW_LABEL}
        </p>
        <p className="mt-3 text-sm text-muted">
          Пока показать нечего: за сутки нет токенов, прошедших пороги
          ликвидности и оборота.
        </p>
        <Link
          href="/terminal"
          className="mt-4 inline-block text-sm text-accent hover:underline"
        >
          Открыть терминал →
        </Link>
      </div>
    );
  }

  return (
    <Link
      href={`/terminal?token=${encodeURIComponent(token.id)}`}
      className="panel block w-full max-w-sm p-5 transition-colors hover:border-accent/50"
    >
      <p className="text-xs uppercase tracking-wide text-muted">
        Лидер роста · {GAINER_WINDOW_LABEL}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <TokenLogo logoUrl={token.logoUrl} symbol={token.symbol} address={token.address} size={40} />

        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{token.symbol}</p>
          <p className="truncate text-xs text-muted">
            {token.name} · {CHAIN_LABEL[token.chain] ?? token.chain}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {/* Икс крупно, процент под ним: первое отвечает на вопрос,
              второе позволяет проверить. Сюда мы доходим только когда
              посчитано и то и другое. */}
          <p className="num text-lg font-semibold text-up">{display.multiple}</p>
          <p className="num text-xs text-muted">
            {display.percent} · {fmtPrice(token.priceUsd)}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-4 border-t border-border pt-3 text-xs text-muted">
        <span>Ликвидность {fmtUsd(token.liquidityUsd)}</span>
        <span>Оборот {fmtUsd(token.volume24hUsd)}</span>
      </div>
    </Link>
  );
}
