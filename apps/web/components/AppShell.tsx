'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthNav } from '@/components/AuthNav';
import { MainNav } from '@/components/MainNav';
import { MobileNav } from '@/components/MobileNav';
import { RouteGuard } from '@/components/RouteGuard';

/**
 * Общая рамка приложения.
 *
 * Первый экран намеренно полноэкранный: на нём одна задача и одно
 * действие. Шапка и футер появляются уже внутри продукта, где
 * человеку нужна навигация и состояние аккаунта.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWelcome = pathname === '/';

  if (isWelcome) {
    return (
      <main className="min-h-[100svh] min-w-0 bg-bg">
        <RouteGuard>{children}</RouteGuard>
      </main>
    );
  }

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b border-border bg-bg"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="relative mx-auto flex h-header min-w-0 max-w-[1800px] items-center gap-2 px-4 sm:gap-4 sm:px-5">
          <MobileNav />

          <Link
            href="/"
            aria-label="Главная"
            className="absolute left-1/2 -translate-x-1/2 rounded-md text-lg font-bold tracking-tight transition-opacity hover:opacity-80 lg:static lg:translate-x-0 lg:shrink-0"
          >
            me<span className="text-accent">mex</span>
          </Link>

          <MainNav />

          <div className="ml-auto flex shrink-0 items-center">
            <AuthNav />
          </div>
        </div>
      </header>

      {/*
        Полосы состояния доступа под шапкой больше нет.

        Она занимала высоту на каждой странице, выглядела как системное
        предупреждение и вмещала два-три предложения там, где хватает
        одного слова. Состояние доступа переехало в верхнюю панель
        рядом с режимом торговли: `AccessStatusControl`.
      */}
      <main className="mx-auto min-w-0 max-w-[1800px] px-4 py-4 sm:px-5 sm:py-5">
        <RouteGuard>{children}</RouteGuard>
      </main>

      <footer className="mx-auto mt-12 max-w-[1600px] border-t border-border px-4 py-8 text-xs text-muted">
        <p className="max-w-3xl leading-relaxed">
          Торговля криптоактивами сопряжена с высоким риском полной потери средств.
          Мем-коины крайне волатильны и могут обесцениться до нуля. Коллы и статистика
          лидеров не являются инвестиционной рекомендацией. Прошлые результаты не
          гарантируют будущих. Комиссия за успех — 10% от прибыли по копируемым сделкам,
          удерживается при выходе из позиции.
        </p>
      </footer>
    </>
  );
}
