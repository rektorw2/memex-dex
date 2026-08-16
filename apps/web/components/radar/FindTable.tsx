'use client';

import { riskBand, riskCodeLabel, timeAgo, formatAge, multipleView } from '@memex/core';
import { fmtUsd, fmtPrice } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import type { RadarEvent } from './FindCard';
import { short } from './FindCard';

/**
 * Плотный вид ленты.
 *
 * Нужен тем, кто смотрит радар постоянно. Карточка объясняет одну
 * находку, таблица позволяет сравнить сорок: глаз идёт по колонке
 * и ловит выброс, чего в сетке карточек сделать нельзя в принципе —
 * там каждое число в своём месте.
 *
 * Отсюда требования, которые в карточке необязательны, а здесь
 * обязательны. Числа выровнены по правому краю и набраны моноширинным,
 * иначе сравнение по разрядам не работает. Шапка липкая: без неё
 * на тридцатой строке уже непонятно, что за колонка. И сортировка
 * прямо в заголовках — искать её в другом месте, глядя на таблицу,
 * противоестественно.
 */

const COLUMNS: Array<{
  key: string;
  label: string;
  sort?: string;
  align?: 'right';
  className?: string;
}> = [
  { key: 'token', label: 'Токен' },
  { key: 'chain', label: 'Сеть', className: 'hidden xl:table-cell' },
  { key: 'found', label: 'Найден', sort: 'recent' },
  { key: 'price', label: 'Цена', align: 'right' },
  { key: 'liquidity', label: 'Ликвидность', sort: 'liquidity', align: 'right' },
  { key: 'growth', label: 'Рост', sort: 'growth', align: 'right' },
  { key: 'peak', label: 'Пик', align: 'right' },
  { key: 'risk', label: 'Риск', sort: 'risk', align: 'right' },
  { key: 'reason', label: 'Причина', className: 'hidden lg:table-cell' },
  { key: 'actions', label: '', align: 'right' },
];

export function FindTable({
  events,
  sort,
  onSort,
  onOpen,
  activeId,
}: {
  events: RadarEvent[];
  sort: string;
  onSort: (s: string) => void;
  onOpen?: (e: RadarEvent) => void;
  activeId?: string | null;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="scroll-x">
        <table className="w-full min-w-[860px] border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`px-3 py-2.5 font-normal ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  } ${c.className ?? ''}`}
                >
                  {c.sort ? (
                    <button
                      onClick={() => onSort(c.sort!)}
                      className={`transition-colors hover:text-white ${
                        sort === c.sort ? 'text-accent' : ''
                      }`}
                    >
                      {c.label}
                      {sort === c.sort && <span aria-hidden> ↓</span>}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {events.map((e) => (
              <Row key={e.id} event={e} onOpen={onOpen} active={e.id === activeId} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  event: e,
  onOpen,
  active,
}: {
  event: RadarEvent;
  onOpen?: (e: RadarEvent) => void;
  active?: boolean;
}) {
  const mv = multipleView(e.currentMultiple, e.peakMultiple);
  const band = riskBand(e.riskScore);
  const chain = CHAINS[e.chain];
  const topReason = (e.riskCodes ?? [])[0];

  const tone =
    band?.tone === 'up'
      ? 'text-up'
      : band?.tone === 'warn'
        ? 'text-warn'
        : band?.tone === 'riskHigh'
          ? 'text-riskHigh'
          : band?.tone === 'down'
            ? 'text-down'
            : 'text-muted';

  return (
    <tr
      onClick={() => onOpen?.(e)}
      className={`border-b border-border/50 transition-colors ${
        active ? 'bg-accent/10' : 'hover:bg-raised'
      } ${onOpen ? 'cursor-pointer' : ''}`}
    >
      <td className="px-3 py-2.5">
        <div className="font-medium">{e.symbol}</div>
        {/* Адрес прямо в строке: тикер не уникален, и без контракта
            две одноимённые находки в таблице сливаются. */}
        <div className="num text-[11px] text-muted">{short(e.address)}</div>
      </td>

      <td className="hidden px-3 py-2.5 text-muted xl:table-cell">{chainLabel(e.chain)}</td>

      <td className="px-3 py-2.5 text-muted">{timeAgo(e.firstSeenAt)}</td>

      <td className="num px-3 py-2.5 text-right">{fmtPrice(e.priceUsd)}</td>

      <td className="num px-3 py-2.5 text-right">{fmtUsd(e.liquidityUsd)}</td>

      <td
        className={`num px-3 py-2.5 text-right ${
          !mv.meaningful ? 'text-muted' : mv.isUp ? 'text-up' : 'text-down'
        }`}
      >
        {mv.meaningful ? mv.currentPct : '—'}
      </td>

      <td className="num px-3 py-2.5 text-right text-muted">
        {mv.meaningful ? mv.peak : '—'}
      </td>

      <td className={`num px-3 py-2.5 text-right ${tone}`}>
        {band ? (
          <span title={band.label}>
            {band.sign} {Math.round(e.riskScore!)}
          </span>
        ) : (
          '—'
        )}
      </td>

      <td className="hidden max-w-[180px] px-3 py-2.5 lg:table-cell">
        <span className="block truncate text-[12px] text-muted">
          {topReason ? riskCodeLabel(topReason) : '—'}
        </span>
      </td>

      <td className="px-3 py-2.5 text-right">
        {chain && (
          <a
            href={chain.dexScreener(e.address)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(ev) => ev.stopPropagation()}
            className="whitespace-nowrap rounded px-2 py-1 text-[12px] text-accent transition-colors hover:bg-accent/15"
          >
            График
          </a>
        )}
      </td>
    </tr>
  );
}
