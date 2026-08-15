import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthNav } from '@/components/AuthNav';

export const metadata: Metadata = {
  title: 'Memex — торговля мем-коинами и копитрейдинг',
  description: 'Solana, BNB Chain, Robinhood Chain. Лимитные ордера, коллы, копитрейдинг.',
};

const nav = [
  { href: '/', label: 'Терминал' },
  { href: '/calls', label: 'Коллы' },
  { href: '/radar', label: 'Радар' },
  // Название «Смарт-деньги», а не «Кошельки»: пункт /wallet ниже — это
  // собственные кошельки пользователя, и два «Кошелька» в меню путали бы.
  { href: '/wallets', label: 'Смарт-деньги' },
  { href: '/copy', label: 'Копитрейдинг' },
  { href: '/portfolio', label: 'Портфель' },
  { href: '/wallet', label: 'Кошельки' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-3 sm:px-4 h-14 flex items-center gap-2 sm:gap-6">
            {/* На телефоне вместо слова — знак: разделы в шапке
                прокручиваются вбок, и каждый пиксель, отданный названию,
                это пиксель, отнятый у навигации. */}
            <Link href="/" aria-label="memex" className="shrink-0">
              <span
                aria-hidden
                className="bg-accent text-bg flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold sm:hidden"
              >
                m
              </span>
              <span className="hidden text-lg font-bold tracking-tight sm:inline">
                me<span className="text-accent">mex</span>
              </span>
            </Link>

            {/* На узком экране разделы прокручиваются вбок внутри шапки.
                Перенос на вторую строку сдвигал бы контент вниз при каждом
                открытии страницы, а сокращать названия до иконок здесь
                нечем — разделы называются словами. */}
            <nav className="flex gap-1 text-sm scroll-x flex-1 -mx-1 px-1">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-2 sm:px-3 py-1.5 rounded-md text-muted hover:text-white hover:bg-border transition-colors whitespace-nowrap"
                >
                  {n.label}
                </Link>
              ))}
            </nav>

            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {/* Метка режима — справочная, на телефоне место дороже. */}
              <span
                className="hidden md:inline text-xs px-2 py-1 rounded bg-accent/15 text-accent border border-accent/30 whitespace-nowrap"
                title="Ордера исполняются по реальным котировкам, но транзакции в сеть не отправляются"
              >
                paper mode
              </span>
              <AuthNav />
            </div>
          </div>
        </header>

        <main className="max-w-[1600px] mx-auto px-3 sm:px-4 py-4 sm:py-6 min-w-0">{children}</main>

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
