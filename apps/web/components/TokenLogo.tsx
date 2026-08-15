'use client';

import { useState } from 'react';

/**
 * Логотип токена с запасным вариантом.
 *
 * Запасной вариант обязателен, а не желателен: у свежих мем-коинов
 * логотипа нет почти никогда, и радар находит их раньше, чем кто-либо
 * успевает загрузить картинку. Пустой квадрат на месте иконки читается
 * как поломка загрузки, поэтому вместо него рисуются буквы тикера.
 *
 * Цвет фона выводится из адреса, а не выбирается случайно: при каждой
 * перерисовке он должен оставаться тем же, иначе список «мигает» при
 * обновлении данных.
 */

interface Props {
  symbol: string;
  address?: string | null;
  logoUrl?: string | null;
  /** Размер стороны в пикселях. */
  size?: number;
  className?: string;
}

/** Палитра тёмных фонов, читаемых со светлым текстом. */
const COLORS = [
  '#3b3663', '#1f4d47', '#4d3320', '#3d2540', '#1e3a52',
  '#4a2b2b', '#2b4a2f', '#453a1f', '#2f3a4a', '#432b45',
];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return COLORS[h % COLORS.length]!;
}

export function TokenLogo({ symbol, address, logoUrl, size = 28, className = '' }: Props) {
  const [broken, setBroken] = useState(false);

  const label = (symbol || '?').replace(/^\$/, '').slice(0, 3).toUpperCase();
  const bg = colorFor(address || symbol || '?');

  const box = {
    width: size,
    height: size,
    minWidth: size,
    fontSize: Math.max(9, Math.round(size * 0.36)),
  };

  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt={symbol}
        loading="lazy"
        // Ссылка на картинку приходит от стороннего источника и может
        // отвалиться в любой момент. Без обработчика на её месте
        // остаётся значок сломанного изображения.
        onError={() => setBroken(true)}
        style={box}
        className={`bg-bg shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      style={{ ...box, background: bg }}
      aria-label={symbol}
      className={`text-white/80 flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight ${className}`}
    >
      {label}
    </span>
  );
}
