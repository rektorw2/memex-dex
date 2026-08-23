'use client';

import useSWR from 'swr';
import { TokenLogo } from '@/components/TokenLogo';
import { fetcher, fmtPrice, fmtUsd } from '@/lib/api';
import { chainLabel } from '@/lib/chains';

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
  token: {
    id: string | null;
    chain: string;
    address: string;
    symbol: string;
    name: string;
    logoUrl: string | null;
    priceUsd: string | null;
    marketCapUsd: string | null;
    holders: number | null;
  };
}

const WALLET_LABEL: Record<string, string> = {
  smart_money: 'Smart Money',
  kol: 'KOL',
  whale: 'Whale',
};

/**
 * События OKX Signal без нашей отсечки и без торговых действий.
 *
 * Это не ещё одна витрина Token: каждая повторная покупка того же
 * токена остаётся отдельным событием. Поэтому ключ — id сигнала,
 * а не адрес контракта, и сортировать или дедуплицировать на клиенте
 * нельзя.
 */
export function GemsList() {
  const { data, isLoading } = useSWR<{
    source: string;
    updatedAt: string;
    signals: GemSignal[];
  }>('/tokens/gems?limit=100', fetcher, {
    refreshInterval: 3_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });

  const signals = data?.signals ?? [];

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <p className="text-xs font-medium text-accent">Живой поток OKX Signal</p>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Показываем события сразу после OKX — без наших фильтров и ожидания проверки.
          Покупка из этой вкладки пока не подключена.
        </p>
      </div>

      {isLoading && signals.length === 0 ? (
        <LoadingRows />
      ) : signals.length === 0 ? (
        <div className="px-5 py-14 text-center">
          <p className="text-sm text-muted">Ждём первый сигнал</p>
          <p className="mx-auto mt-1 max-w-[270px] text-xs leading-relaxed text-muted/70">
            Лента заполнится автоматически, как только OKX опубликует новое событие.
          </p>
        </div>
      ) : (
        <div role="feed" aria-label="OKX Signal GEMS" className="space-y-2">
          {signals.map((signal) => (
            <GemCard key={signal.id} signal={signal} />
          ))}
        </div>
      )}
    </div>
  );
}

function GemCard({ signal }: { signal: GemSignal }) {
  const t = signal.token;
  const initialCap = numberOf(signal.signalMarketCapUsd);
  const currentCap = numberOf(t.marketCapUsd);
  const multiple =
    initialCap != null && initialCap > 0 && currentCap != null && currentCap > 0
      ? currentCap / initialCap
      : null;
  const direction = currentCap != null && initialCap != null ? currentCap - initialCap : null;
  const walletText = signal.walletTypes.map((type) => WALLET_LABEL[type] ?? type).join(' · ');

  return (
    <article className="rounded-xl border border-border bg-raised/55 p-3">
      <div className="flex items-start gap-3">
        <TokenLogo symbol={t.symbol} address={t.address} logoUrl={t.logoUrl} size={36} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{t.symbol}</span>
            <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted">
              {chainLabel(t.chain)}
            </span>
          </div>
          <p className="truncate text-[11px] text-muted">{t.name}</p>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[11px] font-medium text-up">{relativeTime(signal.signaledAt)}</div>
          {multiple != null && (
            <div
              className={`num mt-0.5 text-xs font-semibold ${
                multiple >= 1 ? 'text-up' : 'text-down'
              }`}
            >
              {formatMultiple(multiple)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/70 pt-2.5 text-[11px]">
        <Metric label="Сигнал при MCap" value={fmtUsd(signal.signalMarketCapUsd)} />
        <Metric
          label="Сейчас MCap"
          value={fmtUsd(t.marketCapUsd)}
          tone={direction == null ? undefined : direction >= 0 ? 'up' : 'down'}
        />
        <Metric label="Цена сигнала" value={fmtPrice(signal.signalPriceUsd)} />
        <Metric label="Сумма входа" value={fmtUsd(signal.amountUsd)} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
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
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted/75">{label}</div>
      <div className={`num truncate text-xs ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2" aria-label="Загружаем OKX Signal">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="h-[142px] animate-pulse rounded-xl border border-border bg-raised/60" />
      ))}
    </div>
  );
}

function numberOf(value: string | null): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMultiple(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
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
