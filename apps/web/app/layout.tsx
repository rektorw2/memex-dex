import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthNav } from '@/components/AuthNav';
import { MainNav } from '@/components/MainNav';

export const metadata: Metadata = {
  title: 'Memex — торговля мем-коинами и копитрейдинг',
  description: 'Solana, BNB Chain, Robinhood Chain. Лимитные ордера, коллы, копитрейдинг.',
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
        <header className="border-b border-border bg-panel/80 backdrop-blur sticky top-0 z-50">
          <div className="mx-auto flex h-header min-w-0 max-w-[1800px] items-center gap-2 px-4 sm:gap-4 sm:px-5">
            <Link href="/" className="font-bold text-lg tracking-tight shrink-0">
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

        <main className="mx-auto min-w-0 max-w-[1800px] px-4 py-4 sm:px-5 sm:py-5">{children}</main>

        <footer className="max-w-[1600px] mx-auto px-4 py-8 text-xs text-muted border-t border-border mt-12">
          <p className="max-w-3xl leading-relaxed">
            Торговля криптоактивами сопряжена с высоким риском полной потери средств.
            Мем-коины крайне волатильны и могут обесцениться до нуля. Коллы и статистика
            лидеров не являются инвестиционной рекомендацией. Прошлые результаты не
            гарантируют будущих. Комиссия за успех — 10% от прибыли по копируемым сделкам,
            удерживается при выходе из позиции.
          </p>
        </footer>
      </body>
    </html>
  );
}
