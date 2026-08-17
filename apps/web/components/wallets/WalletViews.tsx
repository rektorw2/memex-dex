'use client';

import { useState } from 'react';
import {
  timeAgo,
  winRateView,
  formatMultiple,
  formatEntryTime,
  categorize,
  CATEGORY_LABELS,
  CATEGORY_EXPLAIN,
  confidenceOf,
  type WalletCategory,
} from '@memex/core';
import { fmtUsd } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { SmartScore, Identicon, tooltip, type WalletStats } from './SmartScore';
import { FavoriteStar } from './FavoriteStar';

/**
 * Два представления списка кошельков.
 *
 * На широком экране — таблица: смотрят её, чтобы сравнить сорок
 * кошельков между собой, и для этого нужны выровненные колонки.
 * На телефоне — карточки: таблица из девяти колонок на трёхстах
 * девяноста пикселях нечитаема при любой вёрстке, а сжатие её
 * до двух колонок делает бессмысленным сам смысл таблицы.
 *
 * Общее у обоих — порядок чтения, заданный вопросами человека:
 * что за кошелёк, почему он считается умным, насколько надёжна
 * оценка, какие результаты, что делать дальше.
 */

export interface Wallet {
  chain: string;
  address: string;
  knownAs?: string | null;
  score: number | null;
  settled?: number | null;
  tokensBought?: number | null;
  wins2x: number | null;
  wins5x?: number | null;
  rugs: number | null;
  hitRate?: number | null;
  avgPeakMultiple: number | null;
  medianEntryHours: number | null;
  volumeUsd: string | number | null;
  label?: string | null;
  lastActiveAt?: string | null;
}

/** Сводим поля кошелька к тому, что нужно оценке. */
export function statsOf(w: Wallet): WalletStats {
  return {
    score: w.score,
    // Завершённых сделок: если поле не пришло, берём число купленных
    // токенов — оно ближе всего по смыслу и не завышает выборку.
    settled: w.settled ?? w.tokensBought ?? 0,
    wins2x: w.wins2x,
    hitRate: w.hitRate ?? null,
    avgMultiple: w.avgPeakMultiple,
    medianEntryHours: w.medianEntryHours,
    rugs: w.rugs,
  };
}

export function categoryOf(w: Wallet): WalletCategory {
  return categorize({
    settled: w.settled ?? w.tokensBought ?? 0,
    volumeUsd: w.volumeUsd == null ? null : Number(w.volumeUsd),
    medianEntryHours: w.medianEntryHours,
    score: w.score,
  });
}

// ─────────────────────────── Личность кошелька ──────────────────────────────

export function WalletIdentity({
  wallet: w,
  size = 32,
}: {
  wallet: Wallet;
  size?: number;
}) {
  const cat = categoryOf(w);

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Identicon address={w.address} size={size} />

      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {/* Своё название важнее адреса, если оно задано: человек
              помнит кошелёк по названию, а не по base58. */}
          <span className="num truncate text-[13px]">
            {w.knownAs || short(w.address)}
          </span>
          <CopyButton address={w.address} />
        </div>
        <div className="truncate text-[11px] text-muted">
          {chainLabel(w.chain)} · <span title={CATEGORY_EXPLAIN[cat]}>{CATEGORY_LABELS[cat]}</span>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={address}
      aria-label="Копировать адрес"
      className="shrink-0 text-muted transition-colors hover:text-white"
    >
      {copied ? (
        <span className="text-[10px] text-up">скопировано</span>
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </button>
  );
}

export function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a;
}

// ────────────────────────────── Таблица ─────────────────────────────────────

const COLUMNS: Array<{ key: string; label: string; sort?: string; right?: boolean; hide?: string }> = [
  { key: 'wallet', label: 'Кошелёк' },
  { key: 'score', label: 'Smart Score', sort: 'score' },
  { key: 'wins', label: 'Сделки ≥2×', sort: 'winrate' },
  { key: 'avg', label: 'Средний максимум', sort: 'avg', right: true },
  { key: 'entry', label: 'Медианный вход', sort: 'entry', right: true, hide: 'hidden xl:table-cell' },
  { key: 'volume', label: 'Объём покупок', sort: 'volume', right: true },
  { key: 'active', label: 'Активность', sort: 'active', right: true, hide: 'hidden lg:table-cell' },
  { key: 'actions', label: '', right: true },
];

export function WalletTable({
  wallets,
  sort,
  onSort,
  onOpen,
}: {
  wallets: Wallet[];
  sort: string;
  onSort: (s: string) => void;
  onOpen: (w: Wallet) => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="scroll-x">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`px-3 py-2.5 font-normal ${c.right ? 'text-right' : 'text-left'} ${c.hide ?? ''}`}
                >
                  {c.sort ? (
                    <button
                      onClick={() => onSort(c.sort!)}
                      className={`transition-colors hover:text-white ${sort === c.sort ? 'text-accent' : ''}`}
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
            {wallets.map((w) => (
              <TableRow key={`${w.chain}:${w.address}`} wallet={w} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableRow({ wallet: w, onOpen }: { wallet: Wallet; onOpen: (w: Wallet) => void }) {
  const s = statsOf(w);
  const wr = winRateView(w.wins2x, s.settled);
  const chain = CHAINS[w.chain];

  return (
    <tr
      onClick={() => onOpen(w)}
      className="cursor-pointer border-b border-border/50 transition-colors hover:bg-raised"
    >
      <td className="px-3 py-2.5">
        <WalletIdentity wallet={w} />
      </td>

      <td className="px-3 py-2.5">
        <SmartScore stats={s} compact />
      </td>

      <td className="px-3 py-2.5">
        {/* Противоречивые данные показываются как противоречивые,
            а не подгоняются под правдоподобный вид. */}
        <span className={`num ${wr.isImpossible ? 'text-down' : ''}`} title={tooltip(s)}>
          {wr.text}
        </span>
      </td>

      <td className="num px-3 py-2.5 text-right">{formatMultiple(w.avgPeakMultiple)}</td>

      <td className="num hidden px-3 py-2.5 text-right xl:table-cell">
        {formatEntryTime(w.medianEntryHours)}
      </td>

      {/* Денежная величина всегда подписана: без подписи «$257.18M»
          можно прочитать и как баланс, и как оборот, и как прибыль. */}
      <td className="num px-3 py-2.5 text-right" title="Совокупный объём покупок">
        {fmtUsd(w.volumeUsd)}
      </td>

      <td className="hidden px-3 py-2.5 text-right text-muted lg:table-cell">
        {w.lastActiveAt ? timeAgo(w.lastActiveAt) : '—'}
      </td>

      <td className="px-3 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <FavoriteStar chain={w.chain} address={w.address} size="sm" />
          {chain && (
            <a
              href={chain.explorerAddress?.(w.address) ?? chain.explorerToken(w.address)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Открыть в обозревателе"
              className="rounded px-2 py-1 text-accent transition-colors hover:bg-accent/15"
            >
              ↗
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}

// ────────────────────────────── Карточка ────────────────────────────────────

export function WalletCard({
  wallet: w,
  onOpen,
}: {
  wallet: Wallet;
  onOpen: (w: Wallet) => void;
}) {
  const s = statsOf(w);
  const wr = winRateView(w.wins2x, s.settled);
  const chain = CHAINS[w.chain];

  return (
    <article className="panel space-y-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <WalletIdentity wallet={w} size={36} />
        </div>
        {/* Звезда в шапке карточки: то же состояние, что в ленте
            и в таблице — источник один на всё приложение. */}
        <FavoriteStar chain={w.chain} address={w.address} />
      </div>

      <div className="rounded-lg bg-raised p-2.5">
        <SmartScore stats={s} />
      </div>

      {/* Четыре величины сеткой: сравнивать их между кошельками
          удобнее, когда они всегда на одних местах. */}
      <div className="grid grid-cols-2 gap-2">
        <Metric
          label="Сделки ≥2×"
          value={wr.text}
          tone={wr.isImpossible ? 'down' : undefined}
        />
        <Metric label="Средний максимум" value={formatMultiple(w.avgPeakMultiple)} />
        <Metric label="Медианный вход" value={formatEntryTime(w.medianEntryHours)} />
        <Metric label="Объём покупок" value={fmtUsd(w.volumeUsd)} />
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span className="text-[11px] text-muted">
          {w.lastActiveAt ? `Активен ${timeAgo(w.lastActiveAt)}` : 'Активность неизвестна'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {chain && (
            <a
              href={chain.explorerAddress?.(w.address) ?? chain.explorerToken(w.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="tap grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:text-white"
              aria-label="Открыть в обозревателе"
            >
              ↗
            </a>
          )}
          <button
            onClick={() => onOpen(w)}
            className="tap h-9 rounded-lg bg-accent/15 px-3 text-xs font-medium text-accent"
          >
            Подробнее
          </button>
        </div>
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'down';
}) {
  return (
    <div className="min-w-0 rounded-md bg-raised p-2.5">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className={`num truncate text-[13px] ${tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </div>
    </div>
  );
}
