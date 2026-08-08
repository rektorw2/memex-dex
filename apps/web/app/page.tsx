'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { fetcher, fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
import { PriceChart } from '@/components/PriceChart';
import { TradePanel } from '@/components/TradePanel';

interface Token {
  id: string; symbol: string; name: string; chain: string;
  priceUsd: string | null; liquidityUsd: string | null;
  volume24hUsd: string | null; riskScore: number | null; logoUrl: string | null;
}

const CHAIN_LABEL: Record<string, string> = {
  SOLANA: 'Solana', BNB: 'BNB Chain', ROBINHOOD: 'Robinhood Chain',
  ETHEREUM: 'Ethereum', BASE: 'Base',
};

export default function TerminalPage() {
  const [chain, setChain] = useState<string>('');
  const [selected, setSelected] = useState<Token | null>(null);

  const { data: tokens } = useSWR<Token[]>(
    `/tokens${chain ? `?chain=${chain}` : ''}`,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const active = selected ?? tokens?.[0] ?? null;
  const { data: candles } = useSWR(
    active ? `/tokens/${active.id}/candles?interval=5m` : null,
    fetcher,
    { refreshInterval: 10_000 },
  );

  const { data: portfolio } = useSWR<any>('/portfolio', fetcher, { refreshInterval: 10_000 });

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Список рынков */}
      <aside className="col-span-12 lg:col-span-3 panel p-3 h-fit max-h-[80vh] overflow-auto">
        <div className="flex gap-1 mb-3 text-xs flex-wrap">
          <button
            onClick={() => setChain('')}
            className={`px-2 py-1 rounded ${!chain ? 'bg-accent/20 text-accent' : 'text-muted'}`}
          >
            Все сети
          </button>
          {Object.entries(CHAIN_LABEL).map(([k, v]) => (
            <button
              key={k}
              onClick={() => setChain(k)}
              className={`px-2 py-1 rounded ${chain === k ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}
            >
              {v}
            </button>
          ))}
        </div>

        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left font-normal pb-2">Токен</th>
              <th className="text-right font-normal pb-2">Цена</th>
              <th className="text-right font-normal pb-2">Ликв.</th>
            </tr>
          </thead>
          <tbody>
            {tokens?.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected(t)}
                className={`cursor-pointer hover:bg-border/50 ${active?.id === t.id ? 'bg-border/70' : ''}`}
              >
                <td className="py-1.5">
                  <div className="font-medium">{t.symbol}</div>
                  <div className="text-xs text-muted">{CHAIN_LABEL[t.chain] ?? t.chain}</div>
                </td>
                <td className="text-right num text-xs">{fmtPrice(t.priceUsd)}</td>
                <td className="text-right num text-xs text-muted">{fmtUsd(t.liquidityUsd)}</td>
              </tr>
            ))}
            {!tokens?.length && (
              <tr><td colSpan={3} className="text-center text-muted py-6 text-xs">
                Нет токенов. Добавьте их в админке.
              </td></tr>
            )}
          </tbody>
        </table>
      </aside>

      {/* График */}
      <section className="col-span-12 lg:col-span-6 space-y-4">
        <div className="panel p-4">
          {active ? (
            <>
              <div className="flex items-baseline gap-3 mb-4">
                <h1 className="text-xl font-bold">{active.symbol}</h1>
                <span className="text-sm text-muted">{active.name}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-border text-muted">
                  {CHAIN_LABEL[active.chain] ?? active.chain}
                </span>
                <span className="ml-auto text-2xl num">{fmtPrice(active.priceUsd)}</span>
              </div>

              {active.riskScore != null && active.riskScore > 60 && (
                <div className="mb-3 text-xs text-down bg-down/10 border border-down/30 rounded p-2">
                  Высокий риск-скор: {active.riskScore}/100. Возможна низкая ликвидность
                  или концентрация предложения у крупных держателей.
                </div>
              )}

              {candles && Array.isArray(candles) && candles.length > 0 ? (
                <PriceChart candles={candles as never} />
              ) : (
                <div className="h-[420px] flex items-center justify-center text-muted text-sm">
                  Нет исторических данных по этому токену
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 mt-4 text-sm">
                <div>
                  <div className="text-xs text-muted">Объём 24ч</div>
                  <div className="num">{fmtUsd(active.volume24hUsd)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Ликвидность</div>
                  <div className="num">{fmtUsd(active.liquidityUsd)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Риск-скор</div>
                  <div className="num">{active.riskScore ?? '—'}</div>
                </div>
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
      <aside className="col-span-12 lg:col-span-3 space-y-4">
        {active && (
          <TradePanel
            tokenId={active.id}
            tokenSymbol={active.symbol}
            quoteTokenId={tokens?.find((t) => t.symbol === 'USDC')?.id ?? ''}
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
            <div className="flex justify-between">
              <span className="text-muted">Всего</span>
              <span className="num">{fmtUsd(portfolio?.totalValueUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Свободно</span>
              <span className="num">{fmtUsd(portfolio?.cashUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Нереализ. PnL</span>
              <span className={`num ${Number(portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                {fmtUsd(portfolio?.unrealizedPnlUsd)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-border">
              <span className="text-muted text-xs">Комиссий уплачено</span>
              <span className="num text-xs">{fmtUsd(portfolio?.totalFeesPaidUsd)}</span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
