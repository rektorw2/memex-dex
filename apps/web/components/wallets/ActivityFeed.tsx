'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { timeAgo } from '@memex/core';
import { fetcher, fmtUsd, fmtPrice, errorMessage } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { Identicon } from './SmartScore';
import { short } from './WalletViews';
import { PnlValue } from './PnlValue';
import { FavoriteStar } from './FavoriteStar';
import type { Wallet } from './WalletViews';

/**
 * Живая лента сделок отслеживаемых кошельков.
 *
 * Заменяет заглушку. Данные настоящие — из ленты отслеживания OKX;
 * выдуманных строк здесь нет и быть не может: на этой странице
 * человек принимает решения деньгами.
 *
 * Отдельно про состояние без ключей. Пустая лента и ненастроенный
 * провайдер выглядят одинаково, а означают совершенно разное:
 * в первом случае ждать нечего, во втором нужно идти настраивать.
 * Различает их сервер, а не догадка интерфейса, и сообщения тоже
 * разные.
 *
 * Направление сделки передаётся словом, а не только цветом. Красный
 * и зелёный не различает примерно каждый двенадцатый мужчина,
 * а спутать покупку с продажей здесь стоит дороже всего.
 */

interface ActivityEvent {
  dedupeKey: string;
  chain: string;
  wallet: string;
  txHash: string | null;
  tokenAddress: string;
  tokenId: string | null;
  tokenSymbol: string | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  side: 'BUY' | 'SELL';
  priceUsd: number | null;
  currentPriceUsd: number | null;
  currentPriceAt: string | null;
  growthPercent: number | null;
  marketCapUsd: number | null;
  realizedPnlUsd: number | null;
  /**
   * Вердикт нашего учёта, а не ленты провайдера.
   *
   * Лента приходит от OKX вместе с его собственным расчётом прибыли.
   * Показывать это число как истину нельзя: оно посчитано по данным,
   * которых мы не видели. Состояние решает, показывать ли его вообще.
   */
  pnlState?: 'available' | 'pending' | 'incomplete_history' | 'ambiguous' | 'open_position';
  pnlSource?: 'local' | null;
  pnlComputedAt?: string | null;
  holderPnl: {
    state: 'available' | 'pending' | 'incomplete_history' | 'ambiguous' | 'stale' | 'empty';
    assetsUsd: number | null;
    realizedUsd: number | null;
    unrealizedUsd: number | null;
    totalUsd: number | null;
    computedAt: string | null;
  } | null;
  tradedAt: number;
}

interface ActivityResponse {
  configured: boolean;
  source: string;
  fetchedAt?: string;
  events: ActivityEvent[];
  note?: string;
}

const SIDE_FILTERS: Array<[string, string]> = [
  ['all', 'Все'],
  ['buy', 'Покупки'],
  ['sell', 'Продажи'],
];

export function ActivityFeed({ onOpen }: { onOpen?: (wallet: Wallet) => void }) {
  const [chain, setChain] = useState('');
  const [side, setSide] = useState('all');
  const [minVolume, setMinVolume] = useState<number | ''>('');

  const params = new URLSearchParams({ limit: '50', side });
  if (chain) params.set('chain', chain);
  if (minVolume !== '') params.set('minVolumeUsd', String(minVolume));

  const { data, error, isLoading } = useSWR<ActivityResponse>(
    `/wallets/activity?${params}`,
    fetcher,
    // Лента живёт секундами: она и нужна для того, чтобы видеть
    // сделку вскоре после подтверждения.
    { refreshInterval: 20_000, keepPreviousData: true },
  );

  // Провайдер не настроен — это не пустая лента, и сообщение другое.
  if (data && !data.configured) {
    return (
      <div className="panel px-6 py-16 text-center">
        <p className="text-sm text-muted">Данные временно недоступны</p>
        <p className="mx-auto mt-2 max-w-[380px] text-xs leading-relaxed text-muted/70">
          Источник живых сделок не подключён. Показывать вместо них что-либо
          другое мы не станем: на этой странице выдуманные данные опаснее пустого
          экрана.
        </p>
      </div>
    );
  }

  const events = data?.events ?? [];

  return (
    <div className="space-y-3">
      {/* ── Фильтры ────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="scroll-x flex gap-1.5">
          <Chip active={!chain} onClick={() => setChain('')}>Все сети</Chip>
          {(['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const).map((c) => (
            <Chip key={c} active={chain === c} onClick={() => setChain(c)}>
              {chainLabel(c)}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5">
            {SIDE_FILTERS.map(([v, label]) => (
              <button
                key={v}
                onClick={() => setSide(v)}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  side === v ? 'bg-raised text-white' : 'text-muted hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <select
            value={String(minVolume)}
            onChange={(e) => setMinVolume(e.target.value === '' ? '' : Number(e.target.value))}
            className="h-10 w-[180px] cursor-pointer appearance-none rounded-lg border border-border bg-panel px-3 text-xs outline-none focus:border-accent"
          >
            <option value="">Любая сумма</option>
            <option value="1000">От $1K</option>
            <option value="10000">От $10K</option>
            <option value="50000">От $50K</option>
          </select>

          {data?.fetchedAt && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted/70">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" aria-hidden />
              {data.source} · обновлено {timeAgo(data.fetchedAt)}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="panel border-down/40 p-4">
          <p className="text-sm text-down">Лента сейчас недоступна</p>
          {/* Техническая причина остаётся видимой, но отдельной
              строкой и мелко: «Not Found» вместо заголовка выглядело
              как содержимое страницы, а не как сбой запроса. */}
          <p className="mt-1 text-xs text-muted/70">{errorMessage(error)}</p>
        </div>
      )}

      {/* ── Лента ──────────────────────────────────────────────── */}
      {isLoading && events.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="panel flex items-center gap-3 p-3">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-raised" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-28 animate-pulse rounded bg-raised" />
                <div className="h-2.5 w-40 animate-pulse rounded bg-raised/60" />
              </div>
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="panel px-6 py-16 text-center">
          <p className="text-sm text-muted">Сделок пока нет</p>
          <p className="mx-auto mt-2 max-w-[340px] text-xs leading-relaxed text-muted/70">
            {chain || side !== 'all' || minVolume !== ''
              ? 'Под текущие фильтры ничего не попало.'
              : 'Отслеживаемые кошельки не торговали в последние минуты. Лента обновляется каждые двадцать секунд.'}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => (
            <Row key={e.dedupeKey} event={e} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ event: e, onOpen }: { event: ActivityEvent; onOpen?: (wallet: Wallet) => void }) {
  const chain = CHAINS[e.chain];
  const isBuy = e.side === 'BUY';
  const pnl = e.realizedPnlUsd;

  // Состояние приходит с сервера. Выводить его из отсутствия числа
  // нельзя: по пустому значению не отличить «ещё считаем»
  // от «истории не хватает».
  const state = e.pnlState ?? (isBuy ? 'open_position' : 'pending');

  return (
    <div
      className={`panel flex items-center gap-3 p-3 ${onOpen ? 'cursor-pointer transition-colors hover:bg-raised' : ''}`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={() => onOpen?.(walletFromActivity(e))}
      onKeyDown={(event) => {
        if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen(walletFromActivity(e));
        }
      }}
    >
      <Identicon address={e.wallet} size={32} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {/* Слово, а не только цвет: спутать покупку с продажей
              здесь стоит дороже всего. */}
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
            }`}
          >
            {isBuy ? 'Покупка' : 'Продажа'}
          </span>

          {e.tokenId ? (
            <Link
              href={`/terminal/?token=${encodeURIComponent(e.tokenId)}`}
              onClick={(event) => event.stopPropagation()}
              className="truncate text-[13px] font-medium transition-colors hover:text-accent"
              title="Открыть токен в графике Memex"
            >
              {e.tokenSymbol ?? short(e.tokenAddress)}
            </Link>
          ) : (
            <span className="truncate text-[13px] font-medium">
              {e.tokenSymbol ?? short(e.tokenAddress)}
            </span>
          )}

          <span className="num shrink-0 text-[11px] text-muted">{short(e.wallet)}</span>

          {/* Звезда рядом с адресом: отметить кошелёк можно там,
              где он попался на глаза, а не только в общем списке. */}
          <span onClick={(event) => event.stopPropagation()}>
            <FavoriteStar chain={e.chain} address={e.wallet} size="sm" className="-my-1" />
          </span>
        </div>

        <div className="mt-0.5 truncate text-[11px] text-muted">
          {chainLabel(e.chain)}
          {e.quoteAmount != null && e.quoteSymbol && (
            <> · {e.quoteAmount.toFixed(3)} {e.quoteSymbol}</>
          )}
          {e.priceUsd != null && <> · {fmtPrice(e.priceUsd)}</>}
          {e.currentPriceUsd != null && <> → сейчас {fmtPrice(e.currentPriceUsd)}</>}
          {e.marketCapUsd != null && <> · кап {fmtUsd(e.marketCapUsd)}</>}
        </div>
      </div>

      <div className="shrink-0 text-right">
        {e.growthPercent != null && Number.isFinite(e.growthPercent) && (
          <div className={`num text-[12px] ${e.growthPercent >= 0 ? 'text-up' : 'text-down'}`}>
            {e.growthPercent >= 0 ? '+' : ''}{e.growthPercent.toFixed(1)}% от сделки
          </div>
        )}
        <div className="mt-0.5 text-[10px] text-muted/60">PnL кошелька</div>
        <PnlValue
          valueUsd={e.holderPnl?.totalUsd ?? null}
          isPending={e.holderPnl == null || e.holderPnl.state === 'pending' || e.holderPnl.state === 'empty'}
          hasIncompleteHistory={e.holderPnl?.state === 'incomplete_history'}
          isAmbiguous={e.holderPnl?.state === 'ambiguous'}
          isPriceStale={e.holderPnl?.state === 'stale'}
          computedAt={e.holderPnl?.computedAt ? new Date(e.holderPnl.computedAt).getTime() : null}
          kind="total"
          size="sm"
        />
        <div className="mt-0.5 num text-[10px] text-muted/70">
          Активы {e.holderPnl?.assetsUsd == null ? 'считаются' : fmtUsd(e.holderPnl.assetsUsd)}
        </div>

        {/*
          Здесь раньше было пустое место — у покупки результата нет,
          и колонка просто пустовала. Выглядело это как потерянные
          данные. Теперь показывается причина отсутствия числа,
          и причины эти разные: открытая позиция, идущий пересчёт
          и нехватка истории означают совершенно не одно и то же.
        */}
        <PnlValue
          valueUsd={state === 'available' ? pnl : null}
          isOpen={state === 'open_position'}
          isPending={state === 'pending'}
          hasIncompleteHistory={state === 'incomplete_history'}
          isAmbiguous={state === 'ambiguous'}
          computedAt={e.pnlComputedAt ? new Date(e.pnlComputedAt).getTime() : null}
          kind="realized"
          size="sm"
          className="mt-1"
        />
        <div className="mt-0.5 text-[11px] text-muted/70">{timeAgo(new Date(e.tradedAt))}</div>
      </div>

      {chain && (
        <a
          href={chain.explorerAddress(e.wallet)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:text-white"
          aria-label="Открыть кошелёк в обозревателе"
        >
          ↗
        </a>
      )}
    </div>
  );
}

function walletFromActivity(event: ActivityEvent): Wallet {
  return {
    chain: event.chain,
    address: event.wallet,
    score: null,
    wins2x: null,
    rugs: null,
    avgPeakMultiple: null,
    medianEntryHours: null,
    volumeUsd: null,
    lastActiveAt: new Date(event.tradedAt).toISOString(),
  };
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
