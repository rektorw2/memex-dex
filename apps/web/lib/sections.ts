'use client';

import { guard, type VisitorState } from '@memex/core';
import { useAccess } from './access';
import { useRole } from './role';

/**
 * Разделы, доступные этому посетителю.
 *
 * Меню, обещающее то, чего нет, — это не защита и не помощь: гость,
 * нажавший «Радар», попадает на редирект и делает вывод, что продукт
 * сломан. Поэтому пункт показывается тогда же, когда сторож пускает
 * на маршрут, и решает это одна и та же функция.
 *
 * Скрытый пункт по-прежнему ничего не запрещает. Запрещает сервер.
 */
export interface Section {
  href: string;
  label: string;
}

export function useVisibleSections(all: readonly Section[]): Section[] {
  const { access, loading, anonymous } = useAccess();
  const { isAdmin } = useRole();

  // Пока права неизвестны, меню пустое. Показать всё и убрать лишнее
  // через секунду значит мигнуть человеку разделами, которых у него
  // нет, — и это заметнее, чем короткая пауза.
  if (loading) return [];

  const state: VisitorState = {
    authenticated: !anonymous,
    isAdmin,
    capabilities: access?.capabilities ?? [],
  };

  return all.filter((s) => guard(s.href, state).kind === 'allow');
}
