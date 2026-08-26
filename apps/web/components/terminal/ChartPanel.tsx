'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TokenLogo } from '@/components/TokenLogo';
import { PriceChart, type AgentChartMarker } from '@/components/PriceChart';
import { fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
import {
  CHART_STATE_TEXT,
  chartStateRetryable,
  emptyCandleHistory,
  applyHistoryPage,
  markHistoryFailed,
  clearHistoryFailure,
  mergeCandlePages,
  shouldLoadOlder,
  isAwayFromLive,
  type CandleHistoryState,
  type ChartState,
  type LiveChartCandle,
} from '@memex/core';
import { CHAIN_LABEL, INTERVALS, type Token } from './types';
import { ScamMark } from './TokenList';

/**
 * Центральная область: график и всё, что относится к выбранному токену.
 *
 * График — главный элемент страницы, поэтому он занимает всё свободное
 * место по высоте, а метрики под ним сжаты в одну строку. Обратный
 * порядок — крупные метрики и график в остатке — превращает терминал
 * в справку о токене.
 */

interface Props {
  token: Token | null;
  /** Ответ маршрута свечей целиком: свечи вместе с причиной их отсутствия. */
  chart: { state?: string; candles?: unknown[]; liveAt?: string | null; live?: boolean } | undefined;
  /** Повторить загрузку. Показывается только при ошибке. */
  onRetry?: () => void;
  interval: string;
  onInterval: (v: string) => void;
  /** Высота графика. На телефоне меньше. */
  chartHeight?: number;
  /** Показывать шапку с ценой. На телефоне она своя, выше. */
  showHeader?: boolean;
  /**
   * Загрузить страницу свечей старше указанного времени.
   *
   * Приходит снаружи, а не вызывается здесь: панель не знает про
   * адреса маршрутов и про то, как в проекте ходят в сеть. Тесту
   * это позволяет подменить одну функцию вместо всего слоя запросов.
   */
  loadOlder?: (before: number) => Promise<{ candles: LiveChartCandle[]; oldest: number | null }>;
  markers?: AgentChartMarker[];
  focusMarkerId?: string | null;
}

export function ChartPanel({
  token,
  chart,
  onRetry,
  interval,
  onInterval,
  chartHeight = 420,
  showHeader = true,
  loadOlder,
  markers = [],
  focusMarkerId = null,
}: Props) {
  return (
    <ChartPanelBody
      token={token}
      chart={chart}
      onRetry={onRetry}
      interval={interval}
      onInterval={onInterval}
      chartHeight={chartHeight}
      showHeader={showHeader}
      loadOlder={loadOlder}
      markers={markers}
      focusMarkerId={focusMarkerId}
    />
  );
}

function ChartPanelBody({
  token,
  chart,
  onRetry,
  interval,
  onInterval,
  chartHeight,
  showHeader,
  loadOlder,
  markers,
  focusMarkerId,
}: Required<Pick<Props, 'interval' | 'onInterval' | 'chartHeight' | 'showHeader'>> &
  Pick<Props, 'token' | 'chart' | 'onRetry' | 'loadOlder' | 'markers' | 'focusMarkerId'>) {
  const tokenId = token?.id ?? null;

  /** Догруженные страницы истории. Живут отдельно от базового ответа. */
  const [history, setHistory] = useState<CandleHistoryState | null>(null);
  /** Человек ушёл от текущей цены. */
  const [awayFromLive, setAwayFromLive] = useState(false);
  /** Счётчик команды «вернуться к live». */
  const [goLive, setGoLive] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  /*
   * Поколение запроса.
   *
   * Растёт при каждой смене токена или таймфрейма и при каждом новом
   * запросе. Ответ с устаревшим поколением выбрасывается: иначе
   * страница, заказанная для пятиминутки, доехала бы уже после
   * переключения на часовик и подмешала бы чужие свечи.
   */
  const generation = useRef(0);

  // Смена токена или таймфрейма сбрасывает всё: страницы, курсоры,
  // положение относительно живого края.
  useEffect(() => {
    generation.current += 1;
    setHistory(tokenId ? emptyCandleHistory(tokenId, interval) : null);
    setAwayFromLive(false);
  }, [tokenId, interval]);

  useEffect(() => {
    if (!focusMarkerId) return;
    setFocusNonce((value) => value + 1);
    setAwayFromLive(true);
  }, [focusMarkerId]);

  const baseCandles = (Array.isArray(chart?.candles) ? chart.candles : []) as LiveChartCandle[];

  /*
   * Живые свечи первым аргументом.
   *
   * `mergeCandlePages` при совпадении времени оставляет то, что уже
   * было: последняя свеча меняется каждую секунду, и страница истории
   * не должна вернуть на её место цену получасовой давности.
   */
  const candles = history ? mergeCandlePages(baseCandles, history.candles) : baseCandles;

  /*
   * Курсор берётся из базового ответа, пока история пуста.
   *
   * Без этого первое перетаскивание влево ничего не запрашивало бы:
   * `shouldLoadOlder` отказывает, когда курсора нет, а взяться ему
   * больше неоткуда.
   */
  useEffect(() => {
    if (baseCandles.length === 0) return;

    setHistory((current) => {
      if (current == null || current.oldest != null) return current;
      return { ...current, oldest: baseCandles[0]!.time };
    });
  }, [baseCandles]);

  const requestOlder = useCallback(
    async (cursor: number) => {
      if (!loadOlder) return;

      const mine = ++generation.current;
      setHistory((current) => (current ? { ...current, loading: true } : current));

      try {
        const page = await loadOlder(cursor);

        // Ответ пришёл после смены токена или таймфрейма — выбрасываем.
        if (mine !== generation.current) return;

        setHistory((current) =>
          current ? applyHistoryPage(current, page.candles ?? [], cursor) : current,
        );
      } catch {
        if (mine !== generation.current) return;

        // График не трогаем: уже показанные свечи остаются на месте.
        setHistory((current) => (current ? markHistoryFailed(current, cursor) : current));
      }
    },
    [loadOlder],
  );

  const onVisibleRange = useCallback(
    (range: { from: number; to: number }, total: number) => {
      setAwayFromLive(isAwayFromLive({ visibleTo: range.to, total }));

      setHistory((current) => {
        if (current == null) return current;
        if (!shouldLoadOlder({ state: current, visibleFrom: range.from })) return current;

        // Запрос уходит вне обновления состояния; здесь только решение.
        const cursor = current.oldest!;
        queueMicrotask(() => void requestOlder(cursor));

        return current;
      });
    },
    [requestOlder],
  );

  const retryOlder = useCallback(() => {
    setHistory((current) => (current ? clearHistoryFailure(current) : current));

    const cursor = history?.failedAt;
    if (cursor != null) void requestOlder(cursor);
  }, [history?.failedAt, requestOlder]);

  if (!token) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted">Выберите токен в списке слева</p>
        <p className="max-w-[280px] text-xs leading-relaxed text-muted/70">
          График, метрики и торговля появятся здесь
        </p>
      </div>
    );
  }

  const ch = token.priceChange24h == null ? null : Number(token.priceChange24h);
  // Одна текущая цена на старшем интервале — ещё не график: она
  // растягивается в ровную линию на всю ширину и выглядит поломкой.
  // Для 1s одной точки достаточно, потому что следующие появляются
  // каждую секунду; для OHLCV нужны хотя бы две фактические свечи.
  const hasCandles = candles.length >= (interval === '1s' ? 1 : 2);

  /*
   * Причина приходит с сервера, а не выводится здесь.
   *
   * Раньше на всё было одно сообщение — «не найден пул ликвидности», —
   * и его видели у токена с пулом на 184 тысячи: пул был, свечей
   * не было. Пять разных причин, сведённые к одной строке, врут
   * в четырёх случаях.
   */
  const state = (chart?.state ?? 'candles-queued') as ChartState;
  const focusTime = markers?.find((marker) => marker.id === focusMarkerId)?.time ?? null;
  const markerList = markers ?? [];
  const focusWindowSeconds =
    interval === '1s'
      ? 300
      : interval === '5m'
        ? 18_000
        : interval === '15m'
          ? 54_000
          : interval === '1h'
            ? 259_200
            : interval === '4h'
              ? 1_036_800
              : 5_184_000;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {showHeader && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <TokenLogo
            symbol={token.symbol}
            address={token.address}
            logoUrl={token.logoUrl}
            size={36}
          />

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link
                href={`/token?id=${token.id}`}
                className="truncate text-lg font-semibold hover:text-accent"
              >
                {token.symbol}
              </Link>
              <ScamMark verdict={token.scamVerdict} reasons={token.scamReasons} />
              <span className="shrink-0 rounded border border-border bg-raised px-2 py-0.5 text-[11px] text-muted">
                {CHAIN_LABEL[token.chain] ?? token.chain}
              </span>
            </div>
            <p className="truncate text-xs text-muted">{token.name}</p>
          </div>

          <div className="ml-auto text-right">
            <div className="num text-xl font-semibold leading-tight">
              {fmtPrice(token.priceUsd)}
            </div>
            <div
              className={`num text-sm ${
                ch == null ? 'text-muted' : ch >= 0 ? 'text-up' : 'text-down'
              }`}
            >
              {ch == null ? '—' : `${fmtPct(ch)} за 24ч`}
            </div>
          </div>
        </div>
      )}

      {/* Предупреждение о ловушке — выше графика: смотреть на свечи
          токена, из которого нельзя выйти, бессмысленно. */}
      {token.scamVerdict === 'BLOCK' && (
        <div className="border-b border-down/30 bg-down/10 px-4 py-2 text-xs text-down">
          {token.scamReasons?.blockers?.[0] ?? 'Токен заблокирован проверкой'}
        </div>
      )}
      {token.scamVerdict === 'WARN' && token.scamReasons?.warnings?.length ? (
        <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
          {token.scamReasons.warnings.join(' · ')}
        </div>
      ) : null}

      {/* Таймфреймы */}
      <div className="flex items-center gap-1 border-b border-border px-4 py-2">
        {INTERVALS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => onInterval(value)}
            className={`tap rounded-md px-2.5 py-1 text-xs transition-colors ${
              interval === value
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:bg-raised hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
        {hasCandles && chart?.live === true && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-medium text-up">
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-40 motion-reduce:animate-none" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
            </span>
            LIVE
          </span>
        )}
      </div>

      {/* График занимает остаток высоты. */}
      <div className="relative min-h-0 flex-1 px-2 py-2">
        {hasCandles ? (
          <>
            <PriceChart
              candles={candles as never}
              height={chartHeight}
              resetKey={`${token.id}:${interval}`}
              secondsVisible={interval === '1s'}
              onVisibleRange={onVisibleRange}
              goLiveNonce={goLive}
              // Пока человек изучает прошлое, новая свеча не тащит
              // его обратно к текущей цене.
              followLive={!awayFromLive}
              markers={markerList}
              focusTime={focusTime}
              focusNonce={focusNonce}
              focusWindowSeconds={focusWindowSeconds}
            />

            {/*
              Индикатор у левого края, а не поверх всего графика.

              Заменять готовые свечи скелетом при догрузке значит
              на секунду отбирать у человека то, что он уже читает.
            */}
            {history?.loading && (
              <span
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 rounded-md border border-border bg-panel/90 px-2 py-1 text-[11px] text-muted"
              >
                Загружаем историю…
              </span>
            )}

            {/*
              Ошибка догрузки — не ошибка графика.

              Показанные свечи остаются; пропала только возможность
              уйти левее, и предложить надо ровно повтор этого шага.
            */}
            {history?.failedAt != null && !history.loading && (
              <button
                type="button"
                onClick={retryOlder}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-md border border-border bg-panel px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
              >
                История не загрузилась. Повторить
              </button>
            )}

            {/*
              Возврат к текущей цене.

              Справа снизу: слева индикатор загрузки, сверху
              таймфреймы, справа шкала цены — остаётся один угол,
              и он же ближе всего к большому пальцу на телефоне.
            */}
            {awayFromLive && (
              <button
                type="button"
                onClick={() => setGoLive((n) => n + 1)}
                aria-label="Вернуться к текущей цене"
                className="tap absolute bottom-3 right-6 inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-[11px] text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                  <path d="M5 12h13M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                К текущей цене
              </button>
            )}
          </>
        ) : (
          <div
            style={{ height: chartHeight }}
            className="flex flex-col items-center justify-center gap-1.5 text-center"
          >
            <p className="text-sm text-muted">
              {state === 'failed' ? 'Не удалось загрузить график' : 'История цены недоступна'}
            </p>

            <p className="max-w-[320px] text-xs leading-relaxed text-muted/70">
              {state === 'pool-pending' || state === 'candles-queued'
                ? 'Обновление произойдёт автоматически, как только поставщик отдаст цену.'
                : CHART_STATE_TEXT[state]}
            </p>

            {chartStateRetryable(state) && onRetry && (
              <button
                onClick={onRetry}
                className="btn-ghost mt-2 px-4 py-1.5 text-xs"
              >
                Повторить
              </button>
            )}
          </div>
        )}
      </div>

      {markerList.length > 0 && (
        <details className="border-t border-border px-4 py-2 text-xs">
          <summary className="cursor-pointer text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            События paper-агента на графике · {markerList.length}
          </summary>
          <ol className="mt-2 max-h-32 space-y-1 overflow-y-auto" aria-label="События paper-агента">
            {markerList.map((marker) => (
              <li key={marker.id} className="flex flex-wrap gap-x-2 text-muted">
                <span className={marker.side === 'BUY' ? 'text-up' : 'text-down'}>
                  PAPER {marker.side}
                </span>
                <time dateTime={new Date(marker.time * 1_000).toISOString()}>
                  {new Date(marker.time * 1_000).toLocaleString('ru-RU')}
                </time>
                <span>{marker.strategyLabel}</span>
                <span>{marker.priceUsd == null ? 'цена —' : fmtPrice(marker.priceUsd)}</span>
                {marker.side === 'SELL' && (
                  <span>{marker.pnlUsd == null ? 'PnL —' : `PnL ${fmtUsd(marker.pnlUsd)}`}</span>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* Метрики и адрес */}
      <div className="border-t border-border">
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          <Metric label="Объём 24ч" value={fmtUsd(token.volume24hUsd)} />
          <Metric label="Ликвидность" value={fmtUsd(token.liquidityUsd)} />
          <Metric label="FDV" value={fmtUsd(token.fdvUsd)} />
          <Metric
            label="Риск-скор"
            value={token.riskScore?.toString() ?? '—'}
            tone={
              token.riskScore == null
                ? undefined
                : token.riskScore > 60
                  ? 'down'
                  : token.riskScore > 30
                    ? 'warn'
                    : 'up'
            }
          />
        </div>

        <ContractRow token={token} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'warn';
}) {
  return (
    <div className="bg-panel px-4 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div
        className={`num text-sm ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Адрес контракта отдельной строкой.
 *
 * Сокращён до начала и конца: полный адрес занимает всю ширину, а
 * читают его только для сверки — там достаточно первых и последних
 * символов. Полный лежит в title и уходит в буфер по кнопке.
 */
function ContractRow({ token }: { token: Token }) {
  const [copied, setCopied] = useState(false);

  const short =
    token.address.length > 20
      ? `${token.address.slice(0, 8)}…${token.address.slice(-6)}`
      : token.address;

  const explorer =
    token.chain === 'SOLANA'
      ? `https://solscan.io/token/${token.address}`
      : token.chain === 'BNB'
        ? `https://bscscan.com/token/${token.address}`
        : token.chain === 'BASE'
          ? `https://basescan.org/token/${token.address}`
          : token.chain === 'ETHEREUM'
            ? `https://etherscan.io/token/${token.address}`
            : null;

  return (
    <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs">
      <span className="text-muted">Контракт</span>
      <span className="num truncate text-muted" title={token.address}>
        {short}
      </span>

      <button
        onClick={() => {
          navigator.clipboard?.writeText(token.address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="ml-auto shrink-0 rounded px-2 py-1 text-muted transition-colors hover:bg-raised hover:text-white"
      >
        {copied ? 'скопировано' : 'копировать'}
      </button>

      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded px-2 py-1 text-muted transition-colors hover:bg-raised hover:text-white"
        >
          обозреватель ↗
        </a>
      )}
    </div>
  );
}
