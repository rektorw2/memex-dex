'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SECTIONS } from './MainNav';

/**
 * Мобильная навигация: панель во всю высоту слева.
 *
 * Заменяет выпадающий список под кнопкой. У того было три беды,
 * и все три следовали из одной причины — он был выпадающим меню,
 * а не навигацией.
 *
 * Ширина определялась содержимым, поэтому «Смарт-деньги» переносилось
 * на две строки. Подложки не было, и нажатие мимо приходилось
 * на страницу под меню. Прокрутка страницы под открытым меню
 * продолжалась, и список уезжал вместе с ней.
 *
 * Панель во всю высоту решает всё это по построению: у неё
 * фиксированная ширина, собственная прокрутка и подложка, которая
 * перехватывает нажатия.
 *
 * Отдельно про доступность. Открытая панель — это модальное
 * состояние: пока она открыта, остальной страницы для клавиатуры
 * не существует. Поэтому здесь есть удержание фокуса и возврат его
 * на кнопку при закрытии — без этого человек, закрывший панель
 * с клавиатуры, оказывается в начале документа.
 */

/** Иконки разделов. Простые контуры без заливки — как везде в проекте. */
const ICONS: Record<string, React.ReactElement> = {
  '/calls': (
    <path d="M3 12h3l2-5 3 10 2.5-7 1.5 4h4" stroke="currentColor" strokeWidth="1.5" fill="none" />
  ),
  '/radar': (
    <>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M10 10l5-4" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  '/wallets': (
    <>
      <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="13.5" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M9 8.5l3 2" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  '/copy': (
    <>
      <rect x="6" y="6" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M12 4H5a1.5 1.5 0 0 0-1.5 1.5V13" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </>
  ),
  '/portfolio': (
    <>
      <rect x="3" y="6" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </>
  ),
  '/wallet': (
    <>
      <rect x="3" y="5" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="13.5" cy="10" r="1.2" fill="currentColor" />
    </>
  ),
};

const TERMINAL_ICON = (
  <>
    <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M6 9l2 2-2 2M10.5 13h3.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
  </>
);

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const pathname = usePathname();

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    setIsAdmin(localStorage.getItem('role') === 'ADMIN');
  }, [pathname]);

  // Смена маршрута закрывает панель. Next не перемонтирует компонент
  // при переходе, и без этого панель остаётся висеть поверх новой
  // страницы.
  useEffect(() => setOpen(false), [pathname]);

  const close = useCallback(() => {
    setOpen(false);
    // Фокус возвращается на кнопку, а не теряется в начале документа.
    buttonRef.current?.focus();
  }, []);

  // Escape, блокировка прокрутки и удержание фокуса — три вещи,
  // без которых открытая панель остаётся не модальной, а просто
  // нарисованной поверх.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }

      if (e.key !== 'Tab' || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      // Цикл по кругу внутри панели: за её пределы Tab не выпускает.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Фокус переносится внутрь панели, иначе первый Tab уводит
    // на страницу под ней.
    const t = setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
    };
  }, [open, close]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* ── Кнопка ────────────────────────────────────────────── */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Открыть меню"
        aria-expanded={open}
        aria-controls="mobile-nav"
        className="tap grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-accent/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:bg-accent/15 md:hidden"
      >
        {/* Три ровные линии без рамки вокруг. Постоянная фиолетовая
            обводка делала кнопку похожей на включённое состояние. */}
        <span aria-hidden className="flex flex-col gap-[5px]">
          <span className="block h-[2px] w-[22px] rounded bg-current" />
          <span className="block h-[2px] w-[22px] rounded bg-current" />
          <span className="block h-[2px] w-[22px] rounded bg-current" />
        </span>
      </button>

      {/* ── Подложка ──────────────────────────────────────────── */}
      <div
        onClick={close}
        aria-hidden
        className={`fixed inset-0 z-[60] bg-black/65 transition-opacity duration-250 md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/* ── Панель ────────────────────────────────────────────── */}
      <div
        id="mobile-nav"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Разделы"
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          // Смахивание влево закрывает панель. Порог в шестьдесят
          // пикселей: меньше — это дрожание пальца при прокрутке
          // списка, и панель закрывалась бы сама собой.
          const start = touchStartX.current;
          const end = e.changedTouches[0]?.clientX;
          if (start != null && end != null && start - end > 60) close();
          touchStartX.current = null;
        }}
        className={`safe-bottom fixed inset-y-0 left-0 z-[70] flex w-[320px] max-w-[85vw] flex-col border-r border-border bg-[#0D1117] transition-transform duration-250 ease-out motion-reduce:transition-none md:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="flex h-header shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-lg font-bold tracking-tight">
            me<span className="text-accent">mex</span>
          </span>
          <button
            onClick={close}
            aria-label="Закрыть меню"
            className="tap grid h-11 w-11 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </div>

        {/* Собственная прокрутка: список разделов длиннее экрана
            на невысоких телефонах, а страница под панелью заблокирована. */}
        <nav className="scroll-y min-h-0 flex-1 py-2">
          <Item href="/" label="Терминал" icon={TERMINAL_ICON} active={pathname === '/'} />
          {SECTIONS.map((s) => (
            <Item
              key={s.href}
              href={s.href}
              label={s.label}
              icon={ICONS[s.href]}
              active={isActive(s.href)}
            />
          ))}
        </nav>

        {/* ── Второстепенное ──────────────────────────────────── */}
        <div className="shrink-0 border-t border-border py-2">
          <SecondaryItem href="/radar/alerts" label="Уведомления" />
          {isAdmin && <SecondaryItem href="/admin" label="Админка" accent />}
        </div>
      </div>
    </>
  );
}

function Item({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon?: React.ReactElement;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-[50px] items-center gap-3 px-4 text-[15px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        active ? 'bg-accent/10 text-white' : 'text-muted hover:bg-raised hover:text-white'
      }`}
    >
      {/* Полоса слева вместо рамки вокруг пункта: рамка спорит
          с разделителями списка и утяжеляет его. */}
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}

      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden
        className={`shrink-0 ${active ? 'text-accent' : ''}`}
      >
        {icon}
      </svg>

      {/* Перенос запрещён: «Смарт-деньги» уезжало на две строки
          и ломало ритм списка. Ширины в 320 пикселей хватает всем
          названиям с запасом. */}
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}

function SecondaryItem({
  href,
  label,
  accent,
}: {
  href: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex h-11 items-center px-4 text-[13px] transition-colors hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        accent ? 'text-accent' : 'text-muted hover:text-white'
      }`}
    >
      {label}
    </Link>
  );
}
