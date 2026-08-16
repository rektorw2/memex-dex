'use client';

import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { fetcher, fmtUsd, errorMessage } from '@/lib/api';
import { chainLabel } from '@/lib/chains';
import { timeAgo, CATEGORY_LABELS, MEDIUM_CONFIDENCE_TRADES, type WalletCategory } from '@memex/core';
import {
  WalletTable,
  WalletCard,
  categoryOf,
  type Wallet,
} from '@/components/wallets/WalletViews';
import { WalletDrawer } from '@/components/wallets/WalletDrawer';
import { ScoreMethodology } from '@/components/wallets/ScoreMethodology';
import { ActivityFeed } from '@/components/wallets/ActivityFeed';

/**
 * Смарт-кошельки.
 *
 * Страница отвечает на шесть вопросов подряд, и порядок их задан тем,
 * как человек решает, стоит ли за кошельком следить: что это за
 * кошелёк, почему он считается умным, насколько надёжна оценка, какие
 * результаты, когда он был активен, что делать дальше.
 *
 * Ключевое решение всей страницы — оценка и уверенность в ней
 * показываются раздельно. Смешать их в одно число нельзя: тогда
 * либо удачливый новичок с одной сделкой на десять концов выглядит
 * мастером, либо мастер занижен из-за короткой истории. Разница
 * между «хорошие результаты» и «этому можно верить» здесь видна
 * в каждой строке.
 *
 * Методика расчёта убрана в отдельное окно. Прежде она висела
 * абзацем над списком: место занимала постоянно, читалась один раз,
 * и отодвигала вниз то, ради чего страницу открывают.
 */

type Tab = 'wallets' | 'activity' | 'following';

export default function WalletsPage() {
  const [tab, setTab] = useState<Tab>('wallets');
  const [methodOpen, setMethodOpen] = useState(false);

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold sm:text-2xl">Смарт-кошельки</h1>
          <p className="max-w-[62ch] text-sm leading-relaxed text-muted">
            Отслеживаем кошельки, которые рано находят перспективные токены
            и показывают стабильные результаты
          </p>
        </div>

        {/* Прокрутка вместо обрезания: три вкладки и ссылка
            не помещаются в 390 пикселей, и «Как считается рейтинг?»
            уезжала за край без всякого признака, что она там есть. */}
        <div className="scroll-x sticky top-header z-20 flex gap-1 border-b border-border bg-bg">
          {(
            [
              ['wallets', 'Кошельки'],
              ['activity', 'Активность'],
              ['following', 'Мои подписки'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition-colors ${
                tab === k
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}

          <button
            onClick={() => setMethodOpen(true)}
            className="ml-auto shrink-0 self-center whitespace-nowrap px-2 text-xs text-muted transition-colors hover:text-white"
          >
            Как считается рейтинг?
          </button>
        </div>
      </header>

      {tab === 'wallets' && <WalletsTab />}
      {tab === 'activity' && <ActivityFeed />}
      {tab === 'following' && <FollowingTab />}

      <PageDisclaimer />

      <ScoreMethodology open={methodOpen} onClose={() => setMethodOpen(false)} />
    </div>
  );
}

// ──────────────────────────────── Кошельки ──────────────────────────────────

interface Filters {
  search: string;
  chain: string;
  category: WalletCategory | '';
  minScore: number | '';
  minTrades: number | '';
  growthOnly: boolean;
  sort: string;
}

const DEFAULT_FILTERS: Filters = {
  search: '',
  chain: '',
  category: '',
  minScore: '',
  minTrades: '',
  growthOnly: false,
  sort: 'score',
};

const SORTS: Array<[string, string]> = [
  ['score', 'По Smart Score'],
  ['winrate', 'По успешности'],
  ['avg', 'По среднему росту'],
  ['volume', 'По объёму покупок'],
  ['active', 'По последней активности'],
  ['trades', 'По количеству сделок'],
];

function countActive(f: Filters): number {
  let n = 0;
  if (f.search.trim()) n++;
  if (f.chain) n++;
  if (f.category) n++;
  if (f.minScore !== '') n++;
  if (f.minTrades !== '') n++;
  if (f.growthOnly) n++;
  return n;
}

function WalletsTab() {
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Wallet | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const params = new URLSearchParams({ limit: '100', label: 'any' });
  if (f.chain) params.set('chain', f.chain);

  const { data, error, isLoading } = useSWR<any>(`/wallets/top?${params}`, fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  });

  const all: Wallet[] = data?.wallets ?? [];

  /**
   * Фильтрация и сортировка на клиенте.
   *
   * Список кошельков — это сотня записей, а не десятки тысяч: гонять
   * за каждым изменением фильтра запрос к серверу здесь дороже,
   * чем отфильтровать на месте. Как только счёт пойдёт на тысячи,
   * это придётся перенести на сервер — но не раньше.
   */
  const wallets = useMemo(() => {
    const q = f.search.trim().toLowerCase();

    const filtered = all.filter((w) => {
      if (q && !w.address.toLowerCase().includes(q) && !(w.knownAs ?? '').toLowerCase().includes(q))
        return false;
      if (f.category && categoryOf(w) !== f.category) return false;
      if (f.minScore !== '' && (w.score ?? -1) < f.minScore) return false;
      if (f.minTrades !== '' && (w.settled ?? w.tokensBought ?? 0) < f.minTrades) return false;
      if (f.growthOnly && (w.wins2x ?? 0) < 1) return false;
      return true;
    });

    const num = (v: unknown) => (v == null ? -1 : Number(v));

    return [...filtered].sort((a, b) => {
      switch (f.sort) {
        case 'winrate': {
          const ra = (a.wins2x ?? 0) / Math.max(1, a.settled ?? a.tokensBought ?? 1);
          const rb = (b.wins2x ?? 0) / Math.max(1, b.settled ?? b.tokensBought ?? 1);
          return rb - ra;
        }
        case 'avg':
          return num(b.avgPeakMultiple) - num(a.avgPeakMultiple);
        case 'volume':
          return num(b.volumeUsd) - num(a.volumeUsd);
        case 'trades':
          return (b.settled ?? b.tokensBought ?? 0) - (a.settled ?? a.tokensBought ?? 0);
        case 'active':
          return (
            new Date(b.lastActiveAt ?? 0).getTime() - new Date(a.lastActiveAt ?? 0).getTime()
          );
        default:
          // Без оценки — всегда вниз: непроверенное не должно
          // соседствовать с проверенным в верху списка.
          return (b.score ?? -1) - (a.score ?? -1);
      }
    });
  }, [all, f]);

  const active = countActive(f);

  return (
    <div className="space-y-4">
      <Kpis coverage={data?.coverage} wallets={all} />

      {/* ── Фильтры ────────────────────────────────────────────── */}
      <div className="hidden lg:block">
        <DesktopFilters value={f} onChange={setF} count={active} />
      </div>

      <div className="space-y-2 lg:hidden">
        <SearchField value={f.search} onChange={(search) => setF({ ...f, search })} />
        <div className="flex gap-2">
          <button
            onClick={() => setSheetOpen(true)}
            className="tap flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm"
          >
            Фильтры
            {active > 0 && (
              <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] text-white">
                {active}
              </span>
            )}
          </button>
          <button
            onClick={() => setSheetOpen(true)}
            className="tap flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm"
          >
            <span className="truncate">
              {SORTS.find(([v]) => v === f.sort)?.[1] ?? 'Сортировка'}
            </span>
          </button>
        </div>
        <ActiveChips value={f} onChange={setF} />
      </div>

      {error && <p className="panel border-down/40 p-4 text-sm text-down">{errorMessage(error)}</p>}

      {/* ── Список ─────────────────────────────────────────────── */}
      {isLoading && all.length === 0 ? (
        <Skeletons />
      ) : wallets.length === 0 ? (
        <Empty
          hasFilters={active > 0}
          total={all.length}
          onReset={() => setF(DEFAULT_FILTERS)}
        />
      ) : (
        <>
          <div className="hidden lg:block">
            <WalletTable
              wallets={wallets}
              sort={f.sort}
              onSort={(s) => setF({ ...f, sort: s })}
              onOpen={setSelected}
            />
          </div>

          <div className="space-y-3 lg:hidden">
            {wallets.map((w) => (
              <WalletCard key={`${w.chain}:${w.address}`} wallet={w} onOpen={setSelected} />
            ))}
          </div>
        </>
      )}

      <FilterSheet
        open={sheetOpen}
        value={f}
        onApply={setF}
        onClose={() => setSheetOpen(false)}
      />

      {selected && <WalletDrawer wallet={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ─────────────────────────────── Сводка ─────────────────────────────────────

function Kpis({ coverage, wallets }: { coverage?: any; wallets: Wallet[] }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), [wallets]);

  if (!coverage) {
    return (
      <div className="panel flex h-[62px] items-center gap-6 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-3 w-20 animate-pulse rounded bg-raised" />
        ))}
      </div>
    );
  }

  const dayAgo = Date.now() - 864e5;
  const active24h = wallets.filter(
    (w) => w.lastActiveAt && new Date(w.lastActiveAt).getTime() > dayAgo,
  ).length;

  return (
    <div className="panel scroll-x flex items-center gap-6 px-4 py-2.5">
      <Kpi label="Отслеживается" value={String(coverage.walletsKnown ?? 0)} />
      <Kpi label="Получили оценку" value={String(coverage.walletsScored ?? 0)} tone="up" />
      <Kpi label="Активны за 24ч" value={String(active24h)} />
      <Kpi
        label="Порог оценки"
        value={`${coverage.minTradesForScore ?? MEDIUM_CONFIDENCE_TRADES} сделок`}
      />

      <div className="ml-auto shrink-0 text-right">
        <div className="flex items-center justify-end gap-1.5 text-[11px]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" aria-hidden />
          <span className="text-up">Live</span>
        </div>
        <div className="text-[11px] text-muted/70">
          {now ? `обновлено ${timeAgo(new Date(now))}` : 'ожидаем данные'}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'up' }) {
  return (
    <div className="shrink-0">
      <div className="text-[11px] leading-tight text-muted">{label}</div>
      <div className={`num text-sm leading-tight ${tone === 'up' ? 'text-up' : ''}`}>{value}</div>
    </div>
  );
}

// ─────────────────────────────── Фильтры ────────────────────────────────────

function DesktopFilters({
  value: f,
  onChange,
  count,
}: {
  value: Filters;
  onChange: (v: Filters) => void;
  count: number;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });

  return (
    <div className="space-y-2.5">
      <div className="scroll-x flex gap-1.5">
        <Chip active={!f.chain} onClick={() => set({ chain: '' })}>Все сети</Chip>
        {(['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const).map((c) => (
          <Chip key={c} active={f.chain === c} onClick={() => set({ chain: c })}>
            {chainLabel(c)}
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={f.search} onChange={(search) => set({ search })} desktop />

        <Select
          value={f.category}
          onChange={(v) => set({ category: v as WalletCategory | '' })}
          options={[
            ['', 'Все категории'],
            ['whale', CATEGORY_LABELS.whale],
            ['early', CATEGORY_LABELS.early],
            ['steady', CATEGORY_LABELS.steady],
            ['new', CATEGORY_LABELS.new],
          ]}
        />

        <Select
          value={String(f.minScore)}
          onChange={(v) => set({ minScore: v === '' ? '' : Number(v) })}
          options={[
            ['', 'Любой Smart Score'],
            ['40', 'От 40'],
            ['60', 'От 60'],
            ['80', 'От 80'],
          ]}
        />

        <Select
          value={String(f.minTrades)}
          onChange={(v) => set({ minTrades: v === '' ? '' : Number(v) })}
          options={[
            ['', 'Любая выборка'],
            ['5', 'От 5 сделок'],
            ['15', 'От 15 сделок'],
            ['30', 'От 30 сделок'],
          ]}
        />

        <Select
          value={f.sort}
          onChange={(sort) => set({ sort })}
          options={SORTS}
        />

        {/* Отдельным переключателем, а не пунктом в списке категорий:
            «с историей роста» — это свойство, которое сочетается
            с любой категорией, а не альтернатива им. */}
        <button
          onClick={() => set({ growthOnly: !f.growthOnly })}
          title="Только кошельки, у которых была хотя бы одна сделка с ростом вдвое"
          className={`h-10 rounded-lg border px-3 text-xs transition-colors ${
            f.growthOnly
              ? 'border-up/40 bg-up/10 text-up'
              : 'border-border text-muted hover:text-white'
          }`}
        >
          С историей роста
        </button>

        {count > 0 && (
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: f.sort })}
            className="h-10 rounded-lg px-2.5 text-xs text-muted transition-colors hover:text-white"
          >
            Сбросить ({count})
          </button>
        )}
      </div>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  desktop,
}: {
  value: string;
  onChange: (v: string) => void;
  desktop?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Поиск по адресу или названию"
      className={`rounded-lg border border-border bg-panel px-3 text-xs outline-none transition-colors placeholder:text-muted/70 focus:border-accent ${
        desktop ? 'h-10 w-[220px]' : 'h-11 w-full text-sm'
      }`}
    />
  );
}

function ActiveChips({ value: f, onChange }: { value: Filters; onChange: (v: Filters) => void }) {
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });
  const chips: Array<[string, () => void]> = [];

  if (f.chain) chips.push([chainLabel(f.chain), () => set({ chain: '' })]);
  if (f.category) chips.push([CATEGORY_LABELS[f.category], () => set({ category: '' })]);
  if (f.minScore !== '') chips.push([`Score от ${f.minScore}`, () => set({ minScore: '' })]);
  if (f.minTrades !== '') chips.push([`От ${f.minTrades} сделок`, () => set({ minTrades: '' })]);
  if (f.growthOnly) chips.push(['С историей роста', () => set({ growthOnly: false })]);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map(([label, remove]) => (
        <span
          key={label}
          className="flex items-center gap-1 rounded-full border border-border bg-raised py-1 pl-2.5 pr-1 text-[11px]"
        >
          {label}
          <button onClick={remove} aria-label="Убрать фильтр" className="px-1 text-muted">
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

function FilterSheet({
  open,
  value,
  onApply,
  onClose,
}: {
  open: boolean;
  value: Filters;
  onApply: (v: Filters) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const set = (patch: Partial<Filters>) => setDraft({ ...draft, ...patch });

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Фильтры">
      <button className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Закрыть" />

      <div className="safe-bottom absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-border bg-panel">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-panel px-4 py-3">
          <span className="text-sm font-medium">Фильтры</span>
          <button onClick={onClose} className="tap px-2 text-sm text-muted">Закрыть</button>
        </div>

        <div className="space-y-5 p-4">
          <Group label="Сеть">
            <Options
              options={[['', 'Все сети'], ['SOLANA', 'Solana'], ['BNB', 'BNB Chain'], ['BASE', 'Base'], ['ETHEREUM', 'Ethereum']]}
              value={draft.chain}
              onSelect={(v) => set({ chain: v })}
            />
          </Group>

          <Group label="Категория">
            <Options
              options={[
                ['', 'Все'],
                ['whale', CATEGORY_LABELS.whale],
                ['early', CATEGORY_LABELS.early],
                ['steady', CATEGORY_LABELS.steady],
                ['new', CATEGORY_LABELS.new],
              ]}
              value={draft.category}
              onSelect={(v) => set({ category: v as WalletCategory | '' })}
            />
          </Group>

          <Group label="Минимальный Smart Score">
            <Options
              options={[['', 'Любой'], ['40', '40'], ['60', '60'], ['80', '80']]}
              value={String(draft.minScore)}
              onSelect={(v) => set({ minScore: v === '' ? '' : Number(v) })}
            />
          </Group>

          <Group label="Размер выборки">
            <Options
              options={[['', 'Любая'], ['5', 'От 5'], ['15', 'От 15'], ['30', 'От 30']]}
              value={String(draft.minTrades)}
              onSelect={(v) => set({ minTrades: v === '' ? '' : Number(v) })}
            />
          </Group>

          <Group label="История роста">
            <button
              onClick={() => set({ growthOnly: !draft.growthOnly })}
              className={`tap w-full rounded-lg border px-3 py-3 text-left text-sm ${
                draft.growthOnly ? 'border-up/40 bg-up/10 text-up' : 'border-border text-muted'
              }`}
            >
              Только с хотя бы одной сделкой ≥2×
            </button>
          </Group>

          <Group label="Сортировка">
            <Options options={SORTS} value={draft.sort} onSelect={(v) => set({ sort: v })} />
          </Group>
        </div>

        <div className="safe-bottom sticky bottom-0 flex gap-2 border-t border-border bg-panel p-4">
          <button
            onClick={() => setDraft({ ...DEFAULT_FILTERS, sort: draft.sort })}
            className="tap h-11 flex-1 rounded-lg border border-border text-sm text-muted"
          >
            Сбросить
          </button>
          <button
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className="tap h-11 flex-[2] rounded-lg bg-accent text-sm font-medium text-white"
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Прочие вкладки ──────────────────────────────────

function FollowingTab() {
  return (
    <div className="panel px-6 py-16 text-center">
      <p className="text-sm text-muted">Подписки ещё не подключены</p>
      <p className="mx-auto mt-2 max-w-[380px] text-xs leading-relaxed text-muted/70">
        Слежение за кошельком и уведомления о его сделках требуют привязки
        к аккаунту. Пока следить можно через раздел «Копитрейдинг».
      </p>
    </div>
  );
}

// ─────────────────────────────── Состояния ──────────────────────────────────

function Skeletons() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="panel flex items-center gap-3 p-4">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-raised" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-32 animate-pulse rounded bg-raised" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-raised/60" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

function Empty({
  hasFilters,
  total,
  onReset,
}: {
  hasFilters: boolean;
  total: number;
  onReset: () => void;
}) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm text-muted">Ничего не найдено</p>
      {hasFilters ? (
        <>
          <p className="max-w-[340px] text-xs leading-relaxed text-muted/70">
            Под текущие фильтры не попал ни один из {total} кошельков.
          </p>
          <button onClick={onReset} className="btn-ghost mt-1 text-xs">
            Сбросить фильтры
          </button>
        </>
      ) : (
        <p className="max-w-[340px] text-xs leading-relaxed text-muted/70">
          Кошельки размечаются по мере наблюдения за пулами. Оценка появляется
          после {MEDIUM_CONFIDENCE_TRADES} завершённых сделок — до этого судить не о чем.
        </p>
      )}
    </div>
  );
}

/**
 * Предупреждение о рисках.
 *
 * Внизу и приглушённо, но не спрятано. Наверху страницы оно занимало бы
 * место того, ради чего страницу открывают, и от этого читалось бы
 * не лучше, а хуже: предупреждение, которое каждый раз приходится
 * пролистывать, перестаёт восприниматься вовсе.
 */
function PageDisclaimer() {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-border pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-muted/70 transition-colors hover:text-muted"
      >
        Риски и условия
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <p className="mt-2 max-w-[70ch] text-[11px] leading-relaxed text-muted/70">
          Прошлые результаты кошелька не предсказывают будущие. Оценка считается
          по наблюдаемым сделкам и описывает то, что уже произошло, а не то, что
          произойдёт. Кошелёк с высокой оценкой может потерять всё на следующей
          покупке. Повторение чужих сделок не снижает риск, а переносит его
          на вас: вы входите позже и по другой цене.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────── Мелочи ─────────────────────────────────────

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-[180px] cursor-pointer appearance-none rounded-lg border border-border bg-panel px-3 text-xs text-white outline-none transition-colors hover:border-border/80 focus:border-accent xl:w-[200px]"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
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
      className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-raised hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted">{label}</div>
      {children}
    </div>
  );
}

function Options({
  options,
  value,
  onSelect,
}: {
  options: Array<[string, string]>;
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          onClick={() => onSelect(v)}
          className={`tap rounded-lg border px-3 py-2 text-xs transition-colors ${
            value === v ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
