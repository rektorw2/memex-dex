'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { fetcher, api, fmtUsd, ApiError } from '@/lib/api';

export default function AdminPage() {
  const { data: overview } = useSWR<any>('/admin/overview', fetcher, { refreshInterval: 20_000 });
  const { data: withdrawals, mutate: mutateW } = useSWR<any[]>('/admin/withdrawals', fetcher);
  const [tab, setTab] = useState<'calls' | 'tokens' | 'withdrawals'>('calls');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Админ-панель</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Metric label="Пользователей" value={overview?.users ?? '—'} />
        <Metric label="Активных подписок" value={overview?.activeCopySubscriptions ?? '—'} />
        <Metric label="Сделок 24ч" value={overview?.trades24h ?? '—'} />
        <Metric label="Объём 24ч" value={fmtUsd(overview?.volume24hUsd)} />
        <Metric label="Доход платформы" value={fmtUsd(overview?.platformRevenueUsd)} />
        <Metric label="Выплаты лидерам" value={fmtUsd(overview?.leaderPayoutsUsd)} />
      </div>

      <div className="flex gap-1 border-b border-border">
        {([['calls', 'Коллы'], ['tokens', 'Токены'], ['withdrawals', `Выводы (${overview?.pendingWithdrawals ?? 0})`]] as const).map(
          ([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px ${
                tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {tab === 'calls' && <CallComposer />}
      {tab === 'tokens' && <TokenLister />}
      {tab === 'withdrawals' && (
        <div className="panel divide-y divide-border">
          {withdrawals?.map((w) => (
            <div key={w.id} className="p-4 flex items-center gap-4">
              <div className="flex-1">
                <div className="num">{w.amount} → {w.toAddress.slice(0, 16)}…</div>
                <div className="text-xs text-muted">
                  {w.user.email} · KYC: {w.user.kycStatus} · {w.chain}
                </div>
              </div>
              <button
                onClick={async () => {
                  await api(`/admin/withdrawals/${w.id}/decide`, {
                    method: 'POST', body: JSON.stringify({ approve: true }),
                  });
                  mutateW();
                }}
                className="btn-buy text-sm"
              >
                Одобрить
              </button>
              <button
                onClick={async () => {
                  const reason = prompt('Причина отказа?') ?? 'без указания причины';
                  await api(`/admin/withdrawals/${w.id}/decide`, {
                    method: 'POST', body: JSON.stringify({ approve: false, reason }),
                  });
                  mutateW();
                }}
                className="btn-sell text-sm"
              >
                Отклонить
              </button>
            </div>
          ))}
          {!withdrawals?.length && (
            <p className="p-8 text-center text-muted text-sm">Очередь пуста</p>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg num mt-0.5">{value}</div>
    </div>
  );
}

/** Форма публикации колла. */
function CallComposer() {
  const { data: tokens } = useSWR<any[]>('/tokens', fetcher);
  const [form, setForm] = useState({
    tokenId: '', title: '', thesis: '', risk: 'HIGH',
    entryPriceUsd: '', stopLossUsd: '', suggestedPct: 3, timeHorizon: '',
    isCopyEnabled: false,
  });
  const [targets, setTargets] = useState([{ priceUsd: '', pct: 50 }]);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const token = tokens?.find((t) => t.id === form.tokenId);

  async function create() {
    setError(null);
    try {
      const r = await api('/admin/calls', {
        method: 'POST',
        body: JSON.stringify({ ...form, targets, entryPriceUsd: form.entryPriceUsd || token?.priceUsd }),
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ''}` : 'Ошибка');
    }
  }

  async function publish(id: string) {
    await api(`/admin/calls/${id}/publish`, { method: 'POST' });
    setResult(null);
    setForm({ ...form, title: '', thesis: '' });
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="panel p-4 space-y-3">
        <h2 className="font-medium">Новый колл</h2>

        <div>
          <label className="label">Токен</label>
          <select
            className="input"
            value={form.tokenId}
            onChange={(e) => setForm({ ...form, tokenId: e.target.value })}
          >
            <option value="">— выберите —</option>
            {tokens?.map((t) => (
              <option key={t.id} value={t.id}>{t.symbol} · {t.chain}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Заголовок</label>
          <input className="input" value={form.title}
                 onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>

        <div>
          <label className="label">
            Тезис — почему у проекта есть потенциал (минимум 20 символов)
          </label>
          <textarea
            className="input min-h-[120px] font-sans"
            value={form.thesis}
            onChange={(e) => setForm({ ...form, thesis: e.target.value })}
            placeholder="Нарратив, команда, ликвидность, катализаторы, риски…"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Уровень риска</label>
            <select className="input" value={form.risk}
                    onChange={(e) => setForm({ ...form, risk: e.target.value })}>
              <option value="LOW">Низкий</option>
              <option value="MEDIUM">Средний</option>
              <option value="HIGH">Высокий</option>
              <option value="DEGEN">Дегенский</option>
            </select>
          </div>
          <div>
            <label className="label">Доля портфеля, %</label>
            <input className="input" type="number" step="0.5" value={form.suggestedPct}
                   onChange={(e) => setForm({ ...form, suggestedPct: Number(e.target.value) })} />
          </div>
        </div>

        <div>
          <label className="label">Цели (цена / доля продажи %)</label>
          {targets.map((t, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input
                className="input" placeholder="Цена USD" value={t.priceUsd}
                onChange={(e) => setTargets(targets.map((x, j) => j === i ? { ...x, priceUsd: e.target.value } : x))}
              />
              <input
                className="input w-24" type="number" value={t.pct}
                onChange={(e) => setTargets(targets.map((x, j) => j === i ? { ...x, pct: Number(e.target.value) } : x))}
              />
              {targets.length > 1 && (
                <button onClick={() => setTargets(targets.filter((_, j) => j !== i))} className="btn-ghost px-3">×</button>
              )}
            </div>
          ))}
          {targets.length < 5 && (
            <button onClick={() => setTargets([...targets, { priceUsd: '', pct: 25 }])}
                    className="text-xs text-accent">
              + добавить цель
            </button>
          )}
        </div>

        <div>
          <label className="label">Стоп-лосс, USD</label>
          <input className="input" value={form.stopLossUsd}
                 onChange={(e) => setForm({ ...form, stopLossUsd: e.target.value })} />
        </div>

        <label className="flex gap-2 items-center text-sm">
          <input type="checkbox" checked={form.isCopyEnabled} className="accent-accent"
                 onChange={(e) => setForm({ ...form, isCopyEnabled: e.target.checked })} />
          Раздать подписчикам копитрейдинга
        </label>

        {error && <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>}

        <button onClick={create} disabled={!form.tokenId || form.thesis.length < 20}
                className="btn bg-accent hover:bg-accent/80 text-white w-full">
          Создать черновик
        </button>
      </div>

      <div className="space-y-4">
        {result && (
          <div className="panel p-4 space-y-3">
            <h3 className="font-medium">Проверка безопасности токена</h3>
            <div className="flex items-center gap-3">
              <div className={`text-3xl num ${result.risk.score > 60 ? 'text-down' : result.risk.score > 30 ? 'text-yellow-400' : 'text-up'}`}>
                {result.risk.score}
              </div>
              <div className="text-xs text-muted">риск-скор из 100</div>
            </div>
            {result.risk.flags.length > 0 && (
              <ul className="text-xs text-muted space-y-1">
                {result.risk.flags.map((f: string, i: number) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-down">•</span>{f}
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => publish(result.call.id)} className="btn-buy w-full">
              Опубликовать колл
            </button>
            <p className="text-xs text-muted">
              Цена входа будет зафиксирована по рынку в момент публикации.
            </p>
          </div>
        )}

        {token && (
          <div className="panel p-4 text-sm space-y-2">
            <h3 className="font-medium">{token.symbol}</h3>
            <Row label="Цена" value={token.priceUsd ?? '—'} />
            <Row label="Ликвидность" value={fmtUsd(token.liquidityUsd)} />
            <Row label="Объём 24ч" value={fmtUsd(token.volume24hUsd)} />
            <Row label="Держателей" value={token.holders ?? '—'} />
            <Row label="Адрес" value={`${token.address.slice(0, 20)}…`} />
          </div>
        )}
      </div>
    </div>
  );
}

function TokenLister() {
  const [form, setForm] = useState({
    chain: 'SOLANA', address: '', symbol: '', name: '', decimals: 9, isQuote: false,
  });
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="panel p-4 space-y-3 max-w-lg">
      <h2 className="font-medium">Добавить токен в листинг</h2>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Сеть</label>
          <select className="input" value={form.chain}
                  onChange={(e) => setForm({ ...form, chain: e.target.value, decimals: e.target.value === 'SOLANA' ? 9 : 18 })}>
            <option value="SOLANA">Solana</option>
            <option value="BNB">BNB Chain</option>
            <option value="ROBINHOOD">Robinhood Chain</option>
            <option value="ETHEREUM">Ethereum</option>
            <option value="BASE">Base</option>
          </select>
        </div>
        <div>
          <label className="label">Decimals</label>
          <input className="input" type="number" value={form.decimals}
                 onChange={(e) => setForm({ ...form, decimals: Number(e.target.value) })} />
        </div>
      </div>
      <div>
        <label className="label">Адрес контракта / mint</label>
        <input className="input" value={form.address}
               onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Тикер</label>
          <input className="input" value={form.symbol}
                 onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
        </div>
        <div>
          <label className="label">Название</label>
          <input className="input" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
      </div>
      <label className="flex gap-2 items-center text-sm">
        <input type="checkbox" checked={form.isQuote} className="accent-accent"
               onChange={(e) => setForm({ ...form, isQuote: e.target.checked })} />
        Валюта котировки (USDC, SOL, BNB)
      </label>
      {msg && <p className="text-xs text-muted">{msg}</p>}
      <button
        onClick={async () => {
          try {
            const t: any = await api('/admin/tokens', { method: 'POST', body: JSON.stringify(form) });
            setMsg(`Добавлен ${t.symbol}, цена ${t.priceUsd ?? 'не определена'}`);
          } catch (e) {
            setMsg(e instanceof ApiError ? e.message : 'Ошибка');
          }
        }}
        className="btn bg-accent hover:bg-accent/80 text-white w-full"
      >
        Добавить
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
