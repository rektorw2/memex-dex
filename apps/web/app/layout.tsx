import './globals.css';
import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import { FavoritesProvider } from '@/lib/favorites';
import { TokenFavoritesProvider } from '@/lib/token-favorites';
import { AccessProvider } from '@/lib/access';

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
        <TokenFavoritesProvider>
        <AppShell>{children}</AppShell>
        </TokenFavoritesProvider>
        </FavoritesProvider>
        </AccessProvider>
      </body>
    </html>
  );
}
