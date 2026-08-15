'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { fetcher, fmtUsd, fmtPrice, fmtPct } from '@/lib/api';
import { TokenLogo } from '@/components/TokenLogo';
import { TokenList } from '@/components/terminal/TokenList';
import { ChartPanel } from '@/components/terminal/ChartPanel';
import { SidePanel } from '@/components/terminal/SidePanel';
import { CHAIN_LABEL, SORT_OPTIONS, QUICK_FILTERS, type Token } from '@/components/terminal/types';

/**
 * Терминал.
 *
 * На широком экране — три колонки во всю высоту: список рынков,
 * график, торговля. Каждая прокручивается сама, страница целиком
 * не прокручивается вовсе. Это принципиально для терминала: когда
 * при поиске токена в списке уезжает график, работать невозможно.
 *
 * На телефоне колонки не складываются друг под друга — вместо этого
 * три отдельных экрана с переключателем внизу. Вертикальная свалка
 * означала бы, что до графика нужно пролистать шестьдесят строк
 * списка, а до торговли — ещё и весь график.
 */

export default function TerminalPage() {
  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<string>('volume');
  const [search, setSearch] = useState('');
  const [interval, setInterval] = useState<string>('5m');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'market' | 'chart' | 'portfolio'>('market');
  const [safeOnly, setSafeOnly] = useState(false);

  const params = new URLSearchParams({ sort, limit: '60' });
  if (chain) params.set('chain', chain);
  if (search) params.set('search', search);
  if (safeOnly) params.set('safeOnly', 'true');

  const { data: tokens, isLoading } = useSWR<Token[]>(`/tokens?${params}`, fetcher, {
    refreshInterval: 20_000,
    keepPreviousData: true,
  });

  const { data: summary } = useSWR<any>('/market/summary', fetcher, { refreshInterval: 60_000 });

  // Состояние проверки: без него короткий список читается как «ничего
  // нет», хотя на самом деле проверка ещё идёт.
  const { data: checkStatus } = useSWR<{
    total: number; ok: number; warn: number; blocked: number; unchecked: number;
  }>('/tokens/check-status', fetcher, { refreshInterval: 60_000 });

  const active =
    tokens?.find((t) => t.id === selectedId) ?? tokens?.find((t) => !t.isQuote) ?? null;

  const { data: candles } = useSWR(
    active?.hasChart ? `/tokens/${active.id}/candles?interval=${interval}` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const { data: portfolio, isLoading: portfolioLoading } = useSWR<any>('/portfolio', fetcher, {
    refreshInterval: 15_000,
    shouldRetryOnError: false,
  });

  const quoteToken = tokens?.find((t) => t.isQuote && t.chain === active?.chain);

  /** Выбор токена на телефоне сразу открывает график. */
  function selectToken(t: Token) {
    setSelectedId(t.id);
    setTab('chart');
  }

  const filters = (
    <Filters
      chain={chain}
      setChain={setChain}
      sort={sort}
      setSort={setSort}
      search={search}
      setSearch={setSearch}
      safeOnly={safeOnly}
      setSafeOnly={setSafeOnly}
      checkStatus={checkStatus}
    />
  );

  return (
    <>
      {/* ══════════════════ Десктоп: три колонки ══════════════════ */}
      <div className="hidden lg:flex lg:h-[calc(100vh-var(--shell))] lg:flex-col lg:gap-4">
        <MarketStats summary={summary} />

        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)_300px] gap-4 xl:grid-cols-[380px_minmax(0,1fr)_320px]">
          {/* Список рынков */}
          <aside className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border p-3">{filters}</div>
            <div className="scroll-y min-h-0 flex-1">
              <TokenList
                tokens={tokens}
                activeId={active?.id ?? null}
                onSelect={(t) => setSelectedId(t.id)}
                isLoading={isLoading}
              />
            </div>
          </aside>

          {/* График */}
          <section className="panel min-h-0 overflow-hidden">
            <ChartPanel
              token={active}
              candles={candles as unknown[] | undefined}
              interval={interval}
              onInterval={setInterval}
              chartHeight={380}
            />
          </section>

          {/* Портфель и торговля */}
          <aside className="scroll-y min-h-0">
            <SidePanel
              token={active}
              quoteToken={quoteToken}
              portfolio={portfolio}
              isLoading={portfolioLoading}
            />
          </aside>
        </div>
      </div>

      {/* ══════════════════ Телефон: три экрана ══════════════════ */}
      <div className="pb-nav flex flex-col gap-3 lg:hidden">
        {tab === 'market' && (
          <>
            <MarketStats summary={summary} compact />
            <div className="panel overflow-hidden">
              <div className="sticky top-header z-20 border-b border-border bg-panel p-3">
                {filters}
              </div>
              <TokenList
                tokens={tokens}
                activeId={active?.id ?? null}
                onSelect={selectToken}
                isLoading={isLoading}
                touch
              />
            </div>
          </>
        )}

        {tab === 'chart' && (
          <>
            {active && <MobileTokenHeader token={active} onBack={() => setTab('market')} />}
            <div className="panel overflow-hidden">
              <ChartPanel
                token={active}
                candles={candles as unknown[] | undefined}
                interval={interval}
                onInterval={setInterval}
                chartHeight={260}
                showHeader={false}
              />
            </div>
            {active && (
              <button
                onClick={() => setTab('portfolio')}
                className="btn-primary w-full tap text-sm"
              >
                Купить / Продать
              </button>
            )}
          </>
        )}

        {tab === 'portfolio' && (
          <SidePanel
            token={active}
            quoteToken={quoteToken}
            portfolio={portfolio}
            isLoading={portfolioLoading}
          />
        )}

        {/* Переключатель экранов прижат к низу: до него дотягивается
            большой палец, а верх экрана на телефоне в 6 дюймов — нет. */}
        {/* Панель непрозрачная и того же цвета, что фон: полупрозрачность
            поверх прокручивающегося содержимого давала оттенок, отличный
            и от страницы, и от полосы браузера под ней. */}
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-border bg-bg">
          {(
            [
              ['market', 'Рынок'],
              ['chart', 'График'],
              ['portfolio', 'Портфель'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key}
              className={`tap py-3 text-sm transition-colors ${
                tab === key ? 'text-accent' : 'text-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}

/* ────────────────────────── Сводка по рынку ────────────────────────── */

function MarketStats({ summary, compact }: { summary: any; compact?: boolean }) {
  if (!summary) {
    return (
      <div className="panel flex h-stats shrink-0 items-center gap-6 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-3 w-20 animate-pulse rounded bg-raised" />
        ))}
      </div>
    );
  }

  const items: Array<[string, string]> = [
    ['Токенов', String(summary.tokens)],
    ['Объём 24ч', fmtUsd(summary.volume24hUsd)],
    ['Ликвидность', fmtUsd(summary.liquidityUsd)],
    ...Object.entries(summary.byChain ?? {}).map(
      ([c, n]) => [CHAIN_LABEL[c] ?? c, String(n)] as [string, string],
    ),
  ];

  return (
    <div
      className={`panel scroll-x flex shrink-0 items-center gap-6 px-4 ${
        compact ? 'py-2.5' : 'h-stats'
      }`}
    >
      {items.map(([label, value]) => (
        <div key={label} className="shrink-0">
          <div className="text-[11px] leading-tight text-muted">{label}</div>
          <div className="num text-sm leading-tight">{value}</div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Фильтры списка ─────────────────────────── */

function Filters({
  chain,
  setChain,
  sort,
  setSort,
  search,
  setSearch,
  safeOnly,
  setSafeOnly,
  checkStatus,
}: {
  chain: string;
  setChain: (v: string) => void;
  sort: string;
  setSort: (v: string) => void;
  search: string;
  setSearch: (v: string) => void;
  safeOnly: boolean;
  setSafeOnly: (v: boolean) => void;
  checkStatus?: { total: number; ok: number; warn: number; blocked: number; unchecked: number };
}) {
  return (
    <div className="space-y-2">
      <input
        className="input font-sans text-sm"
        placeholder="Поиск по тикеру или адресу"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="flex gap-2">
        {/* Выпадающие списки вместо ряда кнопок: пять сетей и пять
            сортировок занимали три строки и оставляли списку рынков
            меньше половины панели. */}
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          className="input flex-1 font-sans text-xs"
          aria-label="Сеть"
        >
          <option value="">Все сети</option>
          {Object.entries(CHAIN_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <select
          value={SORT_OPTIONS.some(([k]) => k === sort) ? sort : 'volume'}
          onChange={(e) => setSort(e.target.value)}
          className="input flex-1 font-sans text-xs"
          aria-label="Сортировка"
        >
          {SORT_OPTIONS.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {/* Быстрые фильтры остаются на виду: ими пользуются постоянно. */}
      <div className="scroll-x flex gap-1.5">
        {QUICK_FILTERS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSort(sort === k ? 'volume' : k)}
            className={`tap shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors ${
              sort === k
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:bg-raised hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}

        <button
          onClick={() => setSafeOnly(!safeOnly)}
          title="Только токены, прошедшие проверку контракта без замечаний"
          className={`tap shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors ${
            safeOnly ? 'bg-up/15 text-up' : 'text-muted hover:bg-raised hover:text-white'
          }`}
        >
          Проверенные
        </button>
      </div>

      {/* Состояние проверки. Показывается только пока она не закончена:
          у готовой витрины эта строка была бы шумом. */}
      {checkStatus && checkStatus.unchecked > 0 && (
        <p className="text-muted text-[11px] leading-relaxed">
          Проверено {checkStatus.total - checkStatus.unchecked} из {checkStatus.total} токенов.
          Скрыто как ловушки: {checkStatus.blocked}.
        </p>
      )}
    </div>
  );
}

/* ──────────────────── Шапка токена на телефоне ──────────────────── */

function MobileTokenHeader({ token, onBack }: { token: Token; onBack: () => void }) {
  const ch = token.priceChange24h == null ? null : Number(token.priceChange24h);

  return (
    <div className="panel flex items-center gap-3 p-3">
      <button
        onClick={onBack}
        aria-label="Назад к списку"
        className="tap -ml-1 flex items-center justify-center rounded-md px-2 text-muted hover:bg-raised hover:text-white"
      >
        ←
      </button>

      <TokenLogo symbol={token.symbol} address={token.address} logoUrl={token.logoUrl} size={32} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{token.symbol}</span>
          <span className="shrink-0 rounded border border-border bg-raised px-1.5 py-0.5 text-[10px] text-muted">
            {CHAIN_LABEL[token.chain] ?? token.chain}
          </span>
        </div>
        <p className="truncate text-xs text-muted">{token.name}</p>
      </div>

      <div className="shrink-0 text-right">
        <div className="num text-sm font-semibold leading-tight">{fmtPrice(token.priceUsd)}</div>
        <div
          className={`num text-xs leading-tight ${
            ch == null ? 'text-muted' : ch >= 0 ? 'text-up' : 'text-down'
          }`}
        >
          {ch == null ? '—' : fmtPct(ch)}
        </div>
      </div>
    </div>
  );
}
