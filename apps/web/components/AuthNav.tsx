'use client';

import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * Правая часть шапки: режим и аккаунт.
 *
 * Раньше здесь стояли в ряд «Админка», «Кабинет» и «Выйти» — три
 * равнозначных по виду элемента, из которых часто нужен один.
 * Выход по частоте использования последний, а по цене ошибки первый:
 * случайное нажатие обрывает сессию посреди работы. Поэтому он убран
 * в меню, а не стоит рядом со ссылками навигации.
 */
export function AuthNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // sessionStorage доступен только на клиенте — читаем после монтирования,
    // иначе Next выдаст рассинхрон при гидратации.
    setRole(sessionStorage.getItem('accessToken') ? localStorage.getItem('role') : null);
  }, [pathname]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    sessionStorage.clear();
    localStorage.removeItem('role');
    localStorage.removeItem('refreshToken');
    router.push('/login');
  }

  if (!role) {
    return (
      <div className="flex items-center gap-2">
        {/* Обёртка отвечает за responsive-видимость. `btn-ghost`
            сам задаёт display и раньше перебивал `hidden`, из-за чего
            «Регистрация» наезжала на центрированный логотип телефона. */}
        <span className="hidden sm:inline-flex">
          <Link href="/login?mode=register" className="btn-ghost tap text-sm">
            Регистрация
          </Link>
        </span>
        <Link href="/login" className="btn-primary tap text-sm">
          Войти
        </Link>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative flex items-center gap-2 sm:gap-3">
      {/* Режим — справочная метка. На узком экране место дороже. */}
      <span
        className="hidden whitespace-nowrap rounded border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent lg:inline"
        title="Ордера исполняются по реальным котировкам, но транзакции в сеть не отправляются"
      >
        paper
      </span>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Аккаунт"
        className={`tap flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
          open ? 'bg-raised text-white' : 'text-muted hover:bg-raised hover:text-white'
        }`}
      >
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent"
        >
          {role === 'ADMIN' ? 'A' : '·'}
        </span>
        <span aria-hidden className="text-[10px]">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 min-w-[180px] rounded-lg border border-border bg-panel py-1 shadow-xl"
        >
          <Link
            href="/portfolio"
            role="menuitem"
            className="block px-4 py-2.5 text-sm text-muted transition-colors hover:bg-raised hover:text-white"
          >
            Кабинет
          </Link>
          {role === 'ADMIN' && (
            <Link
              href="/admin"
              role="menuitem"
              className="block px-4 py-2.5 text-sm text-accent transition-colors hover:bg-raised"
            >
              Админка
            </Link>
          )}
          <button
            onClick={logout}
            role="menuitem"
            className="mt-1 block w-full border-t border-border px-4 py-2.5 text-left text-sm text-muted transition-colors hover:bg-raised hover:text-white"
          >
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}
