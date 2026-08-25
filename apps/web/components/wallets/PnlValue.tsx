'use client';

/**
 * Отображение результата сделки.
 *
 * Один компонент на ленту, карточку, подробности и подписки. До него
 * каждое место решало само, и в ленте у покупки справа было пустое
 * место — выглядело как потерянные данные, хотя данных там не было
 * и быть не могло: у покупки нет зафиксированного результата, пока
 * не случилась продажа.
 *
 * Заполнить пустоту нулём нельзя. «$0.00» читается как измеренный
 * результат, равный нулю, а это утверждение мы делать не вправе.
 * Поэтому вместо числа показывается причина его отсутствия, и причин
 * этих несколько — они означают разное и выглядят по-разному.
 *
 * Вся логика состояний лежит в ядре и покрыта тестами; здесь только
 * оформление.
 */

import { pnlView, formatExactUsd, type PnlInput, type PnlView } from '@memex/core';

interface Props extends PnlInput {
  /** Плотные списки требуют меньшего кегля. */
  size?: 'sm' | 'md';
  /** Показывать пояснение при наведении. */
  hint?: boolean;
  className?: string;
}

export function PnlValue({ size = 'md', hint = true, className = '', ...input }: Props) {
  const view = pnlView(input);
  const text = size === 'sm' ? 'text-[12px]' : 'text-[13px]';

  return (
    <span
      // Подсказка обязательна для состояний без числа: без неё
      // «Недостаточно истории» выглядит как отговорка, а не как
      // объяснение.
      title={hint ? tooltipFor(view) : undefined}
      className={`${text} ${toneOf(view)} ${className} inline-flex items-center gap-1
        whitespace-nowrap`}
    >
      {/* Числа моноширинные, слова — нет: в колонке цифры должны
          выстраиваться, а пояснение читается как текст. */}
      <span className={view.state === 'available' ? 'num' : ''}>{view.label}</span>

      {view.isStale && (
        <span className="text-[10px] text-muted/60" aria-label="посчитано давно">
          ·&nbsp;давно
        </span>
      )}
    </span>
  );
}

/**
 * Цвет по смыслу, а не по знаку числа.
 *
 * Состояния без величины намеренно приглушены: они не результат,
 * и окрашивать их в зелёный или красный значило бы дать им вес,
 * которого у них нет.
 */
function toneOf(view: PnlView): string {
  if (view.state !== 'available') {
    return view.state === 'incomplete_history' || view.state === 'ambiguous' || view.state === 'stale'
      ? 'text-warn/80'
      : 'text-muted/70';
  }

  if (view.sign > 0) return 'text-up';
  if (view.sign < 0) return 'text-down';

  // Ровный ноль — это измеренный результат, но не прибыль
  // и не убыток. Красить его в зелёный было бы натяжкой.
  return 'text-muted';
}

/**
 * Пояснение.
 *
 * Для известной величины показывается полное число: в списке оно
 * сокращено до «+$2.4M», и точная сумма иначе недоступна нигде.
 */
function tooltipFor(view: PnlView): string {
  if (view.state === 'available' && view.valueUsd != null) {
    const exact = formatExactUsd(view.valueUsd);
    return view.isStale ? `${exact} · ${view.hint} · посчитано давно` : `${exact} · ${view.hint}`;
  }

  return view.hint;
}

/**
 * Три показателя рядом.
 *
 * Реализованный и нереализованный не смешиваются: первый — деньги,
 * которые уже получены, второй — бумажная величина, которая исчезнет
 * при первом развороте рынка. Общий показывается только когда обе
 * части достоверны.
 */
export function PnlBreakdown({
  realized,
  unrealized,
  total,
  isPending,
  hasIncompleteHistory,
  isAmbiguous,
  isPriceStale,
  computedAt,
}: {
  realized: number | null;
  unrealized: number | null;
  /** Серверная Decimal-сумма после преобразования на JSON-границе. */
  total?: number | null;
  isPending?: boolean;
  hasIncompleteHistory?: boolean;
  isAmbiguous?: boolean;
  isPriceStale?: boolean;
  computedAt?: number | null;
}) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-[11px]">
      <Cell label="Реализованный">
        <PnlValue
          valueUsd={realized}
          isPending={isPending}
          hasIncompleteHistory={hasIncompleteHistory}
          isAmbiguous={isAmbiguous}
          computedAt={computedAt}
          kind="realized"
          size="sm"
        />
      </Cell>

      <Cell label="Нереализованный">
        <PnlValue
          valueUsd={unrealized}
          isPending={isPending}
          hasIncompleteHistory={hasIncompleteHistory}
          isAmbiguous={isAmbiguous}
          isPriceStale={isPriceStale}
          computedAt={computedAt}
          kind="unrealized"
          size="sm"
        />
      </Cell>

      <Cell label="Общий">
        <PnlValue
          // Сумма считается только когда известны обе части: сложить
          // известное с неизвестным, подставив ноль, значит выдать
          // половину ответа за целый.
          valueUsd={total ?? null}
          isPending={isPending}
          hasIncompleteHistory={hasIncompleteHistory}
          isAmbiguous={isAmbiguous}
          isPriceStale={isPriceStale}
          computedAt={computedAt}
          kind="total"
          size="sm"
        />
      </Cell>
    </dl>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted/60">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
