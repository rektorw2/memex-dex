'use client';

import useSWR from 'swr';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { fetcher, fmtUsd, fmtPrice, fmtPct } from '@/lib/api';
import { useAccess } from '@/lib/access';
import {
  shouldRequestPrivateData,
  tradePanelState,
} from '@memex/core';
import { TokenLogo } from '@/components/TokenLogo';
import { TokenList } from '@/components/terminal/TokenList';
import { MarketStats } from '@/components/terminal/MarketStats';
import {
  TerminalSearchField,
  TerminalSelect,
  TerminalFilterChip,
  TerminalChipRow,
  TerminalFilterBar,
  TerminalTabs,
} from '@/components/terminal/controls';
import { ChartPanel } from '@/components/terminal/ChartPanel';
import { SidePanel } from '@/components/terminal/SidePanel';
import { CHAIN_LABEL, SORT_OPTIONS, QUICK_FILTERS, type Token } from '@/components/terminal/types';
import { DexScreenerList } from '@/components/terminal/DexScreenerList';
import { GemsList, type GemToken } from '@/components/terminal/GemsList';
import { useTerminalChart } from '@/components/terminal/useTerminalChart';

type MarketSource = 'own' | 'gems' | 'dexscreener';

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
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('token'));
  // GEMS содержит токены, намеренно скрытые из обычной витрины.
  // Поэтому выбранную карточку держим отдельно: искать её в `tokens`
  // означало бы после клика открыть график первого обычного токена.
  const [selectedGem, setSelectedGem] = useState<Token | null>(null);
  const [tab, setTab] = useState<'market' | 'chart' | 'portfolio'>('market');
  // По умолчанию показываем только прошедшие проверку. Витрина, где
  // безопасное и сомнительное лежат вперемешку, перекладывает разбор
  // на человека — а он для того и пришёл, чтобы этого не делать.
  const [safeOnly, setSafeOnly] = useState(true);
  /**
   * Только токены с рыночной активностью за последние сутки.
   *
   * Комбинируется со всеми остальными фильтрами и по умолчанию
   * выключен: витрина не должна молча прятать половину рынка
   * до того, как человек об этом попросил.
   */
  const [activeOnly, setActiveOnly] = useState(false);
  /**
   * Своё состояние вкладки DexScreener.
   *
   * Прежде она получала `chain` и `safeOnly` от «Рынка». Оба фильтра
   * человек включал для своей витрины, а действовали они на чужой:
   * `safeOnly` по умолчанию включён, и вкладка молча показывала
   * только те продвигаемые токены, которые уже прошли нашу проверку.
   * Их единицы — отсюда и список из двух строк.
   *
   * Вкладки показывают разные наборы по разным правилам, и общее
   * состояние фильтров означало, что настройка одной незаметно
   * управляет другой.
   */
  const [dexChain, setDexChain] = useState('');
  const [dexSafeOnly, setDexSafeOnly] = useState(false);
  /**
   * Источник списка рынков.
   *
   * Своя витрина и продвигаемые токены DexScreener — разные вещи
   * по природе, и смешивать их в одном списке нельзя: первое собрано
   * нами, второе оплачено размещением. Вкладки делают эту разницу
   * видимой до того, как человек начнёт читать.
   */
  const [source, setSource] = useState<MarketSource>('own');

  const params = new URLSearchParams({ sort, limit: '60' });
  if (chain) params.set('chain', chain);
  if (search) params.set('search', search);
  if (safeOnly) params.set('safeOnly', 'true');
  if (activeOnly) params.set('activeOnly', 'true');

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
    (selectedGem?.id === selectedId ? selectedGem : null) ??
    tokens?.find((t) => t.id === selectedId) ??
    tokens?.find((t) => !t.isQuote) ??
    null;

  const {
    chart: displayedChart,
    token: displayedActive,
    loadOlder,
    reload: reloadChart,
  } = useTerminalChart(active, interval);

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
    setSelectedGem(null);
    setSelectedId(t.id);
    setTab('chart');
  }

  /** Карточка GEMS сразу переводит фокус на график и сохраняет ссылку. */
  function openGemChart(gem: GemToken) {
    if (!gem.id) return;
    const token = terminalTokenFromGem(gem);
    setSelectedGem(token);
    setSelectedId(token.id);
    setTab('chart');
    router.replace(`/terminal?token=${encodeURIComponent(token.id)}`, { scroll: false });
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
      activeOnly={activeOnly}
      setActiveOnly={setActiveOnly}
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
                  onSelect={(t) => {
                    setSelectedGem(null);
                    setSelectedId(t.id);
                  }}
                  isLoading={isLoading}
                />
              ) : source === 'gems' ? (
                <GemsList onOpenChart={openGemChart} />
              ) : (
                <div className="p-3">
                  <DexScreenerList
                    chain={dexChain}
                    onChain={setDexChain}
                    safeOnly={dexSafeOnly}
                    onSafeOnly={setDexSafeOnly}
                  />
                </div>
              )}
            </div>
          </aside>

          {/* График */}
          <section className="panel min-h-0 overflow-hidden">
            <ChartPanel
              token={displayedActive}
              chart={displayedChart}
              onRetry={() => void reloadChart()}
              interval={interval}
              onInterval={setInterval}
              chartHeight={380}
              loadOlder={loadOlder}
            />
          </section>

          {/* Портфель и торговля */}
          <aside className="scroll-y min-h-0">
            <SidePanel
              token={displayedActive}
              quoteToken={quoteToken}
              portfolio={portfolio}
              isLoading={portfolioLoading}
              anonymous={anonymous}
              canTrade={panel === 'trade' && selectedGem == null}
              tradeDisabledReason={selectedGem ? 'gems' : undefined}
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
                /*
                 * Прокручивается только список токенов.
                 *
                 * Вкладки, фильтры и пояснение о проверке остаются
                 * на месте: прежде длинный список растягивал страницу,
                 * и чтобы сменить сеть, надо было пролистать шестьдесят
                 * строк обратно наверх.
                 *
                 * Механика включена только для «Рынка»: GEMS
                 * и DexScreener короче и живут по своим правилам.
                 */
                <div className="market-panel-h flex min-h-0 flex-col">
                  <div className="shrink-0 space-y-3 border-b border-border bg-panel p-3">
                    {filters}
                    {addressNotice}
                  </div>
                  {/*
                    Ключ по составу запроса, а не по выбранному токену.

                    Выбор строки меняет `activeId`, но не набор данных:
                    перемонтирование по нему сбрасывало бы позицию
                    прокрутки при каждом нажатии.
                  */}
                  <div key={params.toString()} className="scroll-y min-h-0 flex-1">
                    <TokenList
                      tokens={tokens}
                      activeId={active?.id ?? null}
                      onSelect={selectToken}
                      isLoading={isLoading}
                      touch
                    />
                  </div>
                </div>
              ) : source === 'gems' ? (
                <GemsList onOpenChart={openGemChart} />
              ) : (
                <div className="p-3">
                  <DexScreenerList
                    chain={dexChain}
                    onChain={setDexChain}
                    safeOnly={dexSafeOnly}
                    onSafeOnly={setDexSafeOnly}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'chart' && (
          <>
            {displayedActive && (
              <MobileTokenHeader token={displayedActive} onBack={() => setTab('market')} />
            )}
            <div className="panel overflow-hidden">
              <ChartPanel
                token={displayedActive}
                chart={displayedChart}
                onRetry={() => void reloadChart()}
                interval={interval}
                onInterval={setInterval}
                chartHeight={260}
                showHeader={false}
                loadOlder={loadOlder}
              />
            </div>
            {active && selectedGem == null && (
              <button
                onClick={() => setTab('portfolio')}
                className="btn-primary w-full tap text-sm"
              >
                Купить / Продать
              </button>
            )}
            {active && selectedGem != null && (
              <div className="rounded-lg border border-border bg-raised/50 px-3 py-2 text-center text-xs text-muted">
                Покупка токенов GEMS появится позже
              </div>
            )}
          </>
        )}

        {tab === 'portfolio' && (
          <SidePanel
            token={displayedActive}
            quoteToken={quoteToken}
            portfolio={portfolio}
            isLoading={portfolioLoading}
            anonymous={anonymous}
            canTrade={panel === 'trade' && selectedGem == null}
            tradeDisabledReason={selectedGem ? 'gems' : undefined}
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
 * Три вкладки, а не фильтр внутри одного списка. Разница в том,
 * кто отвечает за состав: «Рынок» собран нами по объёму и проверке,
 * GEMS — необработанный живой OKX Signal, «DexScreener» —
 * оплаченное размещение. Спрятать это различие
 * в выпадающий список значило бы приравнять одно к другому.
 */
const SOURCE_TABS = [
  ['own', 'Рынок'],
  ['gems', 'GEMS'],
  ['dexscreener', 'DexScreener'],
] as const satisfies ReadonlyArray<readonly [MarketSource, string]>;

function SourceTabs({
  value,
  onChange,
}: {
  value: MarketSource;
  onChange: (v: MarketSource) => void;
}) {
  return (
    <TerminalTabs value={value} onChange={onChange} items={SOURCE_TABS} label="Источник списка" />
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
  activeOnly,
  setActiveOnly,
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
  activeOnly: boolean;
  setActiveOnly: (v: boolean) => void;
  checkStatus?: {
    total: number; ok: number; warn: number; blocked: number;
    unchecked: number; stale?: number;
  };
}) {
  const chainOptions = [
    ['', 'Все сети'] as const,
    ...Object.entries(CHAIN_LABEL).map(([k, v]) => [k, v] as const),
  ];

  return (
    <TerminalFilterBar
      search={<TerminalSearchField value={search} onChange={setSearch} />}
      selects={
        <>
          {/* Выпадающие списки вместо ряда кнопок: пять сетей и пять
              сортировок занимали три строки и оставляли списку рынков
              меньше половины панели. */}
          <TerminalSelect value={chain} onChange={setChain} label="Сеть" options={chainOptions} />

          <TerminalSelect
            // Незнакомое значение приводится к объёму: `select`
            // с value вне списка молча показал бы первый вариант,
            // и подпись разошлась бы с тем, что применено на сервере.
            value={SORT_OPTIONS.some(([k]) => k === sort) ? sort : 'volume'}
            onChange={setSort}
            label="Сортировка"
            options={SORT_OPTIONS}
          />
        </>
      }
      chips={
        <TerminalChipRow label="Быстрые фильтры">
          {QUICK_FILTERS.map(([k, label]) => (
            <TerminalFilterChip
              key={k}
              active={sort === k}
              onClick={() => setSort(sort === k ? 'volume' : k)}
            >
              {label}
            </TerminalFilterChip>
          ))}

          {/*
            «Проверенные» сохраняет бирюзовый: это тот же цвет,
            которым размечена безопасность во всём продукте, и здесь
            он несёт смысл, а не отличает кнопку от соседних.
          */}
          <TerminalFilterChip
            active={safeOnly}
            onClick={() => setSafeOnly(!safeOnly)}
            tone="check"
            title="Только токены, прошедшие проверку контракта без замечаний"
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
                className="shrink-0"
              >
                <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
              </svg>
            }
          >
            Проверенные
          </TerminalFilterChip>

          {/*
            «Активные 24ч», а не «24ч».

            Просто «24ч» не отвечает на вопрос, что именно произошло
            за сутки: обновилась котировка, прошла проверка риска
            или отработал импортёр. Здесь речь ровно об одном —
            о торгах на рынке.
          */}
          <TerminalFilterChip
            active={activeOnly}
            onClick={() => setActiveOnly(!activeOnly)}
            title="Есть сделки или заметный объём за последние 24 часа. Время импорта и время проверки риска не учитываются"
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
                className="shrink-0"
              >
                <path d="M4 16l4-6 4 3 4-8 4 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          >
            Активные 24ч
          </TerminalFilterChip>
        </TerminalChipRow>
      }
      notice={
        /* Состояние проверки. Отделено от контролов линией сверху:
           это пояснение к результату, а не ещё один фильтр. */
        checkStatus ? (
        <div className="space-y-1 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted">
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
        ) : null
      }
    />
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

/**
 * Минимальная рыночная карточка GEMS в форму центрального терминала.
 * Risk-поля здесь намеренно пусты: вкладка показывает прямой сигнал
 * OKX и не выдаёт отсутствие нашей проверки за безопасный вердикт.
 */
function terminalTokenFromGem(gem: GemToken): Token {
  if (!gem.id) throw new Error('У сигнала ещё нет токена для графика');

  return {
    id: gem.id,
    symbol: gem.symbol,
    name: gem.name,
    chain: gem.chain,
    address: gem.address,
    priceUsd: gem.priceUsd,
    priceUpdatedAt: gem.priceUpdatedAt,
    priceChange24h: gem.priceChange24h,
    liquidityUsd: gem.liquidityUsd,
    volume24hUsd: gem.volume24hUsd,
    fdvUsd: gem.marketCapUsd,
    riskScore: null,
    logoUrl: gem.logoUrl,
    isVerified: gem.isVerified,
    hasChart: gem.hasChart,
    isQuote: false,
  };
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-muted">Загружаем рынок…</p>}>
      <Terminal />
    </Suspense>
  );
}
