'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { api, fetcher, fmtUsd } from '@/lib/api';
import { FundingStatusPanel } from '@/components/FundingStatusPanel';

export default function AdminPage() {
  const { data: overview } = useSWR<any>('/admin/overview', fetcher, { refreshInterval: 20_000 });
  const { data: withdrawals, mutate } = useSWR<any[]>('/admin/withdrawals', fetcher);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Админ-панель</h1>
          <p className="mt-1 text-sm text-muted">Состояние платформы и очередь вывода средств.</p>
        </div>
        <Link href="/agent" className="btn-ghost text-xs">Открыть PAPER-агента</Link>
      </header>

      <section aria-label="Сводка платформы" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Metric label="Пользователей" value={overview?.users ?? '—'} />
        <Metric label="Активных подписок" value={overview?.activeCopySubscriptions ?? '—'} />
        <Metric label="Сделок 24ч" value={overview?.trades24h ?? '—'} />
        <Metric label="Объём 24ч" value={fmtUsd(overview?.volume24hUsd)} />
        <Metric label="Доход платформы" value={fmtUsd(overview?.platformRevenueUsd)} />
        <Metric label="Выплаты лидерам" value={fmtUsd(overview?.leaderPayoutsUsd)} />
      </section>

      <FundingStatusPanel />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Выводы</h2>
          <span className="text-xs text-muted">В очереди: {overview?.pendingWithdrawals ?? 0}</span>
        </div>
        <div className="panel divide-y divide-border">
          {withdrawals?.map((withdrawal) => (
            <div key={withdrawal.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="num truncate">{withdrawal.amount} → {withdrawal.toAddress}</div>
                <div className="text-xs text-muted">{withdrawal.user.email} · KYC: {withdrawal.user.kycStatus} · {withdrawal.chain}</div>
              </div>
              <button className="btn-buy text-sm" onClick={async () => {
                await api(`/admin/withdrawals/${withdrawal.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
                await mutate();
              }}>Одобрить</button>
              <button className="btn-sell text-sm" onClick={async () => {
                const reason = window.prompt('Причина отказа?') ?? 'без указания причины';
                await api(`/admin/withdrawals/${withdrawal.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: false, reason }) });
                await mutate();
              }}>Отклонить</button>
            </div>
          ))}
          {!withdrawals?.length && <p className="p-8 text-center text-sm text-muted">Очередь пуста</p>}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="panel p-3"><div className="text-xs text-muted">{label}</div><div className="num mt-1 text-lg">{value}</div></div>;
}
