'use client';

import useSWR from 'swr';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { fetcher, fmtUsd, fmtPrice, fmtPct } from '@/lib/api';
import { useAccess } from '@/lib/access';
import { shouldRequestPrivateData, tradePanelState } from '@memex/core';
import { TokenLogo } from '@/components/TokenLogo';
import { TokenList } from '@/components/terminal/TokenList';
import { ChartPanel } from '@/components/terminal/ChartPanel';
import { SidePanel } from '@/components/terminal/SidePanel';
import { CHAIN_LABEL, SORT_OPTIONS, QUICK_FILTERS, type Token } from '@/components/terminal/types';
import { DexScreenerList } from '@/components/terminal/DexScreenerList';

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

function Terminal() {
  // Гость видит терминал целиком, но только рынок. Приватного
  // у него нет по определению, и спрашивать за него не надо:
  // запрос всё равно вернёт 401, зато в консоли будет ошибка,
  // а на сервере — лишний разбор чужого токена.
  const { anonymous, loading: accessLoading, access } = useAccess();

  // Состояние торговой панели считает ядро — тем же правилом, что
  // и страница токена. Две копии разошлись бы, и одна из страниц
  // показала бы форму там, где сервер откажет.
  const panel = tradePanelState({
    authenticated: !anonymous,
    capabilities: access?.capabilities ?? [],
  });

  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<string>('volume');
  const [search, setSearch] = useState('');
  const [interval, setInterval] = useState<string>('5m');
  // Токен может прийти адресом: карточка лидера на первом экране
  // ведёт сюда с уже выбранным токеном, и ссылкой можно поделиться.
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('token'));
  const [tab, setTab] = useState<'market' | 'chart' | 'portfolio'>('market');
  // По умолчанию показываем только прошедшие проверку. Витрина, где
  // безопасное и сомнительное лежат вперемешку, перекладывает разбор
  // на человека — а он для того и пришёл, чтобы этого не делать.
  const [safeOnly, setSafeOnly] = useState(true);
  /**
   * Источник списка рынков.
   *
   * Своя витрина и продвигаемые токены DexScreener — разные вещи
   * по природе, и смешивать их в одном списке нельзя: первое собрано
   * нами, второе оплачено размещением. Вкладки делают эту разницу
   * видимой до того, как человек начнёт читать.
   */
  const [source, setSource] = useState<'own' | 'dexscreener'>('own');

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
    stale?: number;
  }>('/tokens/check-status', fetcher, { refreshInterval: 30_000 });

  const active =
    tokens?.find((t) => t.id === selectedId) ?? tokens?.find((t) => !t.isQuote) ?? null;

  const { data: candles } = useSWR(
    active?.hasChart ? `/tokens/${active.id}/candles?interval=${interval}` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  // Ключ null отключает запрос целиком. Пока права ещё загружаются,
  // портфель тоже не спрашиваем: иначе при обновлении страницы
  // гость успевал бы отправить запрос до того, как выяснится,
  // что он гость.
  const { data: portfolio, isLoading: portfolioLoading } = useSWR<any>(
    shouldRequestPrivateData({ authenticated: !anonymous, accessLoading }) ? '/portfolio' : null,
    fetcher,
    { refreshInterval: 15_000, shouldRetryOnError: false },
  );

  const quoteToken = tokens?.find((t) => t.isQuote && t.chain === active?.chain);

  /** Выбор токена на телефоне сразу открывает график. */
  function selectToken(t: Token) {
    setSelectedId(t.id);
    setTab('chart');
  }

  /**
   * Поиск по адресу показывает и то, что скрыто фильтрами.
   *
   * Это осознанное решение: человек, вставивший адрес контракта,
   * всё равно найдёт токен в другом месте — только уже без наших
   * предупреждений. Но появление скрытого токена нельзя оставлять
   * без объяснения, иначе фильтр выглядит сломанным.
   */
  const isAddressSearch = search.trim().length > 25;
  const hiddenFound = isAddressSearch
    ? (tokens ?? []).filter(
        (t) => t.riskLevel === 'blocked' || t.riskLevel === 'high' || t.riskLevel === 'pending',
      )
    : [];

  const addressNotice =
    hiddenFound.length > 0 ? (
      <div className="border-down/40 bg-down/10 text-down space-y-1 rounded border p-3 text-xs leading-relaxed">
        <p className="font-medium">
          Этот токен скрыт из общего списка
        </p>
        <p className="text-down/80">
          {hiddenFound[0].riskLevel === 'pending'
            ? 'Проверка ещё не завершена — это не то же самое, что «всё чисто».'
            : 'Проверка нашла причины его не показывать. Нажмите на щит рядом с тикером, чтобы увидеть какие.'}
        </p>
      </div>
    ) : null;

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
            <SourceTabs value={source} onChange={setSource} />

            {source === 'own' && (
              <div className="shrink-0 space-y-3 border-b border-border p-3">
                {filters}
                {addressNotice}
              </div>
            )}

            <div className="scroll-y min-h-0 flex-1">
              {source === 'own' ? (
                <TokenList
                  tokens={tokens}
                  activeId={active?.id ?? null}
                  onSelect={(t) => setSelectedId(t.id)}
                  isLoading={isLoading}
                />
              ) : (
                <div className="p-3">
                  <DexScreenerList chain={chain} safeOnly={safeOnly} />
                </div>
              )}
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
              anonymous={anonymous}
              canTrade={panel === 'trade'}
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
              <SourceTabs value={source} onChange={setSource} />

              {source === 'own' ? (
                <>
                  <div className="sticky top-header z-20 space-y-3 border-b border-border bg-panel p-3">
                    {filters}
                    {addressNotice}
                  </div>
                  <TokenList
                    tokens={tokens}
                    activeId={active?.id ?? null}
                    onSelect={selectToken}
                    isLoading={isLoading}
                    touch
                  />
                </>
              ) : (
                <div className="p-3">
                  <DexScreenerList chain={chain} safeOnly={safeOnly} />
                </div>
              )}
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
            anonymous={anonymous}
            canTrade={panel === 'trade'}
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

/**
 * Переключатель источника списка.
 *
 * Две вкладки, а не фильтр внутри одного списка. Разница в том,
 * кто отвечает за состав: «Рынок» собран нами по объёму и проверке,
 * «DexScreener» — оплаченное размещение. Спрятать это различие
 * в выпадающий список значило бы приравнять одно к другому.
 */
function SourceTabs({
  value,
  onChange,
}: {
  value: 'own' | 'dexscreener';
  onChange: (v: 'own' | 'dexscreener') => void;
}) {
  return (
    <div className="flex shrink-0 border-b border-border">
      {(
        [
          ['own', 'Рынок'],
          ['dexscreener', 'DexScreener'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-xs transition-colors ${
            value === v
              ? 'border-accent text-accent'
              : 'border-transparent text-muted hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
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
    // «Прошли проверку», а не «Токенов»: число в шапке должно совпадать
    // с тем, что человек видит в списке, иначе оно вводит в заблуждение.
    ['Прошли проверку', String(summary.passedCheck ?? summary.tokens)],
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

      {/* Источник и время последнего обновления.
          Оба нужны по одной причине: число без указания, откуда оно
          и насколько свежее, читается как вечная истина. Цена
          мем-коина живёт секунды, и человек имеет право видеть,
          на что он смотрит. */}
      {summary.dataSource && (
        <div className="ml-auto shrink-0 pl-4 text-right">
          <div className="text-[11px] leading-tight text-muted">
            Рыночные данные: {summary.dataSource}
          </div>
          <div className="text-[11px] leading-tight text-muted/70">
            Обновлено {fmtTime(summary.updatedAt)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Время обновления в местном формате. Дата не нужна — данные минутные. */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '—';
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
  checkStatus?: {
    total: number; ok: number; warn: number; blocked: number;
    unchecked: number; stale?: number;
  };
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

      {/* Быстрые фильтры переносятся по строкам, а не прокручиваются.
          Прокрутка обрезала последнюю кнопку у края экрана, и о её
          существовании нельзя было догадаться: горизонтальный скролл
          внутри узкой панели пальцем почти не нащупывается. */}
      <div className="flex flex-wrap gap-1.5">
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
      {checkStatus && (
        <div className="text-muted space-y-1 text-[11px] leading-relaxed">
          <p>
            {safeOnly
              ? `Прошли проверку: ${checkStatus.ok}. Скрыто: ${checkStatus.blocked} ловушек, ` +
                `${checkStatus.warn} с замечаниями.`
              : `Проверено ${checkStatus.total - checkStatus.unchecked} из ${checkStatus.total}. ` +
                `Скрыто как ловушки: ${checkStatus.blocked}.`}
            {(checkStatus.stale ?? 0) > 0 && (
              <span className="text-warn">
                {' '}
                {checkStatus.stale} проверено по устаревшим правилам — идёт перепроверка.
              </span>
            )}
          </p>

          {/* Когда строгий фильтр оставляет почти пустой список, о выходе
              из него надо сказать прямо. Молча ослаблять фильтр нельзя:
              человек включал его сознательно. */}
          {safeOnly && checkStatus.ok < 10 && checkStatus.warn > 0 && (
            <p>
              Список короткий.{' '}
              <button
                onClick={() => setSafeOnly(false)}
                className="text-accent underline underline-offset-2"
              >
                Показать ещё {checkStatus.warn} с замечаниями
              </button>{' '}
              — у каждого будет виден жёлтый щит и причины.
            </p>
          )}
        </div>
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

export default function TerminalPage() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-muted">Загружаем рынок…</p>}>
      <Terminal />
    </Suspense>
  );
}
