'use client';

import { useEffect, useState } from 'react';
import { chainLabel } from '@/lib/chains';
import { fmtUsd } from '@/lib/api';

/**
 * Фильтры радара.
 *
 * На десктопе — одна компактная строка. Прежние выпадающие списки
 * растягивались во всю ширину страницы: при трёх элементах это давало
 * три поля по четыреста пикселей, между которыми глазу нечего делать.
 * Ширина в двести — та, при которой название варианта помещается,
 * а строка остаётся строкой.
 *
 * На телефоне — две кнопки и шторка снизу. Втискивать шесть элементов
 * управления в триста девяносто пикселей бессмысленно: они станут
 * по пятьдесят пикселей каждый и промахиваться по ним будут чаще,
 * чем попадать.
 *
 * Счётчик активных фильтров есть в обоих случаях. Без него человек,
 * не нашедший ничего, не понимает — на рынке пусто или он сам
 * отфильтровал всё лишнее ещё вчера.
 */

export interface RadarFilterState {
  chain: string;
  maxRisk: number | '';
  maxAge: number | '';
  smartOnly: boolean;
  sort: string;
}

export const DEFAULT_FILTERS: RadarFilterState = {
  chain: '',
  maxRisk: '',
  maxAge: '',
  smartOnly: false,
  sort: 'recent',
};

export const SORT_OPTIONS: Array<[string, string]> = [
  ['recent', 'Сначала новые'],
  ['growth', 'По росту'],
  ['liquidity', 'По ликвидности'],
  ['risk', 'По риску'],
  ['holders', 'По держателям'],
];

const RISK_OPTIONS: Array<[number | '', string]> = [
  ['', 'Любой риск'],
  [29, 'Только низкий'],
  [59, 'До среднего'],
  [79, 'До высокого'],
];

const AGE_OPTIONS: Array<[number | '', string]> = [
  ['', 'Любой возраст'],
  [1, 'До часа'],
  [6, 'До 6 часов'],
  [24, 'До суток'],
];

export const CHAIN_OPTIONS = ['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const;

export function activeFilterCount(f: RadarFilterState): number {
  // Сортировка фильтром не считается: она меняет порядок, а не состав,
  // и включать её в счётчик значило бы пугать человека несуществующим
  // ограничением.
  let n = 0;
  if (f.chain) n++;
  if (f.maxRisk !== '') n++;
  if (f.maxAge !== '') n++;
  if (f.smartOnly) n++;
  return n;
}

// ─────────────────────────── Десктоп ────────────────────────────────────────

export function RadarFilters({
  value,
  onChange,
  sources,
  minLiquidityUsd,
}: {
  value: RadarFilterState;
  onChange: (next: RadarFilterState) => void;
  sources?: { okx?: boolean };
  minLiquidityUsd?: string | number | null;
}) {
  const set = (patch: Partial<RadarFilterState>) => onChange({ ...value, ...patch });
  const count = activeFilterCount(value);

  return (
    <div className="space-y-2.5">
      {/* Сети остаются чипами: их пять, они постоянны и переключаются
          чаще всего — прятать их в список значит добавлять нажатие
          к самому частому действию. */}
      <div className="scroll-x flex gap-1.5">
        <ChainChip active={!value.chain} onClick={() => set({ chain: '' })}>
          Все сети
        </ChainChip>
        {CHAIN_OPTIONS.map((c) => (
          <ChainChip key={c} active={value.chain === c} onClick={() => set({ chain: c })}>
            {chainLabel(c)}
          </ChainChip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          label="Риск"
          value={String(value.maxRisk)}
          onChange={(v) => set({ maxRisk: v === '' ? '' : Number(v) })}
          options={RISK_OPTIONS.map(([v, l]) => [String(v), l])}
        />

        <Select
          label="Возраст"
          value={String(value.maxAge)}
          onChange={(v) => set({ maxAge: v === '' ? '' : Number(v) })}
          options={AGE_OPTIONS.map(([v, l]) => [String(v), l])}
        />

        <Select
          label="Сортировка"
          value={value.sort}
          onChange={(v) => set({ sort: v })}
          options={SORT_OPTIONS}
        />

        <button
          onClick={() => set({ smartOnly: !value.smartOnly })}
          title="Только находки, которые покупали кошельки с подтверждённой историей"
          className={`h-10 rounded-lg border px-3 text-xs transition-colors ${
            value.smartOnly
              ? 'border-up/40 bg-up/10 text-up'
              : 'border-border text-muted hover:text-white'
          }`}
        >
          Smart Money
        </button>

        {count > 0 && (
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: value.sort })}
            className="h-10 rounded-lg px-2.5 text-xs text-muted transition-colors hover:text-white"
          >
            Сбросить ({count})
          </button>
        )}

        <SourceNote sources={sources} minLiquidityUsd={minLiquidityUsd} />
      </div>
    </div>
  );
}

/**
 * Источник и порог ликвидности.
 *
 * Нужны, но не в первом ряду: это свойство инструмента, а не решение
 * пользователя. Показываются приглушённо и с пояснением — без него
 * «порог $20K» читается как настройка, которую забыли сделать
 * изменяемой.
 */
function SourceNote({
  sources,
  minLiquidityUsd,
}: {
  sources?: { okx?: boolean };
  minLiquidityUsd?: string | number | null;
}) {
  if (!sources) return null;

  return (
    <span
      className="ml-auto hidden cursor-help items-center gap-1 text-[11px] text-muted/70 lg:flex"
      title={
        'Радар опрашивает источники каждые три минуты и берёт пулы, ' +
        'ликвидность которых выше порога. Пулы мельче в ленту не попадают: ' +
        'выйти из такой позиции без обвала цены нельзя.'
      }
    >
      {sources.okx ? 'OKX + GeckoTerminal' : 'GeckoTerminal'}
      {minLiquidityUsd != null && <> · от {fmtUsd(minLiquidityUsd)}</>}
      <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-muted/40 text-[9px]">
        ?
      </span>
    </span>
  );
}

// ─────────────────────────── Телефон ────────────────────────────────────────

export function MobileFilterBar({
  value,
  onChange,
  onOpenSheet,
}: {
  value: RadarFilterState;
  onChange: (next: RadarFilterState) => void;
  onOpenSheet: () => void;
}) {
  const set = (patch: Partial<RadarFilterState>) => onChange({ ...value, ...patch });
  const count = activeFilterCount(value);
  const sortLabel = SORT_OPTIONS.find(([v]) => v === value.sort)?.[1] ?? 'Сортировка';

  return (
    <div className="space-y-2">
      <div className="scroll-x flex gap-1.5">
        <ChainChip active={!value.chain} onClick={() => set({ chain: '' })}>
          Все сети
        </ChainChip>
        {CHAIN_OPTIONS.map((c) => (
          <ChainChip key={c} active={value.chain === c} onClick={() => set({ chain: c })}>
            {chainLabel(c)}
          </ChainChip>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onOpenSheet}
          className="tap flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm"
        >
          Фильтры
          {count > 0 && (
            <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] text-white">
              {count}
            </span>
          )}
        </button>

        <button
          onClick={onOpenSheet}
          className="tap flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm"
        >
          <span className="truncate">{sortLabel}</span>
        </button>
      </div>

      {/* Активные фильтры плашками: снять фильтр должно быть так же
          легко, как поставить, и без открытия шторки. */}
      {count > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.chain && (
            <ActiveChip onRemove={() => set({ chain: '' })}>{chainLabel(value.chain)}</ActiveChip>
          )}
          {value.maxRisk !== '' && (
            <ActiveChip onRemove={() => set({ maxRisk: '' })}>
              {RISK_OPTIONS.find(([v]) => v === value.maxRisk)?.[1]}
            </ActiveChip>
          )}
          {value.maxAge !== '' && (
            <ActiveChip onRemove={() => set({ maxAge: '' })}>
              {AGE_OPTIONS.find(([v]) => v === value.maxAge)?.[1]}
            </ActiveChip>
          )}
          {value.smartOnly && (
            <ActiveChip onRemove={() => set({ smartOnly: false })}>Smart Money</ActiveChip>
          )}
        </div>
      )}
    </div>
  );
}

/** Шторка снизу со всеми фильтрами. */
export function FilterSheet({
  open,
  value,
  onApply,
  onClose,
  minLiquidityUsd,
}: {
  open: boolean;
  value: RadarFilterState;
  onApply: (next: RadarFilterState) => void;
  onClose: () => void;
  minLiquidityUsd?: string | number | null;
}) {
  const [draft, setDraft] = useState(value);

  // Черновик подхватывает внешние изменения только при открытии:
  // иначе обновление ленты в фоне сбрасывало бы то, что человек
  // уже выбрал, но ещё не применил.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  // Прокрутка страницы под открытой шторкой — источник ощущения
  // сломанности: палец двигает не то, что под ним.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const set = (patch: Partial<RadarFilterState>) => setDraft({ ...draft, ...patch });

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Фильтры">
      <button
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="Закрыть фильтры"
      />

      <div className="safe-bottom absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-border bg-panel">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-panel px-4 py-3">
          <span className="text-sm font-medium">Фильтры</span>
          <button onClick={onClose} className="tap px-2 text-sm text-muted">
            Закрыть
          </button>
        </div>

        <div className="space-y-5 p-4">
          <Group label="Сеть">
            <div className="flex flex-wrap gap-1.5">
              <ChainChip active={!draft.chain} onClick={() => set({ chain: '' })}>
                Все сети
              </ChainChip>
              {CHAIN_OPTIONS.map((c) => (
                <ChainChip key={c} active={draft.chain === c} onClick={() => set({ chain: c })}>
                  {chainLabel(c)}
                </ChainChip>
              ))}
            </div>
          </Group>

          <Group label="Уровень риска">
            <OptionRow
              options={RISK_OPTIONS}
              value={draft.maxRisk}
              onSelect={(v) => set({ maxRisk: v })}
            />
          </Group>

          <Group label="Возраст токена">
            <OptionRow
              options={AGE_OPTIONS}
              value={draft.maxAge}
              onSelect={(v) => set({ maxAge: v })}
            />
          </Group>

          <Group label="Smart Money">
            <button
              onClick={() => set({ smartOnly: !draft.smartOnly })}
              className={`tap flex w-full items-center justify-between rounded-lg border px-3 py-3 text-sm ${
                draft.smartOnly ? 'border-up/40 bg-up/10 text-up' : 'border-border text-muted'
              }`}
            >
              Только с покупками размеченных кошельков
              <span
                className={`h-5 w-9 rounded-full transition-colors ${
                  draft.smartOnly ? 'bg-up' : 'bg-border'
                } relative`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    draft.smartOnly ? 'left-4.5' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
          </Group>

          <Group label="Сортировка">
            <OptionRow
              options={SORT_OPTIONS.map(([v, l]) => [v, l] as [string, string])}
              value={draft.sort}
              onSelect={(v) => set({ sort: String(v) })}
            />
          </Group>

          {minLiquidityUsd != null && (
            <p className="text-[11px] leading-relaxed text-muted">
              Порог ликвидности {fmtUsd(minLiquidityUsd)} задан для всего радара. Пулы мельче
              в ленту не попадают: выйти из такой позиции без обвала цены нельзя.
            </p>
          )}
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

// ─────────────────────────── Мелочи ─────────────────────────────────────────

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-[180px] cursor-pointer appearance-none rounded-lg border border-border bg-panel pl-3 pr-8 text-xs text-white outline-none transition-colors hover:border-border/80 focus:border-accent focus:ring-1 focus:ring-accent/40 xl:w-[200px]"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden
      >
        <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    </label>
  );
}

function ChainChip({
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

function ActiveChip({ onRemove, children }: { onRemove: () => void; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-border bg-raised py-1 pl-2.5 pr-1 text-[11px]">
      {children}
      <button onClick={onRemove} aria-label="Убрать фильтр" className="px-1 text-muted">
        ✕
      </button>
    </span>
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

function OptionRow<T extends string | number>({
  options,
  value,
  onSelect,
}: {
  options: Array<[T | '', string]>;
  value: T | '';
  onSelect: (v: T | '') => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button
          key={String(v)}
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
