'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';

export interface AgentChartMarker {
  id: string;
  side: 'BUY' | 'SELL';
  time: number;
  strategyLabel: string;
  priceUsd: number | null;
  pnlUsd: number | null;
  shadow?: boolean;
  allocationMode?: string;
  allocatedUsd?: number | null;
  capitalPct?: number | null;
  riskProfile?: string | null;
  allocationReason?: string;
  freeAfterUsd?: number | null;
  reserveAfterUsd?: number | null;
  exposureAfterUsd?: number | null;
}

interface Props {
  candles: CandlestickData[];
  height?: number;
  /** Токен плюс таймфрейм. При его смене график подгоняет масштаб заново. */
  resetKey?: string;
  /** На секундном графике ось обязана показывать секунды, а не минуты. */
  secondsVisible?: boolean;
  /**
   * Видимый участок изменился.
   *
   * `from` — логический индекс самой левой видимой свечи; отрицательный
   * означает, что человек утащил график за край данных. По нему
   * решается, пора ли грузить историю, и ушёл ли он от живого края.
   */
  onVisibleRange?: (range: { from: number; to: number }, total: number) => void;
  /**
   * Счётчик команды «вернуться к текущей цене».
   *
   * Число, а не функция: прокинуть императивный вызов в дочерний
   * компонент иначе можно только через ref, а увеличенный счётчик
   * читается как обычное свойство и не требует лишнего слоя.
   */
  goLiveNonce?: number;
  /**
   * Держаться правого края при появлении новой свечи.
   *
   * Выключается, когда человек изучает прошлое: иначе каждая живая
   * котировка утаскивала бы его обратно к текущей цене — самый
   * раздражающий из возможных дефектов графика.
   */
  followLive?: boolean;
  /** Persisted paper-события. Используется официальный series markers API. */
  markers?: AgentChartMarker[];
  /** Переместить временную шкалу к выбранной сделке. Unix seconds. */
  focusTime?: number | null;
  focusNonce?: number;
  focusWindowSeconds?: number;
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

export function PriceChart({
  candles,
  height = 420,
  resetKey = '',
  secondsVisible = false,
  onVisibleRange,
  goLiveNonce = 0,
  followLive = true,
  markers = [],
  focusTime = null,
  focusNonce = 0,
  focusWindowSeconds = 3_600,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const previousRef = useRef<{ key: string; length: number; first: unknown } | null>(null);

  /*
   * Обработчик диапазона держится в ref.
   *
   * Подписка ставится один раз при создании графика, а замыкание
   * внутри неё жило бы с первым значением свойства навсегда: обработчик
   * видел бы пустую историю и никогда не запросил бы вторую страницу.
   * Ref обновляется каждый рендер и решает это без пересоздания
   * подписки — а пересоздавать её нельзя, она привязана к canvas.
   */
  const rangeHandler = useRef(onVisibleRange);
  rangeHandler.current = onVisibleRange;

  const totalRef = useRef(candles.length);
  totalRef.current = candles.length;

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
        secondsVisible,
        /*
         * Библиотека не двигает диапазон сама.
         *
         * По умолчанию новая свеча сдвигает видимую область вправо —
         * и человека, изучающего вчерашний день, каждую секунду
         * выбрасывало бы к текущей цене. Решение о следовании
         * за live принимается здесь явно, ниже.
         */
        shiftVisibleRangeOnNewBar: false,
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

    /*
     * Одна котировка в секунду не образует полноценную OHLC-свечу:
     * open/high/low/close равны, и библиотека рисует короткую черту.
     * Поэтому секундный режим — непрерывная линия последней цены,
     * а интервалы от пяти минут — настоящие свечи из истории.
     */
    const series = secondsVisible
      ? chart.addLineSeries({
          color: '#22C7B8',
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 3,
          priceFormat: { type: 'price', ...priceFormatFor([]) },
          priceLineVisible: true,
          priceLineColor: '#8F98A7',
          priceLineStyle: 2,
          lastValueVisible: true,
        })
      : chart.addCandlestickSeries({
          upColor: '#22C7B8',
          downColor: '#FF5C6C',
          borderVisible: false,
          wickUpColor: '#22C7B8',
          wickDownColor: '#FF5C6C',
          priceFormat: { type: 'price', ...priceFormatFor([]) },
          // Линия последней цены: единственная горизонтальная отметка,
          // которую видно без курсора. Две конкурирующие «текущие цены»
          // на графике — верный способ запутать.
          priceLineVisible: true,
          priceLineColor: '#8F98A7',
          priceLineStyle: 2,
          lastValueVisible: true,
        });

    chartRef.current = chart;
    seriesRef.current = series;

    /*
     * Подписка на видимый участок.
     *
     * Единственный способ узнать, что человек утащил график к левому
     * краю: события перетаскивания библиотека наружу не отдаёт,
     * а опрос диапазона по таймеру был бы и дороже, и грубее.
     */
    const onRange = (range: { from: number; to: number } | null) => {
      if (range == null) return;
      rangeHandler.current?.({ from: range.from, to: range.to }, totalRef.current);
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

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
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      seriesRef.current = null;
      chartRef.current = null;
      previousRef.current = null;
      chart.remove();
    };
  }, [height, secondsVisible]);

  /*
   * Цена обновляется каждую секунду, но сам canvas не пересоздаётся.
   *
   * Прежний effect зависел от `candles`: каждое обновление удаляло
   * график целиком, создавало новый и сбрасывало масштаб. В live-
   * режиме это выглядело бы как мигание раз в секунду. Теперь новая
   * последняя свеча идёт через `update`, а полная история — через
   * `setData` только при смене токена/таймфрейма или появлении пачки.
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || candles.length === 0) return;

    const previous = previousRef.current;
    const first = candles[0]?.time;
    const incremental =
      previous != null &&
      previous.key === resetKey &&
      previous.first === first &&
      candles.length >= previous.length &&
      candles.length <= previous.length + 1;

    /*
     * Сколько свечей добавилось слева.
     *
     * Признак вставки истории: ключ тот же, но левый край сдвинулся.
     * Прежняя первая свеча всё ещё в наборе — её индекс и есть число
     * добавленных баров.
     */
    const prepended =
      previous != null && previous.key === resetKey && previous.first !== first
        ? candles.findIndex((candle) => candle.time === previous.first)
        : -1;

    /*
     * Диапазон снимается ДО записи данных.
     *
     * После `setData` библиотека пересчитывает шкалу, и прежние
     * логические индексы уже недоступны. Именно здесь график
     * и прыгал бы к текущей цене.
     */
    const rangeBefore = prepended > 0 ? chart.timeScale().getVisibleLogicalRange() : null;

    if (secondsVisible) {
      const line = series as ISeriesApi<'Line'>;
      const points: LineData[] = candles.map((candle) => ({
        time: candle.time,
        value: candle.close,
      }));

      line.applyOptions({
        priceFormat: { type: 'price', ...priceFormatFor(candles) },
      });

      if (incremental) line.update(points.at(-1)!);
      else line.setData(points);
    } else {
      const candlesticks = series as ISeriesApi<'Candlestick'>;
      candlesticks.applyOptions({
        priceFormat: { type: 'price', ...priceFormatFor(candles) },
      });

      if (incremental) candlesticks.update(candles.at(-1)!);
      else candlesticks.setData(candles);
    }

    if (prepended > 0) {
      /*
       * Тот же участок, что и был.
       *
       * Логические индексы отсчитываются от начала набора: вставка
       * слева сдвигает их все ровно на число добавленных баров.
       * Прибавляем это число к обеим границам — и человек остаётся
       * там же, где стоял, только теперь слева от него есть куда идти.
       */
      if (rangeBefore != null) {
        chart.timeScale().setVisibleLogicalRange({
          from: rangeBefore.from + prepended,
          to: rangeBefore.to + prepended,
        });
      }
    } else if (!incremental) {
      // Первая загрузка или смена токена: показываем всё, что есть.
      chart.timeScale().fitContent();
    } else if (followLive) {
      /*
       * Новая свеча у правого края.
       *
       * Сдвиг делается вручную и только когда человек и так смотрит
       * на текущую цену: `shiftVisibleRangeOnNewBar` выключен именно
       * ради этого различия.
       */
      chart.timeScale().scrollToRealTime();
    }

    previousRef.current = { key: resetKey, length: candles.length, first };
  }, [candles, resetKey, secondsVisible, followLive]);

  /*
   * Возврат к текущей цене по кнопке.
   *
   * Отдельный эффект: команда приходит счётчиком и не должна
   * зависеть от данных — иначе нажатие терялось бы, если в тот же
   * тик пришла новая свеча.
   */
  useEffect(() => {
    if (goLiveNonce === 0) return;
    chartRef.current?.timeScale().scrollToRealTime();
  }, [goLiveNonce]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const chartMarkers: SeriesMarker<Time>[] = [...markers]
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      .map((marker) => ({
        time: marker.time as Time,
        position: marker.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: marker.side === 'BUY' ? '#22C7B8' : '#FF5C6C',
        shape: marker.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: [
          `PAPER ${marker.side}`,
          marker.shadow ? 'SHADOW' : null,
          marker.allocationMode,
          marker.allocatedUsd == null ? null : `$${marker.allocatedUsd.toFixed(2)}`,
          marker.capitalPct == null ? null : `${marker.capitalPct.toFixed(1)}%`,
          marker.riskProfile,
          marker.side === 'BUY' && marker.freeAfterUsd != null
            ? `free $${marker.freeAfterUsd.toFixed(2)}`
            : null,
          marker.side === 'BUY' && marker.reserveAfterUsd != null
            ? `reserve $${marker.reserveAfterUsd.toFixed(2)}`
            : null,
          marker.side === 'BUY' && marker.exposureAfterUsd != null
            ? `exposure $${marker.exposureAfterUsd.toFixed(2)}`
            : null,
          marker.side === 'BUY' ? marker.allocationReason : null,
          marker.strategyLabel,
          marker.side === 'SELL' && marker.pnlUsd != null
            ? `${marker.pnlUsd >= 0 ? '+' : ''}$${marker.pnlUsd.toFixed(2)}`
            : null,
        ].filter(Boolean).join(' · '),
        id: marker.id,
      }));
    // Старые test doubles графика могли не моделировать новый API.
    // В production lightweight-charts 4.2 предоставляет setMarkers.
    if (typeof series.setMarkers === 'function') series.setMarkers(chartMarkers);
  }, [markers, resetKey, secondsVisible]);

  useEffect(() => {
    if (focusTime == null || focusNonce === 0) return;
    const half = Math.max(30, focusWindowSeconds / 2);
    chartRef.current?.timeScale().setVisibleRange({
      from: Math.floor(focusTime - half) as Time,
      to: Math.ceil(focusTime + half) as Time,
    });
  }, [focusNonce, focusTime, focusWindowSeconds]);

  return <div ref={containerRef} className="w-full" />;
}
