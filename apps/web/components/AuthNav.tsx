'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export function AuthNav() {
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    // sessionStorage доступен только на клиенте — читаем после монтирования,
    // иначе Next выдаст рассинхрон при гидратации.
    setRole(sessionStorage.getItem('accessToken') ? localStorage.getItem('role') : null);
  }, []);

  if (!role) {
    return (
      <Link href="/login" className="btn-ghost text-sm">
        Войти
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-1 sm:gap-2">
      {/* На телефоне админка живёт в выпадающем меню: здесь она вместе
          с кнопкой выхода не помещалась и наезжала на навигацию. */}
      {role === 'ADMIN' && (
        <Link
          href="/admin"
          className="text-accent hidden whitespace-nowrap px-2 py-1.5 text-sm md:inline-block sm:px-3"
        >
          Админка
        </Link>
      )}
      {/* «Кабинет» дублирует раздел «Портфель» в навигации — на телефоне
          это лишняя кнопка, вытесняющая выход за край экрана. */}
      <Link href="/portfolio" className="btn-ghost text-sm hidden sm:inline-block whitespace-nowrap">
        Кабинет
      </Link>
      <button
        onClick={async () => {
          await api('/auth/logout', { method: 'POST' }).catch(() => {});
          sessionStorage.clear();
          localStorage.removeItem('role');
          localStorage.removeItem('refreshToken');
          router.push('/login');
        }}
        className="text-sm text-muted hover:text-white px-2 whitespace-nowrap"
      >
        Выйти
      </button>
    </div>
  );
}
