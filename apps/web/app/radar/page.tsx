'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { Requires } from '@/components/Paywall';
import useSWR from 'swr';
import { fetcher, api, fmtUsd, errorMessage } from '@/lib/api';
import { chainLabel } from '@/lib/chains';
import { timeAgo, multipleView } from '@memex/core';
import { Sparkline } from '@/components/Sparkline';
import { LiveSummary, type RadarSummary } from '@/components/radar/LiveSummary';
import {
  RadarFilters,
  MobileFilterBar,
  FilterSheet,
  DEFAULT_FILTERS,
  activeFilterCount,
  type RadarFilterState,
} from '@/components/radar/RadarFilters';
import { FindCard, type RadarEvent } from '@/components/radar/FindCard';
import { FindTable } from '@/components/radar/FindTable';
import { FindDetails } from '@/components/radar/FindDetails';
import { RiskMeter } from '@/components/radar/RiskMeter';

/**
 * Радар.
 *
 * Инструмент отвечает на шесть вопросов подряд, и порядок их задан
 * тем, как человек принимает решение: что нашли, когда, насколько
 * выросло, насколько опасно, почему опасно, куда идти дальше.
 * Всё устройство страницы подчинено этой последовательности.
 *
 * Сверху — живая сводка: она отвечает на «что сейчас происходит»
 * до того, как начнётся чтение карточек, и заодно показывает, жив ли
 * сам радар. Инструмент, называющий себя живым, обязан говорить,
 * когда он последний раз что-то узнал: иначе замерший радар
 * и спокойный рынок выглядят одинаково.
 *
 * Ниже — фильтры одной строкой, потом лента. Два вида ленты, потому
 * что задачи разные: карточка объясняет одну находку, таблица
 * позволяет сравнить сорок.
 */

type Tab = 'radar' | 'gems';
type View = 'cards' | 'table';

function RadarPageContent() {
  const [tab, setTab] = useState<Tab>('radar');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => setIsAdmin(localStorage.getItem('role') === 'ADMIN'), []);

  return (
    <div className="space-y-4">
      {/* ── Заголовок и вкладки ─────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold sm:text-2xl">Радар</h1>
          <p className="text-sm text-muted">Новые токены и что с ними стало дальше</p>
        </div>

        <div className="sticky top-header z-20 flex gap-1 border-b border-border bg-bg">
          {([['radar', 'Находки'], ['gems', 'Результаты']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition-colors ${
                tab === k
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}

          <Link
            href="/radar/alerts"
            className="ml-auto flex items-center gap-1.5 self-center whitespace-nowrap px-2 text-xs text-muted transition-colors hover:text-white"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
            Уведомления
          </Link>
        </div>
      </div>

      {tab === 'radar' ? <Finds isAdmin={isAdmin} /> : <Results />}
    </div>
  );
}

// ──────────────────────────────── Находки ───────────────────────────────────

function Finds({ isAdmin }: { isAdmin: boolean }) {
  const [filters, setFilters] = useState<RadarFilterState>(DEFAULT_FILTERS);
  const [view, setView] = useState<View>('cards');
  const [paused, setPaused] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selected, setSelected] = useState<RadarEvent | null>(null);
  const [showWatch, setShowWatch] = useState(false);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams({ limit: '60', sort: filters.sort });
  if (filters.chain) params.set('chain', filters.chain);
  if (filters.maxRisk !== '') params.set('maxRiskScore', String(filters.maxRisk));
  if (filters.maxAge !== '') params.set('maxAgeHours', String(filters.maxAge));
  if (filters.smartOnly) params.set('smartOnly', 'true');

  const { data, error, isLoading, mutate } = useSWR<any>(`/radar?${params}`, fetcher, {
    // Пауза — не декорация: список, перестраивающийся под курсором
    // в момент нажатия, это способ открыть не тот токен.
    refreshInterval: paused ? 0 : 30_000,
    keepPreviousData: true,
    // Обновление во вкладке, которую не смотрят, не нужно никому,
    // а трафик и работу базы расходует наравне с видимой.
    revalidateOnFocus: true,
    revalidateIfStale: false,
  });

  const events: RadarEvent[] = data?.events ?? [];
  const updatedAt = useUpdatedAt(data);
  const newIds = useNewIds(events);

  return (
    <div className="space-y-4">
      <LiveSummary
        summary={data?.summary as RadarSummary | undefined}
        paused={paused}
        onTogglePause={() => setPaused((v) => !v)}
        updatedAt={updatedAt}
      />

      {/* ── Фильтры: строка на десктопе, две кнопки на телефоне ─── */}
      <div className="hidden lg:block">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <RadarFilters
              value={filters}
              onChange={setFilters}
              sources={data?.sources}
              minLiquidityUsd={data?.minLiquidityUsd}
            />
          </div>
          <ViewSwitch view={view} onChange={setView} />
        </div>
      </div>

      <div className="lg:hidden">
        <MobileFilterBar
          value={filters}
          onChange={setFilters}
          onOpenSheet={() => setSheetOpen(true)}
        />
      </div>

      {isAdmin && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowWatch((v) => !v)} className="btn-ghost text-xs">
            Добавить вручную
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              try {
                await api('/radar/scan', { method: 'POST' });
                mutate();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="btn-ghost text-xs"
          >
            {busy ? 'Сканируем…' : 'Сканировать сейчас'}
          </button>
        </div>
      )}

      {isAdmin && showWatch && <WatchBox onDone={() => mutate()} />}

      {error && (
        <div className="panel space-y-2 border-down/40 p-4">
          <p className="text-sm text-down">{errorMessage(error)}</p>
          <button onClick={() => mutate()} className="btn-ghost text-xs">
            Повторить
          </button>
        </div>
      )}

      {/* ── Лента ──────────────────────────────────────────────── */}
      {isLoading && events.length === 0 ? (
        <CardSkeletons />
      ) : events.length === 0 ? (
        <EmptyState filters={filters} onReset={() => setFilters(DEFAULT_FILTERS)} />
      ) : view === 'table' ? (
        <div className="hidden lg:block">
          <FindTable
            events={events}
            sort={filters.sort}
            onSort={(s) => setFilters({ ...filters, sort: s })}
            onOpen={setSelected}
            activeId={selected?.id ?? null}
          />
        </div>
      ) : null}

      {/* Карточки: на телефоне всегда, на десктопе — когда выбран
          этот вид. Таблица на 390 пикселях нечитаема при любой
          вёрстке, поэтому переключателя там нет вовсе. */}
      {events.length > 0 && (
        <div
          className={`grid gap-3 sm:grid-cols-2 xl:grid-cols-3 ${
            view === 'table' ? 'lg:hidden' : ''
          }`}
        >
          {events.map((e) => (
            <FindCard
              key={e.id}
              event={e}
              isNew={newIds.has(e.id)}
              onOpen={() => setSelected(e)}
            />
          ))}
        </div>
      )}

      <FilterSheet
        open={sheetOpen}
        value={filters}
        onApply={setFilters}
        onClose={() => setSheetOpen(false)}
        minLiquidityUsd={data?.minLiquidityUsd}
      />

      {selected && (
        <div className="panel fixed inset-0 z-50 overflow-hidden lg:inset-y-4 lg:left-auto lg:right-4 lg:w-[420px] lg:rounded-xl lg:border">
          <FindDetails event={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}

/**
 * Отметка времени последнего успешного ответа.
 *
 * Считается на клиенте, а не берётся с сервера: важно, когда данные
 * дошли до этого экрана, а не когда их сформировали. Расхождение
 * бывает заметным при плохой связи, и человеку нужно именно первое.
 */
function useUpdatedAt(data: unknown): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (data) setAt(Date.now());
  }, [data]);
  return at;
}

/**
 * Находки, появившиеся при нас.
 *
 * Помечаются в течение сессии. Мигание и подпрыгивание сознательно
 * не используются: радар смотрят подолгу, и интерфейс, дёргающийся
 * каждые полминуты, читать невозможно.
 */
function useNewIds(events: RadarEvent[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (events.length === 0) return;

    // Первая загрузка целиком новой не считается: иначе вся лента
    // окажется помечена, и метка перестанет что-либо значить.
    if (seen.current === null) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }

    const added = events.filter((e) => !seen.current!.has(e.id)).map((e) => e.id);
    if (added.length === 0) return;

    added.forEach((id) => seen.current!.add(id));
    setFresh((prev) => new Set([...prev, ...added]));

    // Метка снимается через две минуты: «новым» токен остаётся
    // ровно столько, сколько это слово что-то значит.
    const t = setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        added.forEach((id) => next.delete(id));
        return next;
      });
    }, 120_000);

    return () => clearTimeout(t);
  }, [events]);

  return fresh;
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg border border-border p-0.5">
      {(
        [
          ['cards', 'Карточки'],
          ['table', 'Таблица'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
            view === v ? 'bg-raised text-white' : 'text-muted hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function CardSkeletons() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="panel space-y-3 p-4">
          <div className="flex gap-2.5">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-raised" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-20 animate-pulse rounded bg-raised" />
              <div className="h-2.5 w-32 animate-pulse rounded bg-raised/60" />
            </div>
          </div>
          <div className="h-[68px] animate-pulse rounded bg-raised/60" />
          <div className="h-[52px] animate-pulse rounded bg-raised/60" />
          <div className="h-[62px] animate-pulse rounded bg-raised/60" />
        </div>
      ))}
    </div>
  );
}

/**
 * Пустая лента.
 *
 * Различает два случая, и это важнее оформления. «На рынке ничего нет»
 * и «вы отфильтровали всё» требуют разных действий, а выглядят
 * одинаково — пустым экраном.
 */
function EmptyState({
  filters,
  onReset,
}: {
  filters: RadarFilterState;
  onReset: () => void;
}) {
  const count = activeFilterCount(filters);

  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm text-muted">Ничего не найдено</p>

      {count > 0 ? (
        <>
          <p className="max-w-[320px] text-xs leading-relaxed text-muted/70">
            {filters.smartOnly
              ? 'Среди находок пока нет таких, где покупали размеченные кошельки. Разметка накапливается по мере наблюдения за пулами.'
              : `Под ${count} ${count === 1 ? 'фильтр' : 'фильтра'} ничего не попало. Возможно, стоит их ослабить.`}
          </p>
          <button onClick={onReset} className="btn-ghost mt-1 text-xs">
            Сбросить фильтры
          </button>
        </>
      ) : (
        <p className="max-w-[320px] text-xs leading-relaxed text-muted/70">
          Радар проверяет источники каждые три минуты. Новые пулы появляются
          неравномерно: в спокойные часы находок может не быть по часу и дольше.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────── Результаты ─────────────────────────────────

function Results() {
  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<'peak' | 'current' | 'recent'>('peak');
  const [days, setDays] = useState(7);

  const params = new URLSearchParams({ sort, periodDays: String(days), limit: '60' });
  if (chain) params.set('chain', chain);

  const { data, error } = useSWR<any>(`/radar/gems?${params}`, fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  });

  const perf = data?.performance;

  return (
    <div className="space-y-4">
      {perf && perf.total > 0 && (
        <div className="panel p-3 sm:p-4">
          <div className="scroll-x flex gap-6">
            <Stat label="Находок за неделю" value={String(perf.total)} />
            <Stat label="Дошли до 2×" value={`${perf.hitRate2x}%`} tone="up" />
            <Stat label="Дошли до 5×" value={`${perf.hitRate5x}%`} tone="up" />
            <Stat label="Потеряли 80%+" value={`${perf.rugRate}%`} tone="down" />
            <Stat label="Медианный пик" value={`${perf.medianPeak.toFixed(2)}×`} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Доля провалов показывается намеренно. Витрина из одних побед не позволяет
            оценить, чего стоит отдельная находка: без знания, сколько токенов
            обнулилось, кратность ничего не значит.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="scroll-x flex gap-1 text-xs">
          <Chip active={!chain} onClick={() => setChain('')}>Все сети</Chip>
          {(['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const).map((c) => (
            <Chip key={c} active={chain === c} onClick={() => setChain(c)}>
              {chainLabel(c)}
            </Chip>
          ))}
        </div>

        <div className="flex gap-1 text-xs">
          <Chip active={sort === 'peak'} onClick={() => setSort('peak')}>По пику</Chip>
          <Chip active={sort === 'current'} onClick={() => setSort('current')}>По текущей</Chip>
          <Chip active={sort === 'recent'} onClick={() => setSort('recent')}>По времени</Chip>
        </div>

        <div className="flex gap-1 text-xs">
          {[1, 7, 30].map((d) => (
            <Chip key={d} active={days === d} onClick={() => setDays(d)}>
              {d === 1 ? 'сутки' : `${d} дней`}
            </Chip>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-down">{errorMessage(error)}</p>}

      <div className="space-y-2">
        {data?.events?.map((e: RadarEvent) => <ResultRow key={e.id} event={e} />)}
        {data && data.events.length === 0 && (
          <div className="panel px-6 py-16 text-center">
            <p className="text-sm text-muted">
              Пока нет находок, выросших больше чем в полтора раза
            </p>
            <p className="mt-1 text-xs text-muted/70">
              Результаты появляются по мере наблюдения
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({ event: e }: { event: RadarEvent }) {
  const mv = multipleView(e.currentMultiple, e.peakMultiple);
  const from = Number((e as any).mcapAtSignalUsd ?? 0);
  const to = Number((e as any).currentMcapUsd ?? 0);

  return (
    <div className="panel flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{e.symbol}</span>
          <span className="truncate text-xs text-muted">{e.name}</span>
          <span className="rounded bg-border px-1.5 py-0.5 text-[10px] text-muted">
            {chainLabel(e.chain)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{timeAgo(e.firstSeenAt)}</span>
          <span>·</span>
          <span className="num">{fmtUsd(from)}</span>
          <span className={to >= from ? 'text-up' : 'text-down'}>→</span>
          <span className={`num ${to >= from ? 'text-up' : 'text-down'}`}>{fmtUsd(to)}</span>
        </div>
      </div>

      <div className="w-24 shrink-0">
        <Sparkline points={e.points} height={32} />
      </div>

      <div className="shrink-0 text-right">
        <div className="num text-sm">{mv.peak}</div>
        <div className={`num text-[11px] ${mv.isUp ? 'text-muted' : 'text-down'}`}>
          сейчас {mv.meaningful ? mv.currentPct : '—'}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────── Ручное добавление ─────────────────────────────────

/**
 * Ручное добавление находок.
 *
 * Нужно потому, что автоматически читать чужие закрытые ленты нельзя:
 * это нарушает условия площадок и ломается молча — лента просто
 * перестаёт обновляться, без ошибки в логах. Здесь человек смотрит
 * своими глазами и вставляет то, что счёл нужным, а дальше находка
 * идёт обычным путём.
 */
function WatchBox({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api('/radar/watch', { method: 'POST', body: JSON.stringify({ text }) });
      setResult(r);
      setText('');
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось добавить'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">Добавить токены под наблюдение</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Вставьте адреса или ссылки — можно вперемешку и списком. Сеть определяется
          сама: для Solana по виду адреса, для EVM перебором, поскольку один адрес
          существует сразу в нескольких сетях.
        </p>
      </div>

      <textarea
        className="input h-24 font-mono text-xs"
        placeholder={'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\nhttps://dexscreener.com/base/0x…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={busy || !text.trim()} className="btn-ghost text-xs">
          {busy ? 'Проверяем…' : 'Добавить'}
        </button>
        <span className="text-xs text-muted">
          Ручная находка проходит те же проверки, что автоматическая
        </span>
      </div>

      {error && <p className="text-xs text-down">{error}</p>}

      {result && (
        <div className="space-y-1 rounded bg-bg p-2.5 text-xs">
          <p>
            Добавлено: <span className="num text-up">{result.added}</span>
            {result.existed > 0 && (
              <> · уже под наблюдением: <span className="num">{result.existed}</span></>
            )}
          </p>
          {result.notFound?.length > 0 && (
            <div className="text-muted">
              {result.notFound.map((n: any) => (
                <p key={n.address} className="truncate">
                  <span className="num">{n.address.slice(0, 10)}…</span> — {n.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Мелочи ─────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="shrink-0">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={`num ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 transition-colors ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-raised hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Обёртка доступа.
 *
 * Содержимое страницы не меняется: закрывается она целиком, снаружи.
 * Так проверка стоит в одном месте, а не растекается по каждому
 * запросу внутри, и её нельзя случайно потерять при правке разметки.
 *
 * Решение принимает сервер: даже если обёртка ошибётся и пропустит,
 * запросы внутри вернут 403.
 */
export default function RadarPage() {
  return (
    <Requires capability="RADAR_ACCESS" title="Радар находок">
      <RadarPageContent />
    </Requires>
  );
}
