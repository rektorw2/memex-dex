'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useVisibleSections } from '@/lib/sections';

/**
 * Навигация широкого экрана.
 *
 * Логотип ведёт на публичную витрину тарифов, поэтому терминал теперь
 * назван отдельным пунктом. Без него после переноса тарифов на главную
 * у вошедшего пользователя исчез бы короткий путь к основному экрану.
 *
 * Разделы показываются целиком: лишний клик до нужного в торговом
 * интерфейсе стоит дороже сэкономленного места.
 *
 * Телефон обслуживает MobileNav — выдвижная панель во всю высоту.
 * Прежде мобильное меню жило здесь выпадающим списком, и это была
 * ошибка по сути: ширина определялась содержимым, поэтому
 * «Смарт-деньги» переносилось на две строки, подложки не было,
 * а страница под меню продолжала прокручиваться.
 */

export const SECTIONS = [
  { href: '/terminal', label: 'Терминал' },
  { href: '/calls', label: 'Коллы' },
  { href: '/radar', label: 'Радар' },
  // Название «Смарт-деньги», а не «Кошельки»: пункт /wallet ниже — это
  // собственные кошельки пользователя, и два «Кошелька» в меню путали бы.
  { href: '/wallets', label: 'Смарт-деньги' },
  { href: '/copy', label: 'Копитрейдинг' },
  { href: '/portfolio', label: 'Портфель' },
  { href: '/wallet', label: 'Кошельки' },
];

export function MainNav() {
  const pathname = usePathname();

  // Показываются только те разделы, куда этого человека пустят.
  // Пункт, ведущий на редирект, читается как поломка продукта.
  const sections = useVisibleSections(SECTIONS);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const linkCls = (href: string) =>
    `whitespace-nowrap rounded-md px-2 py-1.5 text-sm transition-colors sm:px-3 ${
      isActive(href)
        // Активный раздел — тем же фиолетовым, что выбор в остальном
        // интерфейсе. Серая подсветка не отличалась от наведения.
        ? 'bg-accent/15 text-accent'
        : 'text-muted hover:bg-raised hover:text-white'
    }`;

  return (
    <nav className="hidden min-w-0 gap-1 md:flex">
      {sections.map((n) => (
        <Link key={n.href} href={n.href} className={linkCls(n.href)}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
