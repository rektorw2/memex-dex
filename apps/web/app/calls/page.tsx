'use client';

import useSWR from 'swr';
import { useState } from 'react';
import Link from 'next/link';
import { fetcher, fmtPrice, fmtPct, api, newIdempotencyKey } from '@/lib/api';

interface Call {
  id: string; title: string; thesis: string; risk: string; status: string;
  chain: string; entryPriceUsd: string; currentPriceUsd: string | null;
  pnlPct: string | null; peakMultiple: string | null;
  targets: Array<{ priceUsd: string; pct: number }>;
  stopLossUsd: string | null; suggestedPct: string | null;
  timeHorizon: string | null; publishedAt: string; followers: number;
  isCopyEnabled: boolean;
  token: { id: string; symbol: string; name: string; chain: string; liquidityUsd: string | null; riskScore: number | null };
}

const RISK_STYLE: Record<string, string> = {
  LOW: 'bg-up/15 text-up border-up/30',
  MEDIUM: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  HIGH: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  DEGEN: 'bg-down/15 text-down border-down/30',
};

const RISK_LABEL: Record<string, string> = {
  LOW: 'низкий риск', MEDIUM: 'средний риск', HIGH: 'высокий риск', DEGEN: 'дегенский',
};

export default function CallsPage() {
  const [chain, setChain] = useState('');
  const { data: calls } = useSWR<Call[]>(
    `/calls?status=PUBLISHED${chain ? `&chain=${chain}` : ''}`,
    fetcher,
    { refreshInterval: 15_000 },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-xl sm:text-2xl font-bold">Коллы</h1>
        <p className="text-sm text-muted">
          Проекты с потенциалом роста, отобранные аналитиками платформы
        </p>
      </div>

      <div className="flex gap-1 text-sm">
        {[
          ['', 'Все'], ['SOLANA', 'Solana'], ['BNB', 'BNB Chain'], ['ROBINHOOD', 'Robinhood Chain'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setChain(k!)}
            className={`px-3 py-1.5 rounded-md ${chain === k ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {calls?.map((call) => (
          <CallCard key={call.id} call={call} />
        ))}
        {!calls?.length && (
          <p className="text-muted text-sm col-span-full py-12 text-center">
            Пока нет опубликованных коллов
          </p>
        )}
      </div>
    </div>
  );
}

function CallCard({ call }: { call: Call }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const pnl = Number(call.pnlPct ?? 0);

  async function quickBuy(usdAmount: number) {
    setBusy(true);
    try {
      await api('/orders', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify({
          chain: call.chain,
          tokenInId: 'USDC_TOKEN_ID', // подставляется из справочника котировочных токенов
          tokenOutId: call.token.id,
          side: 'BUY',
          type: 'MARKET',
          amountIn: String(usdAmount),
          slippageBps: 200,
          callId: call.id,
        }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel p-4 space-y-3 flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Заголовок и тикер ведут на карточку токена: прочитав тезис,
              человек первым делом хочет проверить цифры и риски. */}
          <Link href={`/token?id=${call.token.id}`} className="block group">
            <h2 className="font-semibold leading-tight group-hover:text-accent transition-colors">
              {call.title}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-sm text-muted group-hover:text-accent transition-colors">
                ${call.token.symbol}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-border text-muted">{call.chain}</span>
            </div>
          </Link>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${RISK_STYLE[call.risk]}`}>
          {RISK_LABEL[call.risk]}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm bg-bg rounded-md p-3">
        <div>
          <div className="text-xs text-muted">Вход</div>
          <div className="num text-xs">{fmtPrice(call.entryPriceUsd)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Сейчас</div>
          <div className="num text-xs">{fmtPrice(call.currentPriceUsd)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Результат</div>
          <div className={`num text-xs ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
            {fmtPct(pnl)}
          </div>
        </div>
      </div>

      <p className={`text-sm text-muted leading-relaxed ${expanded ? '' : 'line-clamp-3'}`}>
        {call.thesis}
      </p>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-accent text-left"
      >
        {expanded ? 'Свернуть' : 'Читать тезис полностью'}
      </button>

      {expanded && (
        <div className="text-xs space-y-2 border-t border-border pt-3">
          <div>
            <span className="text-muted">Цели: </span>
            {call.targets?.map((t, i) => (
              <span key={i} className="num">
                {fmtPrice(t.priceUsd)} ({t.pct}%){i < call.targets.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
          {call.stopLossUsd && (
            <div>
              <span className="text-muted">Стоп-лосс: </span>
              <span className="num text-down">{fmtPrice(call.stopLossUsd)}</span>
            </div>
          )}
          {call.suggestedPct && (
            <div>
              <span className="text-muted">Рекомендуемая доля портфеля: </span>
              <span className="num">{call.suggestedPct}%</span>
            </div>
          )}
          {call.timeHorizon && (
            <div><span className="text-muted">Горизонт: </span>{call.timeHorizon}</div>
          )}
          {call.token.riskScore != null && call.token.riskScore > 50 && (
            <p className="text-down">
              Риск-скор токена {call.token.riskScore}/100 — входите только на сумму,
              которую готовы потерять полностью.
            </p>
          )}
        </div>
      )}

      <div className="mt-auto pt-3 flex gap-2">
        {[50, 100, 250].map((amt) => (
          <button
            key={amt}
            onClick={() => quickBuy(amt)}
            disabled={busy}
            className="btn-buy text-sm flex-1"
          >
            ${amt}
          </button>
        ))}
      </div>
    </article>
  );
}
