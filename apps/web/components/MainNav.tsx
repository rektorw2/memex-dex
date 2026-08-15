'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Навигация: полный ряд на широком экране, кнопка с меню на телефоне.
 *
 * Раньше все семь разделов прокручивались вбок внутри шапки, и на
 * телефоне это работало плохо: часть названий оставалась за краем
 * экрана, и об их существовании нельзя было догадаться, не начав
 * тянуть строку пальцем.
 *
 * На широком экране прятать разделы незачем — там они помещаются
 * целиком, а лишний клик до нужного раздела в торговом интерфейсе
 * стоит дороже сэкономленного места.
 *
 * «Терминал» на телефоне остаётся снаружи: это раздел, куда
 * возвращаются чаще всего, и прятать его за кнопку значит добавлять
 * клик к самому частому действию.
 */

const PRIMARY = { href: '/', label: 'Терминал' };

const SECONDARY = [
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
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const pathname = usePathname();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // localStorage доступен только на клиенте; читаем после монтирования,
    // иначе Next выдаст рассинхрон при гидратации.
    setIsAdmin(localStorage.getItem('role') === 'ADMIN');
  }, [pathname]);

  // Переход на другую страницу закрывает меню. Без этого оно остаётся
  // открытым поверх новой страницы: Next не перемонтирует компонент
  // при смене маршрута.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Меню закрывается по трём событиям: выбор пункта, Escape и клик мимо.
  // Любое из них по отдельности пропускает случай, в котором меню
  // остаётся висеть поверх содержимого.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    // Фаза всплытия, а не перехвата: иначе обработчик сработает раньше
    // клика по самой кнопке и меню закроется сразу после открытия.
    document.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const linkCls = (href: string) =>
    `whitespace-nowrap rounded-md px-2 py-1.5 text-sm transition-colors sm:px-3 ${
      isActive(href) ? 'bg-border text-white' : 'text-muted hover:bg-border hover:text-white'
    }`;

  return (
    <div ref={boxRef} className="relative flex min-w-0 items-center gap-1">
      <Link href={PRIMARY.href} className={linkCls(PRIMARY.href)}>
        {PRIMARY.label}
      </Link>

      {/* Широкий экран: разделы целиком. */}
      <nav className="hidden gap-1 md:flex">
        {SECONDARY.map((n) => (
          <Link key={n.href} href={n.href} className={linkCls(n.href)}>
            {n.label}
          </Link>
        ))}
      </nav>

      {/* Телефон: те же разделы под кнопкой. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Разделы"
        className={`rounded-md px-2 py-1.5 transition-colors md:hidden ${
          open || SECONDARY.some((m) => isActive(m.href))
            ? 'bg-border text-white'
            : 'text-muted hover:bg-border hover:text-white'
        }`}
      >
        <span aria-hidden className="flex flex-col gap-[3px]">
          <span className="block h-[2px] w-4 rounded bg-current" />
          <span className="block h-[2px] w-4 rounded bg-current" />
          <span className="block h-[2px] w-4 rounded bg-current" />
        </span>
      </button>

      {open && (
        <nav
          role="menu"
          className="border-border bg-panel absolute left-0 top-full z-50 mt-2 min-w-[190px] rounded-lg border py-1 shadow-xl md:hidden"
        >
          {SECONDARY.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              role="menuitem"
              className={`block px-4 py-2.5 text-sm transition-colors ${
                isActive(n.href)
                  ? 'bg-border text-white'
                  : 'text-muted hover:bg-border hover:text-white'
              }`}
            >
              {n.label}
            </Link>
          ))}

          {/* Админка тоже уезжает сюда: на телефоне она стояла в правой
              группе и вместе с кнопкой выхода выталкивала содержимое
              за край экрана. */}
          {isAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              className="text-accent border-border mt-1 block border-t px-4 py-2.5 text-sm"
            >
              Админка
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
