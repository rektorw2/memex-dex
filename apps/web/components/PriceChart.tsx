'use client';

import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type CandlestickData } from 'lightweight-charts';

interface Props {
  candles: CandlestickData[];
  height?: number;
}

/**
 * Точность цены под масштаб самих данных.
 *
 * Раньше здесь стояли жёсткие десять знаков — «чтобы хватило мем-коинам».
 * Ценой этого было «2.5000000000» на оси у обычного токена: восемь нулей,
 * которые ничего не сообщают и съедают половину ширины шкалы.
 *
 * Считаем по фактическому диапазону свечей: знаков ровно столько,
 * чтобы соседние уровни цены различались.
 */
function priceFormatFor(candles: CandlestickData[]): { precision: number; minMove: number } {
  const values = candles
    .flatMap((c) => [c.high, c.low])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);

  if (values.length === 0) return { precision: 4, minMove: 0.0001 };

  const min = Math.min(...values);

  // Знаков после запятой: столько, чтобы у наименьшей цены осталось
  // четыре значащие цифры. Верхняя граница в 12 — предел библиотеки.
  const magnitude = Math.floor(Math.log10(min));
  const precision = Math.min(12, Math.max(2, 4 - magnitude - 1));

  return { precision, minMove: 10 ** -precision };
}

export function PriceChart({ candles, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#8F98A7' },
      grid: {
        // Сетка тише подписей: она помогает соотнести точку со шкалой,
        // но не должна конкурировать с самими свечами.
        vertLines: { color: '#1B2029' },
        horzLines: { color: '#1B2029' },
      },
      rightPriceScale: {
        borderColor: '#252B35',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#252B35',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1,
        // Перекрестие фиолетовое — тем же цветом, что выбор в остальном
        // интерфейсе. Так значение под курсором не путается с текущей
        // ценой, которая отмечена своей линией.
        vertLine: { color: '#8B5CF6', width: 1, style: 2, labelBackgroundColor: '#8B5CF6' },
        horzLine: { color: '#8B5CF6', width: 1, style: 2, labelBackgroundColor: '#8B5CF6' },
      },
      localization: { locale: 'ru-RU' },
      handleScale: { axisPressedMouseMove: { price: false } },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#22C7B8',
      downColor: '#FF5C6C',
      borderVisible: false,
      wickUpColor: '#22C7B8',
      wickDownColor: '#FF5C6C',
      priceFormat: { type: 'price', ...priceFormatFor(candles) },
      // Линия последней цены: единственная горизонтальная отметка,
      // которую видно без курсора. Две конкурирующие «текущие цены»
      // на графике — верный способ запутать.
      priceLineVisible: true,
      priceLineColor: '#8F98A7',
      priceLineStyle: 2,
      lastValueVisible: true,
    });

    series.setData(candles);
    chart.timeScale().fitContent();
    chartRef.current = chart;

    // ResizeObserver вместо события окна: панель меняет ширину и без
    // изменения размера окна — например, когда на мобильном
    // переключается вкладка и график попадает в другой контейнер.
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, height]);

  return <div ref={containerRef} className="w-full" />;
}
