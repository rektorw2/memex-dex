'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { guard, isPublicRoute, withNext, type VisitorState } from '@memex/core';
import { currentAppPath } from '@/lib/app-path';
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
  const { access, loading, coldStart, error, reload, anonymous } = useAccess();
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
    /*
     * Префикс развёртывания снимается здесь же.
     *
     * `window.location.pathname` на GitHub Pages содержит
     * `/memex-dex`, а роутер добавляет его сам при переходе. Раньше
     * сюда попадал путь вместе с префиксом, и получалось
     * `/memex-dex/memex-dex/agent` — человека возвращало на
     * несуществующую страницу после успешного входа.
     */
    const full = currentAppPath() ?? verdict.next;

    router.replace(withNext(verdict.to, full));
  }, [verdict, router]);

  // Публичное показываем сразу, не дожидаясь ответа о правах:
  // первый экран и терминал не зависят от того, кто смотрит,
  // и задержка здесь была бы задержкой ни за чем.
  if (isPublic) return <>{children}</>;

  /*
   * Прячем страницу только на самой первой загрузке.
   *
   * `loading` теперь означает «о человеке ещё ничего не известно»,
   * а не «идёт какой-то запрос». Фоновая перепроверка проходит
   * поверх готового интерфейса: раньше любое обновление прав
   * подменяло страницу надписью и выглядело как повторная загрузка
   * приложения.
   */
  if (loading) {
    return (
      <div className="py-16 text-center" role="status" aria-live="polite">
        <p className="text-sm text-muted">
          {coldStart ? 'Сервер просыпается' : 'Проверяем доступ…'}
        </p>

        {coldStart && (
          <p className="mx-auto mt-2 max-w-[320px] text-xs leading-relaxed text-muted/70">
            Бесплатный тариф усыпляет сервис после простоя. Первый запрос
            занимает около минуты — дальше всё быстро.
          </p>
        )}

        {error && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-down">{error}</p>
            <button onClick={() => void reload()} className="btn-ghost px-4 py-1.5 text-xs">
              Повторить
            </button>
          </div>
        )}
      </div>
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
