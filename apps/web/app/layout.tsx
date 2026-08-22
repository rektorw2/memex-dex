import './globals.css';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { AuthNav } from '@/components/AuthNav';
import { MainNav } from '@/components/MainNav';
import { MobileNav } from '@/components/MobileNav';
import { FavoritesProvider } from '@/lib/favorites';
import { AccessProvider } from '@/lib/access';
import { AccessBanner } from '@/components/AccessBanner';
import { RouteGuard } from '@/components/RouteGuard';

export const metadata: Metadata = {
  title: 'Memex — торговля мем-коинами и копитрейдинг',
  description: 'Solana, BNB Chain, Robinhood Chain. Лимитные ордера, коллы, копитрейдинг.',
};

/**
 * Цвет полос браузера.
 *
 * Без themeColor мобильный браузер красит область статус-бара и нижнюю
 * панель своим цветом по умолчанию — на тёмной странице получается
 * заметный стык двух разных чёрных. Значение совпадает с фоном страницы,
 * поэтому граница исчезает совсем.
 *
 * viewportFit: 'cover' пускает страницу под вырез и под нижнюю
 * перекладину. Без него система оставляет там свои поля, и они
 * не окрашиваются вовсе.
 */
export const viewport: Viewport = {
  themeColor: '#080B0F',
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        {/*
          Шрифты подключены ссылкой, а не через next/font/google.

          next/font скачивает файлы на этапе сборки — то есть делает
          деплой зависимым от доступности серверов Google в момент
          сборки. Если они недоступны или медленны, падает весь деплой,
          а не оформление.

          Ссылка переносит эту зависимость в рантайм: при недоступности
          шрифта браузер возьмёт запасной из стека, и интерфейс просто
          будет выглядеть чуть иначе. Для торгового терминала обмен
          выгодный — работоспособность важнее гарнитуры.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="font-sans">
        {/* Избранные кошельки — общее состояние на всё приложение.
            Звезда стоит в списке, в карточке и в ленте, и все три
            обязаны показывать одно и то же: отдельные источники
            расходятся ровно в момент нажатия. */}
        <AccessProvider>
        <FavoritesProvider>
        {/*
          Шапка устроена по-разному на телефоне и на десктопе.

          На телефоне это три части: кнопка меню слева, логотип
          по центру, вход справа. Логотип центрируется по экрану,
          а не между соседями — их ширины разные, и центрирование
          потоком сдвигало бы логотип каждый раз, когда «Войти»
          сменяется аватаром. Отсюда absolute и translateX(-50%):
          это единственный способ получить настоящий центр.

          На десктопе логотип остаётся слева, как было: там он
          начинает строку навигации, и центрировать его незачем.
        */}
        <header
          className="sticky top-0 z-50 border-b border-border bg-bg"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <div className="relative mx-auto flex h-header min-w-0 max-w-[1800px] items-center gap-2 px-4 sm:gap-4 sm:px-5">
            <MobileNav />

            {/* Логотип — единственный путь на терминал. Отдельного
                пункта в навигации нет: он вёл бы в тот же адрес,
                что и логотип рядом с ним. */}
            <Link
              href="/terminal"
              aria-label="Терминал"
              className="absolute left-1/2 -translate-x-1/2 rounded-md text-lg font-bold tracking-tight transition-opacity hover:opacity-80 md:static md:translate-x-0 md:shrink-0"
            >
              me<span className="text-accent">mex</span>
            </Link>

            <MainNav />

            {/* Режим и аккаунт живут внутри AuthNav: держать метку
                отдельно значило бы иметь два независимых источника
                правды о состоянии сессии. */}
            <div className="ml-auto flex shrink-0 items-center">
              <AuthNav />
            </div>
          </div>
        </header>

        <AccessBanner />

        {/* Сторож стоит один раз на всё приложение. Проверки
            по страницам расходились между собой, и вопрос «что
            видит гость» не имел одного ответа. */}
        <main className="mx-auto min-w-0 max-w-[1800px] px-4 py-4 sm:px-5 sm:py-5">
          <RouteGuard>{children}</RouteGuard>
        </main>

        <footer className="max-w-[1600px] mx-auto px-4 py-8 text-xs text-muted border-t border-border mt-12">
          <p className="max-w-3xl leading-relaxed">
            Торговля криптоактивами сопряжена с высоким риском полной потери средств.
            Мем-коины крайне волатильны и могут обесцениться до нуля. Коллы и статистика
            лидеров не являются инвестиционной рекомендацией. Прошлые результаты не
            гарантируют будущих. Комиссия за успех — 10% от прибыли по копируемым сделкам,
            удерживается при выходе из позиции.
          </p>
        </footer>
        </FavoritesProvider>
        </AccessProvider>
      </body>
    </html>
  );
}
