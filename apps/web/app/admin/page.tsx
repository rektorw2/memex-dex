'use client';

import useSWR from 'swr';
import { useState } from 'react';
import Link from 'next/link';
import { fetcher, api, fmtUsd, errorMessage } from '@/lib/api';
import { CallManager } from '@/components/CallManager';
import { QuickBuy } from '@/components/QuickBuy';

export default function AdminPage() {
  const { data: overview } = useSWR<any>('/admin/overview', fetcher, { refreshInterval: 20_000 });
  const { data: withdrawals, mutate: mutateW } = useSWR<any[]>('/admin/withdrawals', fetcher);
  const [tab, setTab] = useState<'buy' | 'calls' | 'tokens' | 'withdrawals'>('buy');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-bold">Админ-панель</h1>
        {/* Автопубликация вынесена отдельной страницей, а не вкладкой:
            это единственный раздел, где настройка начинает действовать
            без дальнейшего участия человека. */}
        <Link href="/admin/auto" className="btn-ghost text-xs">
          Автопубликация коллов
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Metric label="Пользователей" value={overview?.users ?? '—'} />
        <Metric label="Активных подписок" value={overview?.activeCopySubscriptions ?? '—'} />
        <Metric label="Сделок 24ч" value={overview?.trades24h ?? '—'} />
        <Metric label="Объём 24ч" value={fmtUsd(overview?.volume24hUsd)} />
        <Metric label="Доход платформы" value={fmtUsd(overview?.platformRevenueUsd)} />
        <Metric label="Выплаты лидерам" value={fmtUsd(overview?.leaderPayoutsUsd)} />
      </div>

      <div className="flex gap-1 border-b border-border scroll-x">
        {([['buy', 'Покупка'], ['calls', 'Коллы'], ['tokens', 'Токены'], ['withdrawals', `Выводы (${overview?.pendingWithdrawals ?? 0})`]] as const).map(
          ([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 sm:px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {tab === 'buy' && <QuickBuy />}
      {tab === 'calls' && <CallManager />}
      {tab === 'tokens' && <TokenLister />}
      {tab === 'withdrawals' && (
        <div className="panel divide-y divide-border">
          {withdrawals?.map((w) => (
            <div key={w.id} className="p-4 flex flex-wrap items-center gap-3">
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

function TokenLister() {
  const { data: tokens, mutate } = useSWR<any[]>('/tokens?limit=200', fetcher);
  const [chain, setChain] = useState('SOLANA');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [found, setFound] = useState<any>(null);

  async function lookup() {
    setBusy(true);
    setMsg(null);
    setFound(null);
    try {
      // Тикер, decimals, цену и пул подтягиваем по адресу: ручной ввод
      // decimals — прямой путь к сделке в 10^12 раз больше задуманной.
      const r: any = await api('/admin/tokens/lookup', {
        method: 'POST',
        body: JSON.stringify({ chain, address: address.trim(), verify: true }),
      });
      setFound(r);
      setMsg(`${r.token.symbol} добавлен в витрину`);
      setAddress('');
      mutate();
    } catch (e) {
      setMsg(errorMessage(e, 'Не удалось найти токен'));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setMsg(null);
    try {
      const r: any = await api('/admin/tokens/import', { method: 'POST' });
      const total = (r.stats ?? []).reduce((s: number, x: any) => s + x.created, 0);
      setMsg(`Импорт завершён, добавлено токенов: ${total}`);
      mutate();
    } catch (e) {
      setMsg(errorMessage(e, 'Импорт не удался'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisibility(id: string, hidden: boolean) {
    await api(`/admin/tokens/${id}/visibility`, {
      method: 'POST',
      body: JSON.stringify({ hidden }),
    });
    mutate();
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="space-y-4">
        <div className="panel p-4 space-y-3">
          <h2 className="font-medium">Добавить токен по адресу</h2>
          <div className="grid grid-cols-3 gap-2">
            <select className="input" value={chain} onChange={(e) => setChain(e.target.value)}>
              <option value="SOLANA">Solana</option>
              <option value="BNB">BNB Chain</option>
              <option value="BASE">Base</option>
              <option value="ETHEREUM">Ethereum</option>
              <option value="ROBINHOOD">Robinhood Chain</option>
            </select>
            <input
              className="input col-span-2 font-mono text-xs"
              placeholder="Адрес контракта или mint"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <button
            onClick={lookup}
            disabled={busy || address.trim().length < 20}
            className="btn bg-accent hover:bg-accent/80 text-white w-full"
          >
            {busy ? '...' : 'Найти и добавить'}
          </button>
          <p className="text-xs text-muted">
            Тикер, decimals, цена, ликвидность и пул для графика определяются
            автоматически по самому ликвидному рынку токена.
          </p>
        </div>

        <div className="panel p-4 space-y-3">
          <h2 className="font-medium">Импорт трендов</h2>
          <p className="text-xs text-muted">
            Загружает топ пулов по объёму во всех поддерживаемых сетях.
            Выполняется автоматически раз в час — кнопка запускает вне очереди.
          </p>
          <button onClick={runImport} disabled={busy} className="btn-ghost w-full">
            {busy ? 'Импортируем...' : 'Импортировать сейчас'}
          </button>
        </div>

        {msg && <p className="text-xs text-muted panel p-3">{msg}</p>}

        {found && (
          <div className="panel p-4 space-y-2 text-sm">
            <h3 className="font-medium">{found.token.symbol} добавлен</h3>
            <Row label="Цена" value={found.token.priceUsd ?? '—'} />
            <Row label="Ликвидность" value={fmtUsd(found.token.liquidityUsd)} />
            <Row label="Риск-скор" value={`${found.risk.score}/100`} />
            {found.risk.flags?.length > 0 && (
              <ul className="text-xs text-muted space-y-1 pt-1">
                {found.risk.flags.map((f: string, i: number) => (
                  <li key={i}>• {f}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="panel p-4">
        <h2 className="font-medium mb-3">
          В витрине: {tokens?.length ?? 0}
        </h2>
        <div className="max-h-[600px] overflow-y-auto scroll-x">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted sticky top-0 bg-panel">
              <tr>
                <th className="text-left font-normal pb-2">Токен</th>
                <th className="text-right font-normal pb-2">Ликвидность</th>
                <th className="text-right font-normal pb-2">Риск</th>
                <th className="text-right font-normal pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {tokens?.map((t) => (
                <tr key={t.id} className="border-b border-border/40">
                  <td className="py-1.5">
                    <div className="flex items-center gap-1.5">
                      {t.symbol}
                      {t.source === 'auto' && (
                        <span className="text-[10px] text-muted" title="Добавлен импортёром">
                          авто
                        </span>
                      )}
                      {!t.hasChart && (
                        <span className="text-[10px] text-down" title="Нет пула — график недоступен">
                          без графика
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted">{t.chain}</div>
                  </td>
                  <td className="text-right num text-xs">{fmtUsd(t.liquidityUsd)}</td>
                  <td className={`text-right num text-xs ${(t.riskScore ?? 0) > 60 ? 'text-down' : 'text-muted'}`}>
                    {t.riskScore ?? '—'}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => toggleVisibility(t.id, true)}
                      className="text-xs text-muted hover:text-down px-2"
                      title="Скрыть из витрины"
                    >
                      скрыть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
