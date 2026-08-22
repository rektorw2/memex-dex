'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { guard, isPublicRoute, withNext, type VisitorState } from '@memex/core';
import { useAccess } from '@/lib/access';
import { useRole } from '@/lib/role';

/**
 * Один сторож на все маршруты.
 *
 * Раньше проверки жили по страницам: где-то `Requires`, где-то ничего.
 * Вопрос «что видит гость» не имел одного ответа — его собирали
 * обходом файлов, а забытая страница обнаруживалась тем, что в неё
 * зашли. Теперь таблица маршрутов одна и лежит в ядре, рядом
 * с матрицей прав.
 *
 * Сторож — это удобство, а не защита. Он избавляет человека от экрана
 * с отказами, но ничего не запрещает: запрос отправляется и без
 * интерфейса, и отказывает сервер. Поэтому здесь нет ни одной
 * проверки, которой нет на сервере.
 *
 * Пока права не загружены, закрытая страница не отрисовывается вовсе.
 * Иначе на каждом обновлении мелькал бы интерфейс, к которому нет
 * доступа, — и человек успевал бы увидеть чужие пункты меню.
 */
export function RouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { access, loading, anonymous } = useAccess();
  const { isAdmin } = useRole();

  const isPublic = isPublicRoute(pathname);

  const state: VisitorState = {
    authenticated: !anonymous,
    isAdmin,
    capabilities: access?.capabilities ?? [],
  };

  const verdict = loading ? null : guard(pathname, state);

  useEffect(() => {
    if (!verdict || verdict.kind !== 'redirect') return;

    /*
     * Адрес, куда человек шёл, передаётся дальше целиком.
     *
     * Берётся из `window.location`, а не из `useSearchParams`:
     * этот компонент стоит в общем макете, и хук заставил бы
     * обернуть в `Suspense` каждую страницу приложения — то есть
     * отдавать их статикой в виде заглушки. Здесь читать окно
     * безопасно: код выполняется в эффекте, то есть уже в браузере.
     *
     * Параметры и якорь сохраняются намеренно. `/radar/alerts`
     * без `?filter=new` — другой экран, и вернуть человека туда
     * значит вернуть не туда.
     */
    const full =
      typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
        : verdict.next;

    router.replace(withNext(verdict.to, full));
  }, [verdict, router]);

  // Публичное показываем сразу, не дожидаясь ответа о правах:
  // первый экран и терминал не зависят от того, кто смотрит,
  // и задержка здесь была бы задержкой ни за чем.
  if (isPublic) return <>{children}</>;

  if (loading) {
    return (
      <p className="py-16 text-center text-sm text-muted" role="status" aria-live="polite">
        Проверяем доступ…
      </p>
    );
  }

  if (verdict?.kind !== 'allow') {
    // Переход уже назначен эффектом. Показывать содержимое в этот
    // момент нельзя: оно мелькнёт перед уходом со страницы.
    return (
      <p className="py-16 text-center text-sm text-muted" role="status" aria-live="polite">
        Переходим…
      </p>
    );
  }

  return <>{children}</>;
}
