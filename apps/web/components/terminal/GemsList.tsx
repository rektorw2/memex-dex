'use client';

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import useSWR from 'swr';
import { okxSignalPerformance } from '@memex/core';
import { TokenLogo } from '@/components/TokenLogo';
import { fetcher, fmtPct, fmtPrice, fmtUsd } from '@/lib/api';
import { chainLabel } from '@/lib/chains';
import { useTokenFavorites } from '@/lib/token-favorites';

export interface GemToken {
  id: string | null;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  priceUsd: string | null;
  priceChange24h: string | null;
  priceUpdatedAt: string | null;
  marketCapUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  holders: number | null;
  hasChart: boolean;
  isVerified: boolean;
}

interface GemSignal {
  id: string;
  providerKey: string;
  signaledAt: string;
  receivedAt: string;
  walletTypes: string[];
  triggerWalletCount: number | null;
  amountUsd: string | null;
  soldRatioPct: string | null;
  signalPriceUsd: string | null;
  signalMarketCapUsd: string | null;
  token: GemToken;
}

interface Props {
  /** Открыть этот токен в центральном графике терминала. */
  onOpenChart: (token: GemToken) => void;
}

const WALLET_LABEL: Record<string, string> = {
  smart_money: 'Smart Money',
  kol: 'KOL',
  whale: 'Whale',
};

const LOW_CAP_CEILING_USD = 30_000;

/**
 * События OKX Signal без нашей risk-отсечки и без торговых действий.
 *
 * Каждая повторная покупка того же токена остаётся отдельным событием.
 * Поэтому ключ — id сигнала, а не адрес контракта. Фильтры ниже лишь
 * меняют видимость уже полученной ленты и ничего не удаляют из неё.
 */
export function GemsList({ onOpenChart }: Props) {
  const { data, isLoading } = useSWR<{
    source: string;
    updatedAt: string;
    signals: GemSignal[];
  }>('/tokens/gems?limit=100', fetcher, {
    refreshInterval: 3_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });
  const { isFavorite, toggle } = useTokenFavorites();
  const [chain, setChain] = useState('');
  const [lowCapOnly, setLowCapOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const signals = data?.signals ?? [];
  const chains = useMemo(
    () => [...new Set(signals.map((signal) => signal.token.chain))].sort(),
    [signals],
  );
  const visible = signals.filter((signal) => {
    const token = signal.token;
    if (chain && token.chain !== chain) return false;
    if (lowCapOnly) {
      const cap = numberOf(token.marketCapUsd);
      if (cap == null || cap >= LOW_CAP_CEILING_USD) return false;
    }
    if (favoritesOnly && !isFavorite(token.chain, token.address)) return false;
    return true;
  });

  const hasFilters = Boolean(chain || lowCapOnly || favoritesOnly);

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <p className="text-xs font-medium text-accent">Живой поток OKX Signal</p>
          {data?.updatedAt && (
            <span className="ml-auto text-[10px] text-muted">
              {new Date(data.updatedAt).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Цена и PnL обновляются в live-режиме. PnL считается от цены сигнала OKX,
          а не от вашего портфеля. Покупка здесь пока не подключена.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2" aria-label="Фильтры GEMS">
        <select
          value={chain}
          onChange={(event) => setChain(event.target.value)}
          className="input col-span-2 font-sans text-xs"
          aria-label="Сеть GEMS"
        >
          <option value="">Все сети</option>
          {chains.map((value) => (
            <option key={value} value={value}>
              {chainLabel(value)}
            </option>
          ))}
        </select>

        <button
          type="button"
          aria-pressed={lowCapOnly}
          onClick={() => setLowCapOnly((value) => !value)}
          className={filterClass(lowCapOnly)}
          title="Текущая капитализация меньше $30,000"
        >
          Low Cap &lt; $30K
        </button>

        <button
          type="button"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((value) => !value)}
          className={filterClass(favoritesOnly)}
          title="Токены, отмеченные звездой в этом браузере"
        >
          ★ Избранные
        </button>
      </div>

      {isLoading && signals.length === 0 ? (
        <LoadingRows />
      ) : signals.length === 0 ? (
        <EmptyFeed />
      ) : visible.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="text-sm text-muted">Под эти фильтры сигналов нет</p>
          <p className="mx-auto mt-1 max-w-[270px] text-xs leading-relaxed text-muted/70">
            Сами события не удалены — измените сеть или выключите фильтр.
          </p>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setChain('');
                setLowCapOnly(false);
                setFavoritesOnly(false);
              }}
              className="mt-3 rounded-lg bg-accent/15 px-3 py-2 text-xs font-medium text-accent"
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <div role="feed" aria-label="OKX Signal GEMS" className="space-y-2">
          {visible.map((signal) => (
            <GemCard
              key={signal.id}
              signal={signal}
              favorite={isFavorite(signal.token.chain, signal.token.address)}
              onToggleFavorite={() => toggle(signal.token.chain, signal.token.address)}
              onOpenChart={onOpenChart}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GemCard({
  signal,
  favorite,
  onToggleFavorite,
  onOpenChart,
}: {
  signal: GemSignal;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpenChart: (token: GemToken) => void;
}) {
  const t = signal.token;
  const performance = okxSignalPerformance(
    numberOf(signal.signalPriceUsd),
    numberOf(t.priceUsd),
    numberOf(signal.amountUsd),
  );
  const initialCap = numberOf(signal.signalMarketCapUsd);
  const currentCap = numberOf(t.marketCapUsd);
  const capDirection =
    currentCap != null && initialCap != null ? currentCap - initialCap : null;
  const walletText = signal.walletTypes.map((type) => WALLET_LABEL[type] ?? type).join(' · ');
  const canOpen = t.id != null;
  const live = isRecent(t.priceUpdatedAt, 30_000);

  const open = () => {
    if (canOpen) onOpenChart(t);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!canOpen || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    open();
  };

  return (
    <article
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Открыть график ${t.symbol}` : undefined}
      onClick={open}
      onKeyDown={onKeyDown}
      className={`rounded-xl border border-border bg-raised/55 p-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        canOpen ? 'cursor-pointer hover:border-accent/50 hover:bg-raised' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <TokenLogo symbol={t.symbol} address={t.address} logoUrl={t.logoUrl} size={36} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{t.symbol}</span>
            <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted">
              {chainLabel(t.chain)}
            </span>
            {live && (
              <span className="shrink-0 rounded bg-up/15 px-1.5 py-0.5 text-[9px] font-medium text-up">
                LIVE
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-muted">{t.name}</p>
        </div>

        <button
          type="button"
          aria-pressed={favorite}
          aria-label={favorite ? 'Убрать токен из избранного' : 'Добавить токен в избранное'}
          title={favorite ? 'Убрать из избранного' : 'Сохранить в этом браузере'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
          className={`tap grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base transition-colors ${
            favorite ? 'text-accent' : 'text-muted/60 hover:text-white'
          }`}
        >
          <span aria-hidden>{favorite ? '★' : '☆'}</span>
        </button>

        <div className="shrink-0 text-right">
          <div className="text-[11px] font-medium text-up">{relativeTime(signal.signaledAt)}</div>
          {performance && (
            <div
              className={`num mt-0.5 text-xs font-semibold ${
                performance.priceChangePct >= 0 ? 'text-up' : 'text-down'
              }`}
            >
              {formatMultiple(performance.multiple)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/70 pt-2.5 text-[11px]">
        <Metric label="Цена сигнала" value={fmtPrice(signal.signalPriceUsd)} />
        <Metric
          label="Цена live"
          value={fmtPrice(t.priceUsd)}
          tone={toneOf(performance?.priceChangePct)}
        />
        <Metric
          label="Изменение цены"
          value={performance ? fmtPct(performance.priceChangePct) : '—'}
          tone={toneOf(performance?.priceChangePct)}
        />
        <Metric
          label="PnL сигнала"
          value={performance?.pnlUsd == null ? '—' : signedUsd(performance.pnlUsd)}
          tone={toneOf(performance?.pnlUsd)}
          title="Оценка по сумме OKX от цены сигнала; это не PnL вашего портфеля"
        />
        <Metric label="MCap сигнала" value={fmtUsd(signal.signalMarketCapUsd)} />
        <Metric
          label="MCap сейчас"
          value={fmtUsd(t.marketCapUsd)}
          tone={toneOf(capDirection ?? undefined)}
        />
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
        <CopyAddress address={t.address} />
        {canOpen ? (
          <span className="ml-auto text-[10px] text-accent">Открыть график →</span>
        ) : (
          <span className="ml-auto text-[10px] text-muted">График готовится</span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
        {walletText && <span>{walletText}</span>}
        {signal.triggerWalletCount != null && <span>· кошельков: {signal.triggerWalletCount}</span>}
        {t.holders != null && <span>· держателей: {t.holders.toLocaleString('ru-RU')}</span>}
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-muted/75">{label}</div>
      <div
        className={`num truncate text-xs ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const stop = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <button
      type="button"
      onClick={stop}
      title={address}
      aria-label={`Копировать адрес ${address}`}
      className="num tap min-w-0 truncate rounded-md px-1.5 py-1 text-[10px] text-muted transition-colors hover:bg-panel hover:text-white"
    >
      {copied ? 'скопировано' : shortAddress(address)}
    </button>
  );
}

function EmptyFeed() {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm text-muted">Ждём первый сигнал</p>
      <p className="mx-auto mt-1 max-w-[270px] text-xs leading-relaxed text-muted/70">
        Лента заполнится автоматически, как только OKX опубликует новое событие.
      </p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2" aria-label="Загружаем OKX Signal">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="h-[210px] animate-pulse rounded-xl border border-border bg-raised/60" />
      ))}
    </div>
  );
}

function numberOf(value: string | number | null | undefined): number | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toneOf(value: number | null | undefined): 'up' | 'down' | undefined {
  return value == null || value === 0 ? undefined : value > 0 ? 'up' : 'down';
}

function signedUsd(value: number): string {
  return value > 0 ? `+${fmtUsd(value)}` : fmtUsd(value);
}

function formatMultiple(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 100) return `${Math.round(value)}×`;
  if (value >= 10) return `${value.toFixed(1)}×`;
  return `${value.toFixed(2)}×`;
}

function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'сейчас';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 10) return 'сейчас';
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч`;
  return `${Math.floor(hours / 24)}д`;
}

function isRecent(value: string | null, maxAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

function filterClass(active: boolean): string {
  return `tap min-h-10 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
    active
      ? 'border-accent/40 bg-accent/15 text-accent'
      : 'border-border bg-panel text-muted hover:border-border/80 hover:text-white'
  }`;
}
