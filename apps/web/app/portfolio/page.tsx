'use client';

import useSWR from 'swr';
import { fetcher, fmtUsd, fmtPrice, fmtPct } from '@/lib/api';

export default function PortfolioPage() {
  const { data: p } = useSWR<any>('/portfolio', fetcher, { refreshInterval: 10_000 });
  const { data: history } = useSWR<any[]>('/portfolio/history', fetcher);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Портфель</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Стоимость портфеля" value={fmtUsd(p?.totalValueUsd)} />
        <Card label="Свободные средства" value={fmtUsd(p?.cashUsd)} />
        <Card
          label="Нереализованный PnL"
          value={fmtUsd(p?.unrealizedPnlUsd)}
          tone={Number(p?.unrealizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}
        />
        <Card label="Комиссий уплачено" value={fmtUsd(p?.totalFeesPaidUsd)} />
      </div>

      <section>
        <h2 className="font-medium mb-3">Позиции</h2>
        <div className="panel overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted border-b border-border">
              <tr>
                <th className="text-left p-3 font-normal">Токен</th>
                <th className="text-right p-3 font-normal">Количество</th>
                <th className="text-right p-3 font-normal">Ср. цена входа</th>
                <th className="text-right p-3 font-normal">Текущая</th>
                <th className="text-right p-3 font-normal">Стоимость</th>
                <th className="text-right p-3 font-normal">PnL</th>
                <th className="text-right p-3 font-normal" title="Доля позиции, с которой при продаже будет удержана комиссия">
                  Копитрейд
                </th>
              </tr>
            </thead>
            <tbody>
              {p?.holdings?.map((h: any) => (
                <tr key={h.tokenId} className="border-b border-border/50">
                  <td className="p-3">
                    <div className="font-medium">{h.symbol}</div>
                    <div className="text-xs text-muted">{h.chain}</div>
                  </td>
                  <td className="p-3 text-right num text-xs">{Number(h.quantity).toLocaleString('ru')}</td>
                  <td className="p-3 text-right num text-xs">{fmtPrice(h.avgCostUsd)}</td>
                  <td className="p-3 text-right num text-xs">{fmtPrice(h.currentPriceUsd)}</td>
                  <td className="p-3 text-right num">{fmtUsd(h.valueUsd)}</td>
                  <td className={`p-3 text-right num ${Number(h.unrealizedPnlUsd) >= 0 ? 'text-up' : 'text-down'}`}>
                    {fmtUsd(h.unrealizedPnlUsd)}
                    <div className="text-xs opacity-70">{fmtPct(h.unrealizedPnlPct)}</div>
                  </td>
                  <td className="p-3 text-right num text-xs text-muted">{h.copiedSharePct}%</td>
                </tr>
              ))}
              {!p?.holdings?.length && (
                <tr><td colSpan={7} className="text-center text-muted py-8 text-sm">Нет открытых позиций</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-3">История сделок</h2>
        <div className="panel overflow-auto max-h-[500px]">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted border-b border-border sticky top-0 bg-panel">
              <tr>
                <th className="text-left p-3 font-normal">Дата</th>
                <th className="text-left p-3 font-normal">Токен</th>
                <th className="text-left p-3 font-normal">Тип</th>
                <th className="text-right p-3 font-normal">Объём</th>
                <th className="text-right p-3 font-normal">Цена</th>
                <th className="text-right p-3 font-normal">PnL</th>
                <th className="text-right p-3 font-normal">Комиссия</th>
              </tr>
            </thead>
            <tbody>
              {history?.map((t) => (
                <tr key={t.id} className="border-b border-border/50">
                  <td className="p-3 text-xs text-muted">
                    {new Date(t.date).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="p-3">{t.symbol}</td>
                  <td className="p-3">
                    <span className={t.side === 'BUY' ? 'text-up' : 'text-down'}>
                      {t.side === 'BUY' ? 'покупка' : 'продажа'}
                    </span>
                    {t.source === 'COPY_TRADE' && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-accent/15 text-accent">копия</span>
                    )}
                    {t.source === 'CALL' && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-border text-muted">по коллу</span>
                    )}
                  </td>
                  <td className="p-3 text-right num text-xs">{fmtUsd(t.valueUsd)}</td>
                  <td className="p-3 text-right num text-xs">{fmtPrice(t.priceUsd)}</td>
                  <td className={`p-3 text-right num text-xs ${Number(t.realizedPnlUsd) >= 0 ? 'text-up' : 'text-down'}`}>
                    {Number(t.realizedPnlUsd) === 0 ? '—' : fmtUsd(t.realizedPnlUsd)}
                  </td>
                  <td className="p-3 text-right num text-xs text-muted">
                    {Number(t.performanceFeeUsd) === 0 ? '—' : fmtUsd(t.performanceFeeUsd)}
                  </td>
                </tr>
              ))}
              {!history?.length && (
                <tr><td colSpan={7} className="text-center text-muted py-8 text-sm">Сделок пока нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="panel p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-xl num mt-1 ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </div>
    </div>
  );
}
