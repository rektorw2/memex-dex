'use client';

import { memo } from 'react';

/**
 * Мини-график из точек наблюдения.
 *
 * Рисуется inline-SVG без библиотеки: на странице таких графиков
 * несколько десятков, и полноценный график для каждого дал бы десятки
 * канвасов и заметное подтормаживание прокрутки.
 */
function SparklineBase({
  points,
  height = 48,
  className = '',
}: {
  points: Array<{ t: number; p: number | null; m: number | null }>;
  height?: number;
  className?: string;
}) {
  const values = points.map((x) => x.m ?? x.p).filter((v): v is number => v != null && v > 0);

  if (values.length < 2) {
    return (
      <div className={`flex items-center justify-center text-[10px] text-muted ${className}`}
           style={{ height }}>
        данных пока мало
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;

  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      // Инвертируем: в SVG ось Y растёт вниз.
      const y = height - ((v - min) / span) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const up = values[values.length - 1]! >= values[0]!;
  const stroke = up ? '#22C7B8' : '#FF5C6C';

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={`sg-${up ? 'u' : 'd'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${w},${height} L0,${height} Z`} fill={`url(#sg-${up ? 'u' : 'd'})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Мемоизация по ссылке на массив точек.
 *
 * В ленте шестьдесят карточек, и обновление раз в полминуты
 * перерисовывало все шестьдесят графиков независимо от того,
 * изменились ли в них точки. У большинства находок за это время
 * не появляется ни одной новой точки: наблюдение идёт реже,
 * чем обновляется список.
 */
export const Sparkline = memo(SparklineBase);
