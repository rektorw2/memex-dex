'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/api';

/**
 * Блок «кто покупает».
 *
 * Показывает не только найденные кошельки, но и знаменатель: сколько
 * сделок вообще попало в наблюдение. Панель, где написано «3 смарт-кошелька»
 * без указания, из скольких сделок они выбраны, выглядит убедительнее,
 * чем есть на самом деле.
 *
 * Когда размеченных кошельков нет, блок разделяет два случая: «смотрели
 * и не нашли» и «ещё не успели посмотреть». Для решения о входе это
 * разные ответы, а выглядели бы они одинаково — пустым списком.
 */

interface NotableWallet {
  address: string;
  knownAs: string | null;
  label: string;
  score: number | null;
  wins2x: number;
  tokensBought: number;
  avgPeakMultiple: number | null;
  amountUsd: string;
  side: string;
  tradedAt: string;
}

interface SignalResponse {
  signal: {
    smartCount: number;
    whaleCount: number;
    earlyCount: number;
    smartVolumeUsd: number;
    strength: number;
    verdict: string;
  };
  observedTrades: number;
  windowHours: number;
  notable: NotableWallet[];
}

const LABELS: Record<string, { text: string; cls: string; hint: string }> = {
  smart: {
    text: 'история роста',
    cls: 'text-up border-up/40 bg-up/10',
    hint: 'Покупки этого кошелька регулярно вырастали вдвое и более',
  },
  whale: {
    text: 'крупный',
    cls: 'text-accent border-accent/40 bg-accent/10',
    hint: 'Большой объём покупок. Это размер, а не подтверждённое умение',
  },
  early: {
    text: 'ранний вход',
    cls: 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10',
    hint: 'Заходит в первые часы после запуска, но результат пока не подтверждён',
  },
};

function money(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

function ago(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} мин назад`;
  if (h < 24) return `${h.toFixed(0)} ч назад`;
  return `${(h / 24).toFixed(0)} дн назад`;
}

export function WalletSignal({ chain, address }: { chain: string; address: string }) {
  const { data, error, isLoading } = useSWR<SignalResponse>(
    `/wallets/signal/${chain}/${address}`,
    fetcher,
    { refreshInterval: 120_000 },
  );

  if (isLoading) {
    return (
      <div className="panel p-4">
        <div className="text-muted text-sm">Смотрим, кто покупает…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="panel p-4">
        <div className="text-muted text-sm">Данные о кошельках сейчас недоступны</div>
      </div>
    );
  }

  const { signal, observedTrades, windowHours, notable } = data;
  const hasAny = signal.smartCount > 0 || signal.whaleCount > 0;

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Кто покупает</h2>
        <span className="text-muted text-xs">
          за {windowHours} ч · сделок в наблюдении: {observedTrades}
        </span>
      </div>

      {/* Сила сигнала: одно число, но рядом всегда сказано, из чего оно. */}
      {hasAny && (
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-muted text-xs">Сила сигнала</span>
            <span className="num text-sm font-semibold">{signal.strength}/100</span>
          </div>
          <div className="bg-border h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="from-accent to-up h-full rounded-full bg-gradient-to-r transition-all"
              style={{ width: `${signal.strength}%` }}
            />
          </div>
          <p className="text-muted mt-1.5 text-[11px] leading-snug">
            Учитывает оценку кошельков и давность покупок: вес падает вдвое каждые 12 часов.
            Покупка трёхдневной давности почти ничего не говорит о входе сегодня.
          </p>
        </div>
      )}

      <p className="text-sm">{signal.verdict}</p>

      {hasAny && (
        <div className="flex flex-wrap gap-2 text-xs">
          {signal.smartCount > 0 && (
            <span className="border-up/40 bg-up/10 text-up rounded border px-2 py-1">
              с историей: {signal.smartCount} · {money(signal.smartVolumeUsd)}
            </span>
          )}
          {signal.whaleCount > 0 && (
            <span className="border-accent/40 bg-accent/10 text-accent rounded border px-2 py-1">
              крупных: {signal.whaleCount}
            </span>
          )}
          {signal.earlyCount > 0 && (
            <span className="border-yellow-400/40 bg-yellow-400/10 text-yellow-400 rounded border px-2 py-1">
              ранних: {signal.earlyCount}
            </span>
          )}
        </div>
      )}

      {notable.length > 0 ? (
        <div className="space-y-1.5">
          {notable.map((w) => {
            const meta = LABELS[w.label] ?? LABELS.early!;
            return (
              <div
                key={`${w.address}-${w.tradedAt}`}
                className="bg-bg flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-2.5 py-2 text-xs"
              >
                <span className="num truncate">{w.knownAs ?? shortAddr(w.address)}</span>
                <span
                  title={meta.hint}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${meta.cls}`}
                >
                  {meta.text}
                </span>
                {w.score != null && <span className="text-muted num">{w.score}/100</span>}
                <span className="num ml-auto font-medium">{money(Number(w.amountUsd))}</span>
                <span className="text-muted w-full text-[11px] sm:w-auto sm:basis-full">
                  {/* Знаменатель прямо в строке: «4 из 5» и «4 из 40» —
                      совершенно разные утверждения о кошельке. */}
                  {w.tokensBought > 0 && `${w.wins2x} из ${w.tokensBought} выросли ×2 · `}
                  {ago(w.tradedAt)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-muted text-xs leading-relaxed">
          {observedTrades === 0
            ? 'Сделки по этому пулу ещё не собраны. Разметка появляется после нескольких проходов наблюдения — истории задним числом у источника нет.'
            : `Среди ${observedTrades} собранных сделок кошельков с подтверждённой историей нет. Это не значит, что токен плохой — значит, что подтверждения нет.`}
        </p>
      )}
    </div>
  );
}
