'use client';

import Link from 'next/link';
import { marketingFor, type PlanCta, type SellablePlan } from '@memex/core';

/**
 * Карточка тарифа.
 *
 * Ровно одно действие, и его состояние приходит готовым из ядра:
 * решать здесь, активна ли кнопка, значило бы завести вторую копию
 * правил рядом с первой.
 *
 * Цена приходит строкой с сервера. Здесь она только отображается —
 * ни складывается, ни округляется, ни пересчитывается. Число,
 * посчитанное в интерфейсе, однажды перестанет совпадать
 * со списываемым.
 */

interface Props {
  plan: SellablePlan;
  /** Строка каталога. Может отсутствовать, если сервер не ответил. */
  price: { amount: string; currency: string } | null;
  termDays: number | null;
  cta: PlanCta;
  /** Порядковый номер для последовательного появления. */
  index: 1 | 2 | 3;
}

export function PlanCard({ plan, price, termDays, cta, index }: Props) {
  const m = marketingFor(plan);

  const surface = m.featured ? 'surface-featured' : 'surface-1';

  return (
    <section
      className={`plan-card plan-enter plan-enter-${index} ${surface} flex h-full flex-col p-5 sm:p-6`}
      aria-labelledby={`plan-${plan}`}
    >
      {/* ─── Шапка ───────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`plan-${plan}`} className="text-lg font-semibold">
            {m.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted">{m.control}</p>
        </div>

        {m.featured && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent">
            Рекомендуем начать
          </span>
        )}

        {m.comingSoon && (
          <span className="shrink-0 rounded-full bg-raised px-2.5 py-1 text-[11px] text-muted">
            Coming soon
          </span>
        )}
      </div>

      {/* ─── Цена ────────────────────────────────────────────────── */}
      <div className="mt-5">
        {price ? (
          <p className="flex items-baseline gap-1.5">
            <span className="num text-3xl font-semibold tracking-tight">{price.amount}</span>
            <span className="text-sm text-muted">{price.currency}</span>
          </p>
        ) : (
          // Сервер не ответил ценой. Показывать выдуманную нельзя,
          // а прочерк честен и не мешает прочесть остальное.
          <p className="num text-3xl font-semibold tracking-tight text-muted">—</p>
        )}

        <p className="mt-1 text-xs text-muted">
          {termDays ? `за ${termDays} суток · без автопродления` : 'без автопродления'}
        </p>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-muted">{m.tagline}</p>

      {/* ─── Выгоды ──────────────────────────────────────────────── */}
      <ul className="mt-5 flex-1 space-y-2.5">
        {m.benefits.map((b) => (
          <li key={b.capability} className="flex gap-2.5 text-sm leading-snug">
            <Check dimmed={m.comingSoon} />
            <span className={m.comingSoon ? 'text-muted' : ''}>{b.text}</span>
          </li>
        ))}
      </ul>

      {/* ─── Действие ────────────────────────────────────────────── */}
      <div className="mt-6">
        {cta.enabled && cta.href ? (
          <Link
            href={cta.href}
            className={`${m.featured ? 'btn-primary' : 'btn-ghost'} w-full py-2.5 text-sm`}
          >
            {cta.label}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="btn w-full cursor-not-allowed border border-border bg-transparent py-2.5 text-sm text-muted"
          >
            {cta.label}
          </button>
        )}
      </div>
    </section>
  );
}

/** Галочка. Инлайновый svg вместо библиотеки ради одной иконки. */
function Check({ dimmed }: { dimmed?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`mt-0.5 shrink-0 ${dimmed ? 'text-muted/50' : 'text-accent'}`}
    >
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
