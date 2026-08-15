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
      <body>
        <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-3 sm:px-4 h-14 flex items-center gap-2 sm:gap-4 min-w-0">
            <Link href="/" className="font-bold text-lg tracking-tight shrink-0">
              me<span className="text-accent">mex</span>
            </Link>

            <MainNav />

            <div className="flex items-center gap-1 sm:gap-3 shrink-0 ml-auto">
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
