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
  { href: '/copy', label: 'Копитрейдинг' },
  { href: '/portfolio', label: 'Портфель' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center gap-6">
            <Link href="/" className="font-bold text-lg tracking-tight">
              me<span className="text-accent">mex</span>
            </Link>
            <nav className="flex gap-1 text-sm">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3 py-1.5 rounded-md text-muted hover:text-white hover:bg-border transition-colors"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <span
                className="text-xs px-2 py-1 rounded bg-accent/15 text-accent border border-accent/30"
                title="Ордера исполняются по реальным котировкам, но транзакции в сеть не отправляются"
              >
                paper mode
              </span>
              <AuthNav />
            </div>
          </div>
        </header>

        <main className="max-w-[1600px] mx-auto px-4 py-6">{children}</main>

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
