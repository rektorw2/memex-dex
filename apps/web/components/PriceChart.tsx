'use client';

import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type CandlestickData } from 'lightweight-charts';

interface Props {
  candles: CandlestickData[];
  height?: number;
}

export function PriceChart({ candles, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#7d8592' },
      grid: {
        vertLines: { color: '#1e2128' },
        horzLines: { color: '#1e2128' },
      },
      rightPriceScale: { borderColor: '#1e2128' },
      timeScale: { borderColor: '#1e2128', timeVisible: true },
      crosshair: { mode: 1 },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      // Мем-коины требуют больше знаков после запятой, иначе график «плоский».
      priceFormat: { type: 'price', precision: 10, minMove: 0.0000000001 },
    });

    series.setData(candles);
    chart.timeScale().fitContent();
    chartRef.current = chart;

    const resize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, [candles, height]);

  return <div ref={containerRef} className="w-full" />;
}
