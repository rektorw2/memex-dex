'use client';

/**
 * Звезда «в избранном».
 *
 * Один компонент на все экраны, потому что состояние одно. Три
 * отдельные реализации в списке, карточке и ленте разошлись бы
 * при первой же правке, и человек увидел бы закрашенную звезду
 * на одном экране и пустую на другом для того же кошелька.
 *
 * Компонент намеренно не помнит собственного состояния. Оно живёт
 * в общем контексте, и это делает переключение в ленте видимым
 * в списке кошельков без перезагрузки.
 *
 * Про перерисовку. Лента бывает длинной, и нажатие на звезду
 * не должно перерисовывать её целиком; поэтому компонент обёрнут
 * в memo и зависит только от своей избранности.
 */

import { memo, useCallback, useState } from 'react';
import { useFavorites } from '@/lib/favorites';

interface Props {
  chain: string;
  address: string;
  /** Размер значка. В плотных списках нужен меньший. */
  size?: 'sm' | 'md';
  className?: string;
}

function FavoriteStarInner({ chain, address, size = 'md', className = '' }: Props) {
  const { isFavorite, toggle } = useFavorites();
  const [busy, setBusy] = useState(false);

  const active = isFavorite(chain, address);
  const box = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';
  const glyph = size === 'sm' ? 'text-[13px]' : 'text-[15px]';

  const onClick = useCallback(
    async (e: React.MouseEvent) => {
      // Звезда часто стоит внутри кликабельной строки: без остановки
      // всплытия нажатие открывало бы карточку кошелька.
      e.stopPropagation();
      e.preventDefault();

      if (busy) return;

      setBusy(true);
      try {
        await toggle(chain, address);
      } finally {
        setBusy(false);
      }
    },
    [busy, toggle, chain, address],
  );

  return (
    <button
      type="button"
      onClick={onClick}
      // Состояние объявляется явно, а не только цветом: с выключенной
      // передачей цвета и в программе чтения с экрана закрашенная
      // и пустая звезда неразличимы.
      aria-pressed={active}
      aria-label={active ? 'Убрать из избранного' : 'Добавить в избранное'}
      title={active ? 'Убрать из избранного' : 'Добавить в избранное'}
      className={`tap grid ${box} shrink-0 place-items-center rounded-lg transition-colors
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-accent
        ${active ? 'text-accent' : 'text-muted/60 hover:text-white'}
        ${busy ? 'opacity-60' : ''} ${className}`}
    >
      <span className={glyph} aria-hidden>
        {active ? '★' : '☆'}
      </span>
    </button>
  );
}

/**
 * Перерисовывается только при смене своих входных данных.
 *
 * Контекст всё равно уведомит всех потребителей, но React пропустит
 * перерисовку тех звёзд, у которых ничего не изменилось.
 */
export const FavoriteStar = memo(FavoriteStarInner);
