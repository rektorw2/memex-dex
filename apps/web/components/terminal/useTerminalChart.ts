'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { appendLivePrice, type LiveChartCandle } from '@memex/core';
import { fetcher } from '@/lib/api';
import type { Token } from './types';

interface LivePrice {
  priceUsd: string | null;
  priceChange24h: string | null;
  observedAt: string | null;
  serverTime: string;
  stale: boolean;
}

export interface TerminalChartResponse {
  state?: string;
  candles?: LiveChartCandle[];
  livePriceUsd?: string | null;
  liveAt?: string | null;
  live?: boolean;
}

/**
 * Единая рыночная модель терминала.
 *
 * Ею пользуются публичный терминал и продуктовые графики: история, секундная
 * серия, live-цена и пагинация не должны расходиться в двух экранах.
 */
export function useTerminalChart(token: Token | null, interval: string) {
  const tokenId = token?.id ?? null;
  const { data: chart, mutate: reload } = useSWR<TerminalChartResponse>(
    tokenId ? `/tokens/${tokenId}/candles?interval=${interval}` : null,
    fetcher,
    { refreshInterval: 15_000, keepPreviousData: false },
  );
  const { data: livePrice } = useSWR<LivePrice>(
    tokenId ? `/tokens/${tokenId}/live-price` : null,
    fetcher,
    {
      refreshInterval: 1_000,
      dedupingInterval: 700,
      keepPreviousData: false,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
    },
  );
  const [secondSeries, setSecondSeries] = useState<{
    tokenId: string | null;
    candles: LiveChartCandle[];
  }>({ tokenId: null, candles: [] });

  const observedPrice = livePrice?.priceUsd ?? chart?.livePriceUsd ?? token?.priceUsd ?? null;
  const observedAt = livePrice?.observedAt ?? chart?.liveAt ?? token?.priceUpdatedAt ?? null;
  const sampledAt = livePrice?.serverTime ?? observedAt;

  useEffect(() => {
    if (!tokenId || observedPrice == null || sampledAt == null || livePrice?.stale === true) return;
    setSecondSeries((previous) => {
      const base = previous.tokenId === tokenId ? previous.candles : [];
      return {
        tokenId,
        candles: appendLivePrice(base, observedPrice, sampledAt, '1s', 300),
      };
    });
  }, [livePrice?.stale, observedPrice, sampledAt, tokenId]);

  const displayedCandles = useMemo(() => {
    const historical = Array.isArray(chart?.candles) ? chart.candles : [];
    if (interval === '1s') {
      return secondSeries.tokenId === tokenId && secondSeries.candles.length > 0
        ? secondSeries.candles
        : historical;
    }
    return appendLivePrice(historical, observedPrice, observedAt, interval, 300);
  }, [chart?.candles, interval, observedAt, observedPrice, secondSeries, tokenId]);

  const displayedChart: TerminalChartResponse | undefined = token
    ? {
        ...chart,
        state: displayedCandles.length > 0 ? 'ready' : chart?.state,
        candles: displayedCandles,
        liveAt: observedAt,
        live: livePrice != null && !livePrice.stale,
      }
    : undefined;

  const displayedToken: Token | null = token
    ? {
        ...token,
        priceUsd: livePrice?.priceUsd ?? token.priceUsd,
        priceChange24h: livePrice?.priceChange24h ?? token.priceChange24h,
        priceUpdatedAt: livePrice?.observedAt ?? token.priceUpdatedAt,
      }
    : null;

  const loadOlder = useCallback(
    async (before: number) => {
      if (!tokenId) return { candles: [], oldest: null };
      const response = await fetcher<{ candles?: LiveChartCandle[]; oldest?: number | null }>(
        `/tokens/${tokenId}/candles?interval=${interval}&before=${before}`,
      );
      return { candles: response.candles ?? [], oldest: response.oldest ?? null };
    },
    [interval, tokenId],
  );

  return { chart: displayedChart, token: displayedToken, loadOlder, reload };
}
