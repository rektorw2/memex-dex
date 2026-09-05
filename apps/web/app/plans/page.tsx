'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {
  SELLABLE_PLANS,
  loginHref,
  planCta,
  trialDaysLabel,
  withNext,
  type SellablePlan,
} from '@memex/core';
import { rootFetcher, hasToken } from '@/lib/api';
import { useAccess, trialRemainingLabel, formatUntil } from '@/lib/access';
import { useNextParam } from '@/lib/next-param';
import { PlanCard } from '@/components/plans/PlanCard';
import { PnlBlock } from '@/components/plans/PnlBlock';
import { Comparison } from '@/components/plans/Comparison';

/**
 * Тарифы.
 *
 * Страница отвечает на один вопрос: сколько контроля человек хочет
 * отдать машине. Ручной, полуавтоматический, автоматический — это
 * не три уровня щедрости, а три разных ответа, и цена лишь следствие.
 *
 * Три источника, и ни один не дублируется в интерфейсе.
 *
 * Цены, срок и валюта — из `/payments/catalog`, того же каталога,
 * по которому считают деньги. Возможности — из `/access/plans`,
 * той же матрицы, по которой проверяют доступ. Состояние человека —
 * из `/access/me`. Записанное здесь руками разошлось бы с каждым
 * из трёх, и заметил бы это первым тот, кто заплатил.
 *
 * PnL живёт отдельным необязательным блоком: его ошибка не должна
 * мешать посмотреть цены.
 */

interface CatalogResponse {
  trialHours: number;
  paymentsEnabled: boolean;
  plans: Array<{
    plan: string;
    price: { amount: string; currency: string };
    termDays: number;
    sourceCurrency: string;
    sourceAmount: string;
    settlementChain: string;
  }>;
}

interface PlansResponse {
  plans: Array<{ plan: string; capabilities: string[] }>;
}

interface PaymentsStatus {
  enabled: boolean;
  provider: 'disabled' | 'bridge' | 'coinbase';
  capabilities: string[];
  sandbox: boolean;
}

function PlansPageContent() {
  const { access, anonymous, loading: accessLoading } = useAccess();
  const next = useNextParam();
  const [hasLocalSession, setHasLocalSession] = useState<boolean | null>(null);

  // Гостю не нужно ждать, пока проснётся API, чтобы увидеть регистрацию.
  // Наличие сессии читается сразу после гидратации; права и тариф всё
  // равно подтверждает сервер. Для вошедшего человека гостевые кнопки
  // при этом не мигают во время холодного старта.
  useEffect(() => {
    // Тот же вопрос, что у `hasSession` в провайдере прав, и тот же
    // способ ответа. Прямое чтение хранилища здесь было третьей
    // копией правила — и падало бы там же, где падал `MobileNav`.
    setHasLocalSession(hasToken());
  }, []);

  // Три независимых запроса вместо одного Promise.all: ошибка одного
  // не должна оставлять страницу пустой. Каталог важнее остальных —
  // без него нет цен, — и только он показывает ошибку.
  //
  // Загрузчик именно `rootFetcher`: эти три маршрута живут под `/api`,
  // а не под `/api/v1`. С обычным `fetcher` страница получала 404
  // по всем трём — и получала молча, потому что ошибку каждого
  // необязательного запроса здесь гасят.
  const catalog = useSWR<CatalogResponse>('/payments/catalog', rootFetcher, {
    shouldRetryOnError: false,
  });

  const caps = useSWR<PlansResponse>('/access/plans', rootFetcher, { shouldRetryOnError: false });

  const status = useSWR<PaymentsStatus>('/payments/status', rootFetcher, {
    shouldRetryOnError: false,
  });

  const capabilitiesByPlan: Record<string, string[]> = Object.fromEntries(
    (caps.data?.plans ?? []).map((p) => [p.plan, p.capabilities]),
  );

  const priceOf = (plan: SellablePlan) => catalog.data?.plans.find((p) => p.plan === plan) ?? null;

  const paymentsEnabled = status.data?.enabled ?? catalog.data?.paymentsEnabled ?? false;
  const sandbox = status.data?.sandbox ?? false;

  const trialActive = access?.effectivePlan === 'TRIAL';
  const serviceAccess = access?.serviceAccess ?? false;
  const hasAccess =
    !anonymous && access != null && (serviceAccess || access.effectivePlan !== 'EXPIRED');
  const showGuestActions = accessLoading ? hasLocalSession === false : anonymous;

  return (
    <div className="mx-auto max-w-6xl pb-16">
      {/* ══════════════════ Первый экран ══════════════════════════ */}
      <header className="pt-8 sm:pt-12">
        <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
          {catalog.data ? trialDaysLabel(catalog.data.trialHours) : '5 суток'} Pro бесплатно
        </span>

        <h1 className="mt-4 max-w-[20ch] text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          Выберите, сколько решений принимаете вы
        </h1>

        <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-muted">
          Ручной разбор, вход по сигналу или автоматическая стратегия — три уровня
          контроля над одним и тем же терминалом. Начать можно с бесплатного периода
          и передумать в любой момент.
        </p>

        {/* ─── Основные действия ─────────────────────────────────── */}
        <div className="mt-7 flex flex-wrap items-center gap-3">
          {showGuestActions && (
            <>
              <Link
                href={loginHref(next, { register: true })}
                className="btn-primary px-6 py-2.5 text-sm"
              >
                Начать бесплатно
              </Link>
              <Link href={loginHref(next)} className="btn-ghost px-5 py-2.5 text-sm">
                Войти
              </Link>
            </>
          )}

          {!accessLoading && !anonymous && (
            <Link
              href={hasAccess ? (next ?? '/terminal') : withNext('/onboarding', next)}
              className="btn-primary px-6 py-2.5 text-sm"
            >
              {hasAccess ? (next ? 'Продолжить' : 'В приложение') : 'Выбрать Pro'}
            </Link>
          )}

          <Link
            href="/terminal"
            className="px-1 py-2.5 text-sm text-accent underline-offset-4 hover:underline"
          >
            Открыть терминал без регистрации →
          </Link>
        </div>

        {/* ─── Доверие ───────────────────────────────────────────── */}
        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
          <Trust>Карта для бесплатного периода не нужна</Trust>
          <Trust>Автоматического продления нет</Trust>
          <Trust>Продажа своих активов и вывод средств доступны всегда</Trust>
        </ul>

        {/* ─── Текущее состояние ─────────────────────────────────── */}
        {!accessLoading && serviceAccess && (
          <div className="surface-2 mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <span className="font-medium">Служебный доступ</span>
            <span className="text-muted">
              Все возможности открыты ролью, без подписки и срока
            </span>
          </div>
        )}

        {!accessLoading && !serviceAccess && trialActive && access && (
          <div className="surface-2 mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <span className="font-medium">Бесплатный период Pro активен</span>
            <span className="text-muted">
              осталось {trialRemainingLabel(access.trialRemainingSeconds)} · до{' '}
              {formatUntil(access.trialExpiresAt)}
            </span>
            {/*
              Действие рядом с сообщением, а не где-то ниже.
              Человек, только что получивший доступ, пришёл сюда
              не читать про тарифы — ему надо в продукт.

              Кнопки «начать период» здесь нет и быть не может:
              период уже идёт, и предлагать запустить его второй раз
              значит обещать то, чего не будет.
            */}
            <Link
              href="/agent"
              className="ml-auto inline-flex min-h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-[#7C3AED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Перейти к агенту
            </Link>
          </div>
        )}

        {sandbox && (
          <p className="mt-6 rounded-lg border border-down/40 bg-down/5 px-4 py-3 text-sm">
            <strong>Тестовый режим оплаты.</strong> Настоящие деньги не принимаются
            и не списываются — не вводите реальную карту.
          </p>
        )}
      </header>

      {/* ══════════════════ Карточки ═════════════════════════════ */}
      <div className="mt-10 grid items-stretch gap-4 lg:grid-cols-3">
        {catalog.isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          SELLABLE_PLANS.map((plan, i) => {
            const entry = priceOf(plan);

            return (
              <PlanCard
                key={plan}
                plan={plan}
                price={entry?.price ?? null}
                termDays={entry?.termDays ?? null}
                index={(i + 1) as 1 | 2 | 3}
                cta={planCta({
                  plan,
                  authenticated: !anonymous,
                  currentPlan: access?.effectivePlan ?? 'EXPIRED',
                  serviceAccess,
                  // Гость ещё не имеет состояния на сервере, но период
                  // ему доступен — иначе первый экран предлагал бы
                  // купить то, что даётся бесплатно.
                  canStartTrial: anonymous ? true : (access?.canStartTrial ?? false),
                  paymentsEnabled,
                })}
              />
            );
          })
        )}
      </div>

      {catalog.error && (
        <p className="mt-4 text-sm text-down" role="alert">
          Не удалось загрузить тарифы. Обновите страницу.
        </p>
      )}

      {/* ══════════════════ PnL ══════════════════════════════════ */}
      <PnlBlock />

      {/* ══════════════════ Сравнение ════════════════════════════ */}
      <Comparison capabilitiesByPlan={capabilitiesByPlan} />

      {/* ══════════════════ Оплата ═══════════════════════════════ */}
      <details className="disclosure surface-1 mt-14 overflow-hidden">
        <summary className="flex items-center gap-2 px-5 py-4 text-sm font-medium">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden
            className="disclosure-chevron shrink-0 text-muted"
          >
            <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Как проходит оплата
        </summary>

        <div className="disclosure-body space-y-3 border-t border-border px-5 py-4 text-sm leading-relaxed text-muted">
          <p>
            Оплаченный период — ровно{' '}
            <strong className="text-white">
              {catalog.data?.plans[0]?.termDays ?? 30} суток
            </strong>
            , не «месяц»: месяц бывает 28, 29, 30 и 31 день, и разница однажды
            превратилась бы в спор.
          </p>

          <p>
            Автоматического продления нет. Когда период заканчивается, доступ просто
            закрывается — списания не происходит, и следующий период покупается отдельно.
          </p>

          <p>
            Оплата принимается в{' '}
            {catalog.data?.plans[0]?.sourceCurrency ?? 'USD'} и конвертируется
            в {catalog.data?.plans[0]?.price.currency ?? 'USDC'}. Расчёт проходит в сети{' '}
            {catalog.data?.plans[0]?.settlementChain === 'SOLANA'
              ? 'Solana'
              : (catalog.data?.plans[0]?.settlementChain ?? 'Solana')}
            . Комиссии конвертации и окончательную сумму показывает платёжный провайдер —
            мы их не назначаем и заранее не знаем.
          </p>

          {!paymentsEnabled && (
            <p className="text-white">
              Сейчас оплата не подключена. Кнопок покупки на странице нет намеренно:
              кнопка, за которой ничего нет, хуже её отсутствия.
            </p>
          )}

          <p>
            Продажа своих активов, вывод средств и просмотр портфеля не зависят от плана
            и остаются доступными после его окончания. <Link href="/terminal" className="text-accent hover:underline">Терминал</Link>{' '}
            открыт и без регистрации.
          </p>
        </div>
      </details>

      <p className="mt-10 max-w-[68ch] text-xs leading-relaxed text-muted/60">
        Торговля криптоактивами сопряжена с высоким риском полной потери средств.
        Мем-коины крайне волатильны и могут обесцениться до нуля. Оценка риска, находки
        и статистика не являются инвестиционной рекомендацией.
      </p>
    </div>
  );
}

function Trust({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-accent">
        <path
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </li>
  );
}

/**
 * Скелетон карточки.
 *
 * Повторяет её форму, а не сообщает «загружаем»: когда содержимое
 * приезжает, разметка не прыгает, потому что место уже занято.
 */
function CardSkeleton() {
  return (
    <div className="surface-1 flex h-full flex-col p-5 sm:p-6" aria-hidden>
      <div className="skeleton h-5 w-24" />
      <div className="skeleton mt-6 h-9 w-32" />
      <div className="skeleton mt-2 h-3 w-40" />
      <div className="skeleton mt-5 h-4 w-full" />

      <div className="mt-6 flex-1 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-3.5 w-full" />
        ))}
      </div>

      <div className="skeleton mt-6 h-10 w-full" />
    </div>
  );
}

export default PlansPageContent;
