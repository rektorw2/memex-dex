'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher, api, fmtUsd, fmtPrice, errorMessage } from '@/lib/api';
import { chainLabel } from '@/lib/chains';

const CHAIN_OPTIONS = ['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const;

export default function RadarPage() {
  const [chain, setChain] = useState('');
  const [maxRisk, setMaxRisk] = useState<number | ''>('');
  const [maxAge, setMaxAge] = useState<number | ''>('');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => setIsAdmin(localStorage.getItem('role') === 'ADMIN'), []);

  const params = new URLSearchParams({ limit: '60' });
  if (chain) params.set('chain', chain);
  if (maxRisk !== '') params.set('maxRiskScore', String(maxRisk));
  if (maxAge !== '') params.set('maxAgeHours', String(maxAge));

  const { data, mutate, error } = useSWR<any>(`/radar?${params}`, fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-xl sm:text-2xl font-bold">Радар</h1>
        <p className="text-sm text-muted">
          Новые токены с ликвидностью — обнаруживаются автоматически
        </p>
      </div>

      {data?.sources && (
        <p className="text-xs text-muted">
          Источники: {data.sources.okx ? 'OKX Web3 API, ' : ''}GeckoTerminal ·
          порог ликвидности {fmtUsd(data.minLiquidityUsd)}
          {!data.sources.okx && ' · ключи OKX не заданы, работает бесплатный источник'}
        </p>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex gap-1 text-xs flex-wrap">
          <Chip active={!chain} onClick={() => setChain('')}>Все сети</Chip>
          {CHAIN_OPTIONS.map((c) => (
            <Chip key={c} active={chain === c} onClick={() => setChain(c)}>{chainLabel(c)}</Chip>
          ))}
        </div>

        <select
          className="input w-auto text-xs font-sans"
          value={maxRisk}
          onChange={(e) => setMaxRisk(e.target.value === '' ? '' : Number(e.target.value))}
        >
          <option value="">Любой риск</option>
          <option value="30">Риск до 30</option>
          <option value="50">Риск до 50</option>
          <option value="70">Риск до 70</option>
        </select>

        <select
          className="input w-auto text-xs font-sans"
          value={maxAge}
          onChange={(e) => setMaxAge(e.target.value === '' ? '' : Number(e.target.value))}
        >
          <option value="">Любой возраст</option>
          <option value="1">До часа</option>
          <option value="6">До 6 часов</option>
          <option value="24">До суток</option>
        </select>

        {isAdmin && (
          <button
            onClick={async () => { await api('/radar/scan', { method: 'POST' }); mutate(); }}
            className="btn-ghost text-xs"
          >
            Сканировать сейчас
          </button>
        )}

        <Link href="/radar/alerts" className="text-xs text-accent ml-auto self-center">
          Настроить уведомления →
        </Link>
      </div>

      {error && (
        <div className="panel p-4 border-down/40">
          <p className="text-sm text-down">{errorMessage(error)}</p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.events?.map((e: any) => <RadarCard key={e.id} event={e} />)}
        {data && data.events.length === 0 && (
          <p className="text-muted text-sm col-span-full py-12 text-center">
            Пока ничего не найдено. Радар проверяет источники каждые три минуты.
          </p>
        )}
      </div>
    </div>
  );
}

function RadarCard({ event: e }: { event: any }) {
  const flags: string[] = Array.isArray(e.riskFlags) ? e.riskFlags : [];
  const age = e.poolAgeHours;

  return (
    <article className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{e.symbol}</div>
          <div className="text-xs text-muted truncate">{e.name}</div>
        </div>
        {e.riskScore != null && (
          <span
            className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${
              e.riskScore > 60
                ? 'bg-down/15 text-down border-down/30'
                : e.riskScore > 30
                  ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
                  : 'bg-up/15 text-up border-up/30'
            }`}
          >
            риск {e.riskScore}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs bg-bg rounded-md p-2.5">
        <div>
          <div className="text-muted">Цена</div>
          <div className="num">{fmtPrice(e.priceUsd)}</div>
        </div>
        <div>
          <div className="text-muted">Ликвидность</div>
          <div className="num">{fmtUsd(e.liquidityUsd)}</div>
        </div>
        <div>
          <div className="text-muted">Возраст</div>
          <div className="num">{age != null ? `${age.toFixed(1)} ч` : '—'}</div>
        </div>
      </div>

      {flags.length > 0 && (
        <ul className="text-xs space-y-1">
          {flags.slice(0, 3).map((f, i) => (
            <li key={i} className="flex gap-1.5 text-muted">
              <span className="text-down shrink-0">•</span>{f}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between text-xs text-muted">
        <span>{chainLabel(e.chain)} · {e.source}</span>
        <span>{new Date(e.firstSeenAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="font-mono text-[10px] text-muted break-address">{e.address}</div>
    </article>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded ${active ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white hover:bg-border'}`}
    >
      {children}
    </button>
  );
}
