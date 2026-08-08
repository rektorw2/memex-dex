'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { fetcher, api, fmtUsd, fmtPct, errorMessage } from '@/lib/api';

interface Leader {
  id: string; followers: number; trades30d: number; winRate: number;
  pnl30dUsd: string; volume30dUsd: string; maxDrawdownUsd: string;
  performanceFeePct: number; activeSince: string;
}

export default function CopyPage() {
  const { data: leaders } = useSWR<Leader[]>('/copy/leaders', fetcher);
  const { data: subs, mutate } = useSWR<any>('/copy/subscriptions', fetcher);
  const { data: fees } = useSWR<any>('/copy/fees', fetcher);
  const [openLeader, setOpenLeader] = useState<Leader | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Копитрейдинг</h1>
        <p className="text-sm text-muted mt-1">
          Ваши сделки повторяют сделки выбранного трейдера автоматически.
          Комиссия — 10% от прибыли, только при выходе из прибыльной позиции.
        </p>
      </div>

      {/* Условия — на видном месте, а не в сноске */}
      <section className="panel p-4 border-accent/30">
        <h2 className="font-medium mb-3">Как считается комиссия</h2>
        <div className="grid md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-up font-medium mb-1">Прибыльная сделка</div>
            <p className="text-muted leading-relaxed">
              Купили на $1000, продали за $3000. Прибыль $2000, комиссия $200,
              вам остаётся $2800.
            </p>
          </div>
          <div>
            <div className="text-down font-medium mb-1">Убыточная сделка</div>
            <p className="text-muted leading-relaxed">
              Купили на $1000, продали за $600. Комиссия не удерживается —
              с убытка платформа не берёт ничего.
            </p>
          </div>
          <div>
            <div className="font-medium mb-1">Ваши собственные сделки</div>
            <p className="text-muted leading-relaxed">
              Комиссия берётся только с объёма, набранного копированием.
              Позиции, купленные вручную, не облагаются.
            </p>
          </div>
        </div>
      </section>

      {/* Активные подписки */}
      {subs?.subscriptions?.length > 0 && (
        <section>
          <h2 className="font-medium mb-3">Мои подписки</h2>
          <div className="panel divide-y divide-border">
            {subs.subscriptions.map((s: any) => (
              <div key={s.id} className="p-4 flex flex-wrap items-center gap-3">
                <div className="flex-1">
                  <div className="font-mono text-sm">{s.leaderId.slice(0, 12)}…</div>
                  <div className="text-xs text-muted">
                    {s.sizing === 'PCT_EQUITY' ? `${s.pctEquity}% капитала на сделку` : `$${s.fixedUsd} на сделку`}
                    {' · '}макс. {s.maxOpenPositions} позиций
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div className={Number(s.grossPnlUsd) >= 0 ? 'text-up num' : 'text-down num'}>
                    {fmtUsd(s.grossPnlUsd)}
                  </div>
                  <div className="text-xs text-muted num">комиссий: {fmtUsd(s.feesPaidUsd)}</div>
                </div>
                <button
                  onClick={async () => {
                    await api(`/copy/subscriptions/${s.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }),
                    });
                    mutate();
                  }}
                  className="btn-ghost text-xs"
                >
                  {s.status === 'ACTIVE' ? 'Пауза' : 'Возобновить'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Витрина лидеров */}
      <section>
        <h2 className="font-medium mb-3">Трейдеры</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {leaders?.map((l) => (
            <div key={l.id} className="panel p-4 space-y-3">
              <div className="flex justify-between items-start">
                <div className="font-mono text-sm">{l.id.slice(0, 12)}…</div>
                <span className="text-xs text-muted">{l.followers} подписчиков</span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <Stat label="PnL за 30 дней" value={fmtUsd(l.pnl30dUsd)} positive={Number(l.pnl30dUsd) >= 0} />
                <Stat label="Винрейт" value={`${l.winRate}%`} />
                <Stat label="Сделок" value={String(l.trades30d)} />
                <Stat label="Макс. просадка" value={fmtUsd(l.maxDrawdownUsd)} negative />
              </div>

              <button onClick={() => setOpenLeader(l)} className="btn-ghost w-full text-sm">
                Подписаться
              </button>
            </div>
          ))}
          {!leaders?.length && (
            <p className="text-muted text-sm col-span-full py-12 text-center">
              Пока нет доступных трейдеров
            </p>
          )}
        </div>
      </section>

      {/* История комиссий */}
      {fees?.entries?.length > 0 && (
        <section>
          <h2 className="font-medium mb-3">
            Удержанные комиссии — {fmtUsd(fees.totalPaidUsd)}
          </h2>
          <div className="panel scroll-x">
            <table className="w-full text-sm min-w-[420px]">
              <thead className="text-xs text-muted border-b border-border">
                <tr>
                  <th className="text-left p-3 font-normal">Дата</th>
                  <th className="text-right p-3 font-normal">Прибыль</th>
                  <th className="text-right p-3 font-normal">Ставка</th>
                  <th className="text-right p-3 font-normal">Комиссия</th>
                </tr>
              </thead>
              <tbody>
                {fees.entries.map((f: any) => (
                  <tr key={f.id} className="border-b border-border/50">
                    <td className="p-3 text-muted text-xs">
                      {new Date(f.date).toLocaleDateString('ru')}
                    </td>
                    <td className="p-3 text-right num text-up">{fmtUsd(f.profitUsd)}</td>
                    <td className="p-3 text-right num text-muted">{f.feePct}%</td>
                    <td className="p-3 text-right num">{fmtUsd(f.feeUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openLeader && (
        <SubscribeModal leader={openLeader} onClose={() => { setOpenLeader(null); mutate(); }} />
      )}
    </div>
  );
}

function Stat({ label, value, positive, negative }: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`num ${positive ? 'text-up' : negative ? 'text-down' : ''}`}>{value}</div>
    </div>
  );
}

function SubscribeModal({ leader, onClose }: { leader: Leader; onClose: () => void }) {
  const [pct, setPct] = useState(5);
  const [maxPositions, setMaxPositions] = useState(10);
  const [chains, setChains] = useState<string[]>(['SOLANA', 'BNB']);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      await api('/copy/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          leaderId: leader.id,
          sizing: 'PCT_EQUITY',
          pctEquity: pct,
          maxOpenPositions: maxPositions,
          allowedChains: chains,
          acceptPerformanceFee: true,
        }),
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось подписаться'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="panel p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold">Подписка на трейдера</h3>

        <div>
          <label className="label">Доля капитала на одну сделку: {pct}%</label>
          <input
            type="range" min={0.5} max={25} step={0.5}
            value={pct} onChange={(e) => setPct(Number(e.target.value))}
            className="w-full accent-accent"
          />
          {pct > 15 && (
            <p className="text-xs text-down mt-1">
              При {pct}% на сделку семь неудачных входов подряд заберут больше половины капитала
            </p>
          )}
        </div>

        <div>
          <label className="label">Максимум открытых позиций: {maxPositions}</label>
          <input
            type="range" min={1} max={30}
            value={maxPositions} onChange={(e) => setMaxPositions(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </div>

        <div>
          <label className="label">Сети для копирования</label>
          <div className="flex gap-2 flex-wrap">
            {['SOLANA', 'BNB', 'ROBINHOOD'].map((c) => (
              <button
                key={c}
                onClick={() => setChains((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c])}
                className={`text-xs px-2 py-1 rounded border ${
                  chains.includes(c) ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <label className="flex gap-2 items-start text-xs text-muted cursor-pointer bg-bg p-3 rounded-md">
          <input
            type="checkbox" checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Я понимаю, что при закрытии прибыльной копируемой позиции с меня будет
            удержано {leader.performanceFeePct}% от прибыли. Убыточные сделки комиссией
            не облагаются. Я осознаю риск полной потери вложенных средств.
          </span>
        </label>

        {error && <p className="text-xs text-down">{error}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="btn-ghost">Отмена</button>
          <button
            onClick={subscribe}
            disabled={!accepted || !chains.length || busy}
            className="btn bg-accent hover:bg-accent/80 text-white"
          >
            {busy ? '...' : 'Подписаться'}
          </button>
        </div>
      </div>
    </div>
  );
}
