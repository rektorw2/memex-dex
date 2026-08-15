'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher, api, errorMessage } from '@/lib/api';
import { CHAINS, chainLabel } from '@/lib/chains';

/**
 * Рейтинг кошельков.
 *
 * Список сознательно начинается с состояния набора данных, а не с самих
 * кошельков. Причина в природе этих данных: метки строятся из наблюдений,
 * которые накапливаются со временем, и пустой список в первые дни —
 * нормальное состояние, а не поломка. Без явной строки «известно N,
 * оценено M» пользователь читает пустоту как ошибку и уходит.
 */

interface Wallet {
  id: string;
  chain: string;
  address: string;
  knownAs: string | null;
  label: string;
  score: number | null;
  tokensBought: number;
  wins2x: number;
  wins5x: number;
  rugs: number;
  volumeUsd: string;
  avgPeakMultiple: number | null;
  medianEntryHours: number | null;
  hitRate: number | null;
  sampleSize: number;
  lastActiveAt: string;
}

interface Response {
  coverage: { walletsKnown: number; walletsScored: number; minTradesForScore: number };
  wallets: Wallet[];
}

const TABS = [
  { key: 'smart', label: 'С историей роста', hint: 'Оценка выставлена: покупки регулярно росли' },
  { key: 'whale', label: 'Киты', hint: 'Крупный объём. Размер, а не подтверждённое умение' },
  { key: 'early', label: 'Ранние', hint: 'Заходят в первые часы после запуска пула' },
  { key: 'any', label: 'Все', hint: 'Включая кошельки без оценки' },
] as const;

function money(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a;
}

export default function WalletsPage() {
  const [tab, setTab] = useState<string>('smart');
  const [chain, setChain] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = typeof window !== 'undefined' && localStorage.getItem('role') === 'ADMIN';

  const qs = new URLSearchParams({ label: tab, ...(chain ? { chain } : {}) });
  const { data, error, isLoading, mutate } = useSWR<Response>(
    `/wallets/top?${qs}`,
    fetcher,
    { refreshInterval: 60_000 },
  );

  async function scan() {
    setBusy(true);
    setNotice(null);
    try {
      const r: any = await api('/wallets/scan', { method: 'POST' });
      setNotice(
        `Опрошено пулов: ${r.pools}, новых сделок: ${r.trades}, ` +
          `подведено исходов: ${r.settled}, пересчитано кошельков: ${r.rescored}`,
      );
      mutate();
    } catch (e) {
      setNotice(errorMessage(e, 'Проход не выполнен'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Кошельки</h1>
          <p className="text-muted mt-1 max-w-2xl text-xs leading-relaxed">
            Метки посчитаны по нашим наблюдениям: система собирает сделки по отслеживаемым
            пулам и через сутки после каждой покупки смотрит, что стало с токеном. Оценка
            выставляется не раньше, чем накопится {data?.coverage.minTradesForScore ?? 5} сделок
            с известным исходом — на меньшей выборке «100% попаданий» означает только удачу.
          </p>
        </div>

        {isAdmin && (
          <button onClick={scan} disabled={busy} className="btn-ghost shrink-0 text-xs">
            {busy ? 'Идёт проход…' : 'Собрать сейчас'}
          </button>
        )}
      </div>

      {notice && (
        <p className="border-border bg-panel text-muted rounded border p-2 text-xs">{notice}</p>
      )}

      {/* Состояние набора данных — до списка, а не после. */}
      {data && (
        <div className="panel flex flex-wrap gap-x-6 gap-y-2 p-3 text-xs">
          <span className="text-muted">
            Кошельков в наблюдении: <span className="num text-white">{data.coverage.walletsKnown}</span>
          </span>
          <span className="text-muted">
            С выставленной оценкой:{' '}
            <span className="num text-white">{data.coverage.walletsScored}</span>
          </span>
          {data.coverage.walletsKnown === 0 && (
            <span className="text-muted">
              Наблюдение только началось. История сделок задним числом недоступна, поэтому
              база наполняется по мере работы радара.
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            title={t.hint}
            onClick={() => setTab(t.key)}
            className={`rounded-md border px-3 py-1.5 text-xs transition ${
              tab === t.key
                ? 'border-accent bg-accent/15 text-white'
                : 'border-border text-muted hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}

        <select
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          className="input ml-auto w-auto text-xs"
        >
          <option value="">Все сети</option>
          {Object.keys(CHAINS).map((c) => (
            <option key={c} value={c}>
              {chainLabel(c)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-down border-down/30 bg-down/10 rounded border p-3 text-sm">
          {errorMessage(error, 'Не удалось загрузить рейтинг')}
        </p>
      )}

      {isLoading && <p className="text-muted py-8 text-center text-sm">Загрузка…</p>}

      {data && data.wallets.length === 0 && !isLoading && (
        <div className="panel p-6 text-center">
          <p className="text-muted text-sm">
            {data.coverage.walletsKnown === 0
              ? 'Сделки ещё не собраны. Первые кошельки появятся после нескольких проходов радара.'
              : `Кошельков в этой категории пока нет. Всего в наблюдении ${data.coverage.walletsKnown}, оценка выставлена ${data.coverage.walletsScored}.`}
          </p>
        </div>
      )}

      {data && data.wallets.length > 0 && (
        <div className="space-y-2">
          {data.wallets.map((w) => (
            <WalletRow key={w.id} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function WalletRow({ w }: { w: Wallet }) {
  return (
    <div className="panel p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="num text-sm">{w.knownAs ?? shortAddr(w.address)}</span>
        <span className="text-muted text-[11px]">{chainLabel(w.chain)}</span>

        {w.score != null ? (
          <span className="border-up/40 bg-up/10 text-up rounded border px-2 py-0.5 text-xs">
            {w.score}/100
          </span>
        ) : (
          <span
            title="Сделок с известным исходом пока недостаточно для оценки"
            className="border-border text-muted rounded border px-2 py-0.5 text-xs"
          >
            оценки нет
          </span>
        )}

        <span className="num text-muted ml-auto text-xs">{money(Number(w.volumeUsd))}</span>
      </div>

      <div className="text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {/* Доля попаданий никогда не показывается без размера выборки. */}
        <span>
          выросли ×2: <span className="num text-white">{w.wins2x}</span> из{' '}
          <span className="num">{w.tokensBought}</span>
        </span>
        {w.wins5x > 0 && (
          <span>
            ×5 и выше: <span className="num text-white">{w.wins5x}</span>
          </span>
        )}
        {w.rugs > 0 && (
          <span>
            обнулилось: <span className="num text-down">{w.rugs}</span>
          </span>
        )}
        {w.avgPeakMultiple != null && (
          <span>
            средний пик: <span className="num text-white">{w.avgPeakMultiple.toFixed(1)}×</span>
          </span>
        )}
        {w.medianEntryHours != null && (
          <span>
            обычный вход:{' '}
            <span className="num text-white">{w.medianEntryHours.toFixed(1)} ч</span> от запуска
          </span>
        )}
      </div>
    </div>
  );
}
