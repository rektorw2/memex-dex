'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { fetcher, fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
import { PriceChart } from '@/components/PriceChart';
import { TradePanel } from '@/components/TradePanel';

interface Token {
  id: string; symbol: string; name: string; chain: string; address: string;
  priceUsd: string | null; priceChange24h: string | null;
  liquidityUsd: string | null; volume24hUsd: string | null; fdvUsd: string | null;
  riskScore: number | null; logoUrl: string | null;
  isVerified: boolean; hasChart: boolean; isQuote: boolean;
}

const CHAIN_LABEL: Record<string, string> = {
  SOLANA: 'Solana', BNB: 'BNB Chain', ROBINHOOD: 'Robinhood Chain',
  ETHEREUM: 'Ethereum', BASE: 'Base',
};

const SORTS = [
  ['volume', 'По объёму'],
  ['gainers', 'Растущие'],
  ['losers', 'Падающие'],
  ['liquidity', 'По ликвидности'],
  ['new', 'Новые'],
] as const;

const INTERVALS = ['5m', '1h', '1d'] as const;

export default function TerminalPage() {
  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<string>('volume');
  const [search, setSearch] = useState('');
  const [interval, setInterval] = useState<string>('5m');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const params = new URLSearchParams({ sort, limit: '60' });
  if (chain) params.set('chain', chain);
  if (search) params.set('search', search);

  const { data: tokens } = useSWR<Token[]>(`/tokens?${params}`, fetcher, {
    refreshInterval: 20_000,
    keepPreviousData: true,
  });

  const { data: summary } = useSWR<any>('/market/summary', fetcher, { refreshInterval: 60_000 });

  const active = tokens?.find((t) => t.id === selectedId) ?? tokens?.find((t) => !t.isQuote) ?? null;

  const { data: candles } = useSWR(
    active?.hasChart ? `/tokens/${active.id}/candles?interval=${interval}` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const { data: portfolio } = useSWR<any>('/portfolio', fetcher, { refreshInterval: 15_000 });
  const usdc = tokens?.find((t) => t.symbol === 'USDC');

  return (
    <div className="space-y-4">
      {/* Сводка по рынку */}
      {summary && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm panel px-4 py-3">
          <Summary label="Токенов" value={String(summary.tokens)} />
          <Summary label="Объём 24ч" value={fmtUsd(summary.volume24hUsd)} />
          <Summary label="Ликвидность" value={fmtUsd(summary.liquidityUsd)} />
          {Object.entries(summary.byChain ?? {}).map(([c, n]) => (
            <Summary key={c} label={CHAIN_LABEL[c] ?? c} value={String(n)} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Список рынков */}
        <aside className="col-span-12 lg:col-span-4 xl:col-span-3 panel p-3 h-fit">
          <input
            className="input mb-3 font-sans text-sm"
            placeholder="Поиск по тикеру или адресу"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="flex gap-1 mb-2 text-xs flex-wrap">
            <Chip active={!chain} onClick={() => setChain('')}>Все сети</Chip>
            {Object.entries(CHAIN_LABEL).map(([k, v]) => (
              <Chip key={k} active={chain === k} onClick={() => setChain(k)}>{v}</Chip>
            ))}
          </div>

          <div className="flex gap-1 mb-3 text-xs flex-wrap">
            {SORTS.map(([k, label]) => (
              <Chip key={k} active={sort === k} onClick={() => setSort(k)}>{label}</Chip>
            ))}
          </div>

          <div className="max-h-[70vh] overflow-auto -mx-1 px-1">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted sticky top-0 bg-panel">
                <tr>
                  <th className="text-left font-normal pb-2">Токен</th>
                  <th className="text-right font-normal pb-2">Цена</th>
                  <th className="text-right font-normal pb-2">24ч</th>
                </tr>
              </thead>
              <tbody>
                {tokens?.filter((t) => !t.isQuote).map((t) => {
                  const ch = Number(t.priceChange24h ?? 0);
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`cursor-pointer hover:bg-border/50 ${active?.id === t.id ? 'bg-border/70' : ''}`}
                    >
                      <td className="py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{t.symbol}</span>
                          {t.isVerified && (
                            <span className="text-accent text-[10px]" title="Проверен админом">✓</span>
                          )}
                        </div>
                        <div className="text-xs text-muted">
                          {CHAIN_LABEL[t.chain] ?? t.chain} · {fmtUsd(t.liquidityUsd)}
                        </div>
                      </td>
                      <td className="text-right num text-xs">{fmtPrice(t.priceUsd)}</td>
                      <td className={`text-right num text-xs ${ch >= 0 ? 'text-up' : 'text-down'}`}>
                        {t.priceChange24h == null ? '—' : fmtPct(ch)}
                      </td>
                    </tr>
                  );
                })}
                {!tokens?.length && (
                  <tr><td colSpan={3} className="text-center text-muted py-8 text-xs">
                    Список пуст. Импортёр наполняет его раз в час — запустить сразу
                    можно из админки.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </aside>

        {/* График */}
        <section className="col-span-12 lg:col-span-8 xl:col-span-6">
          <div className="panel p-4">
            {active ? (
              <>
                <div className="flex flex-wrap items-baseline gap-3 mb-4">
                  <h1 className="text-xl font-bold">{active.symbol}</h1>
                  <span className="text-sm text-muted">{active.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-border text-muted">
                    {CHAIN_LABEL[active.chain] ?? active.chain}
                  </span>
                  <div className="ml-auto text-right">
                    <div className="text-2xl num">{fmtPrice(active.priceUsd)}</div>
                    <div className={`text-sm num ${Number(active.priceChange24h ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                      {active.priceChange24h == null ? '' : `${fmtPct(active.priceChange24h)} за 24ч`}
                    </div>
                  </div>
                </div>

                {active.riskScore != null && active.riskScore > 60 && (
                  <div className="mb-3 text-xs text-down bg-down/10 border border-down/30 rounded p-2">
                    Риск-скор {active.riskScore}/100. Низкая ликвидность или молодой пул —
                    выход из позиции может оказаться дороже входа.
                  </div>
                )}

                <div className="flex gap-1 mb-3">
                  {INTERVALS.map((iv) => (
                    <Chip key={iv} active={interval === iv} onClick={() => setInterval(iv)}>
                      {iv}
                    </Chip>
                  ))}
                </div>

                {Array.isArray(candles) && candles.length > 0 ? (
                  <PriceChart candles={candles as never} />
                ) : (
                  <div className="h-[420px] flex flex-col items-center justify-center text-muted text-sm gap-1">
                    <span>Свечи ещё не загружены</span>
                    <span className="text-xs">
                      {active.hasChart
                        ? 'Загрузчик обходит токены по кругу, данные появятся в течение нескольких минут'
                        : 'Для этого токена не найден пул ликвидности'}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 text-sm">
                  <Metric label="Объём 24ч" value={fmtUsd(active.volume24hUsd)} />
                  <Metric label="Ликвидность" value={fmtUsd(active.liquidityUsd)} />
                  <Metric label="FDV" value={fmtUsd(active.fdvUsd)} />
                  <Metric label="Риск-скор" value={active.riskScore?.toString() ?? '—'} />
                </div>

                <div className="mt-3 text-xs text-muted font-mono break-all">
                  {active.address}
                </div>
              </>
            ) : (
              <div className="h-[500px] flex items-center justify-center text-muted">
                Выберите токен слева
              </div>
            )}
          </div>
        </section>

        {/* Панель торговли */}
        <aside className="col-span-12 xl:col-span-3 space-y-4">
          {active && usdc && (
            <TradePanel
              tokenId={active.id}
              tokenSymbol={active.symbol}
              quoteTokenId={usdc.id}
              quoteSymbol="USDC"
              chain={active.chain}
              currentPriceUsd={Number(active.priceUsd ?? 0)}
              availableQuote={Number(portfolio?.cashUsd ?? 0)}
              availableToken={Number(
                portfolio?.holdings?.find((h: any) => h.tokenId === active.id)?.quantity ?? 0,
              )}
            />
          )}

          <div className="panel p-4">
            <h3 className="text-sm font-medium mb-3">Портфель</h3>
            <div className="space-y-2 text-sm">
              <Row label="Всего" value={fmtUsd(portfolio?.totalValueUsd)} />
              <Row label="Свободно" value={fmtUsd(portfolio?.cashUsd)} />
              <Row
                label="Нереализ. PnL"
                value={fmtUsd(portfolio?.unrealizedPnlUsd)}
                tone={Number(portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}
              />
              <div className="pt-2 border-t border-border">
                <Row label="Комиссий уплачено" value={fmtUsd(portfolio?.totalFeesPaidUsd)} small />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded transition-colors ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white hover:bg-border'
      }`}
    >
      {children}
    </button>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted text-xs">{label} </span>
      <span className="num">{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="num">{value}</div>
    </div>
  );
}

function Row({ label, value, tone, small }: { label: string; value: string; tone?: 'up' | 'down'; small?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={`text-muted ${small ? 'text-xs' : ''}`}>{label}</span>
      <span className={`num ${small ? 'text-xs' : ''} ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </span>
    </div>
  );
}
