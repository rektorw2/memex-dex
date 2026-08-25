'use client';

import { fmtUsd } from '@/lib/api';
import { CHAIN_LABEL } from './types';

/**
 * Сводка рынка.
 *
 * ─── Что было ───────────────────────────────────────────────────────
 *
 * Одна горизонтальная лента с прокруткой. На широком экране она
 * работала, на телефоне — нет: показатели уезжали за край, и о том,
 * что их там ещё четыре, узнать было нельзя. Полоса прокрутки
 * скрыта, а горизонтальный сдвиг внутри узкой ленты пальцем почти
 * не нащупывается.
 *
 * ─── Что стало ──────────────────────────────────────────────────────
 *
 * Сетка. Показатели переносятся по строкам и остаются целиком
 * на экране на любой ширине: две колонки на телефоне, три на планшете,
 * дальше по содержимому. Подписи приглушены, значения контрастны
 * и набраны тем же числовым стилем, что и таблица под ними, — иначе
 * глаз не может сравнить число из сводки с числом из списка.
 */

interface Summary {
  tokens?: number;
  passedCheck?: number;
  volume24hUsd?: string | number | null;
  liquidityUsd?: string | number | null;
  byChain?: Record<string, number>;
  dataSource?: string | null;
  updatedAt?: string | null;
}

/** Время обновления в местном формате. Дата не нужна — данные минутные. */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';

  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '—';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      {/*
        Подпись не обрезается многоточием и не переносится: «Прошли
        проверку» в две строки ломало бы высоту соседних ячеек.
        Ширина колонки подобрана под самую длинную подпись.
      */}
      <div className="truncate text-[11px] leading-tight text-muted" title={label}>
        {label}
      </div>
      <div className="num truncate text-sm leading-tight text-white">{value}</div>
    </div>
  );
}

export function MarketStats({ summary, compact }: { summary: Summary | null | undefined; compact?: boolean }) {
  if (!summary) {
    return (
      <div className="panel grid shrink-0 grid-cols-2 gap-x-4 gap-y-3 p-3 sm:grid-cols-3 lg:flex lg:h-stats lg:items-center lg:gap-6 lg:px-4 lg:py-0">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 animate-pulse rounded bg-raised lg:w-24" />
        ))}
      </div>
    );
  }

  const items: Array<[string, string]> = [
    // «Прошли проверку», а не «Токенов»: число в шапке должно совпадать
    // с тем, что человек видит в списке, иначе оно вводит в заблуждение.
    ['Прошли проверку', String(summary.passedCheck ?? summary.tokens ?? 0)],
    ['Объём 24ч', fmtUsd(summary.volume24hUsd)],
    ['Ликвидность', fmtUsd(summary.liquidityUsd)],
    ...Object.entries(summary.byChain ?? {}).map(
      ([c, n]) => [CHAIN_LABEL[c] ?? c, String(n)] as [string, string],
    ),
  ];

  return (
    <div
      className={`panel grid shrink-0 grid-cols-2 gap-x-4 gap-y-3 p-3 sm:grid-cols-3 lg:flex lg:items-center lg:gap-6 lg:px-4 lg:py-0 ${
        compact ? '' : 'lg:h-stats'
      }`}
    >
      {items.map(([label, value]) => (
        <Metric key={label} label={label} value={value} />
      ))}

      {/*
        Источник и время последнего обновления.

        Оба нужны по одной причине: число без указания, откуда оно
        и насколько свежее, читается как вечная истина. Цена
        мем-коина живёт секунды, и человек имеет право видеть,
        на что он смотрит.

        На узком экране занимает обе колонки и отделяется линией:
        это не показатель рынка, а сведения о самих показателях.
      */}
      {summary.dataSource && (
        <div className="col-span-2 border-t border-border/60 pt-2 text-[11px] leading-tight text-muted sm:col-span-3 lg:ml-auto lg:border-0 lg:pl-4 lg:pt-0 lg:text-right">
          <div>Рыночные данные: {summary.dataSource}</div>
          <div className="text-muted/70">Обновлено {fmtTime(summary.updatedAt)}</div>
        </div>
      )}
    </div>
  );
}
