'use client';

import Link from 'next/link';
import { TradePanel } from '@/components/TradePanel';
import { fmtUsd } from '@/lib/api';
import type { Token } from './types';

/**
 * Правая колонка: портфель и торговля.
 *
 * Порядок обратный привычному — сводка сверху, торговля под ней.
 * Причина в том, что сводку читают до решения, а форму заполняют
 * после: свободный остаток нужно видеть раньше, чем поле суммы.
 *
 * Если торговать нечем, колонка не остаётся пустой: пустая треть
 * экрана выглядит как незагрузившийся интерфейс, а не как отсутствие
 * возможности.
 */

interface Props {
  token: Token | null;
  quoteToken: Token | undefined;
  portfolio: any;
  isLoading?: boolean;
}

export function SidePanel({ token, quoteToken, portfolio, isLoading }: Props) {
  const isAuthed = portfolio != null;
  const pnl = Number(portfolio?.unrealizedPnlUsd ?? 0);

  return (
    <div className="flex h-full min-w-0 flex-col gap-4">
      {/* ─── Портфель ───────────────────────────────────────────────── */}
      <div className="panel shrink-0 p-4">
        <h2 className="mb-3 text-sm font-medium">Портфель</h2>

        {isLoading && !portfolio ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-raised" />
            ))}
          </div>
        ) : !isAuthed ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              Войдите, чтобы видеть свои позиции и торговать. Котировки и графики
              доступны без входа.
            </p>
            <Link href="/login" className="btn-primary w-full text-sm">
              Войти
            </Link>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <Row label="Всего" value={fmtUsd(portfolio?.totalValueUsd)} strong />
            <Row label="Свободно" value={fmtUsd(portfolio?.cashUsd)} />
            <Row
              label="Нереализованный PnL"
              value={fmtUsd(portfolio?.unrealizedPnlUsd)}
              tone={pnl >= 0 ? 'up' : 'down'}
              sign
            />
            <div className="border-t border-border pt-2">
              <Row
                label="Уплаченная комиссия"
                value={fmtUsd(portfolio?.totalFeesPaidUsd)}
                small
              />
            </div>
          </div>
        )}
      </div>

      {/* ─── Торговля ───────────────────────────────────────────────── */}
      {isAuthed && token && quoteToken ? (
        <TradePanel
          tokenId={token.id}
          tokenSymbol={token.symbol}
          quoteTokenId={quoteToken.id}
          quoteSymbol={quoteToken.symbol}
          chain={token.chain}
          currentPriceUsd={Number(token.priceUsd ?? 0)}
          availableQuote={Number(portfolio?.cashUsd ?? 0)}
          availableToken={Number(
            portfolio?.holdings?.find((h: any) => h.tokenId === token.id)?.quantity ?? 0,
          )}
        />
      ) : (
        <div className="panel flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm text-muted">
            {!isAuthed
              ? 'Торговля после входа'
              : !token
                ? 'Выберите токен'
                : 'Нет котировочной валюты'}
          </p>
          <p className="max-w-[220px] text-xs leading-relaxed text-muted/70">
            {!isAuthed
              ? 'Ордера исполняются по реальным котировкам в бумажном режиме — деньги не задействованы'
              : !token
                ? 'Форма покупки появится здесь'
                : 'В этой сети не заведён USDC или другой котировочный токен — добавьте его в админке'}
          </p>
        </div>
      )}

      {/* ─── Открытые позиции ───────────────────────────────────────── */}
      {isAuthed && portfolio?.holdings?.length > 0 && (
        <div className="panel shrink-0 p-4">
          <h2 className="mb-2 text-sm font-medium">Позиции</h2>
          <div className="space-y-1.5">
            {portfolio.holdings.slice(0, 5).map((h: any) => {
              const p = Number(h.unrealizedPnlPct ?? 0);
              return (
                <div key={h.tokenId} className="flex items-center gap-2 text-xs">
                  <span className="truncate font-medium">{h.symbol}</span>
                  <span className="num ml-auto text-muted">{fmtUsd(h.valueUsd)}</span>
                  <span className={`num w-[58px] text-right ${p >= 0 ? 'text-up' : 'text-down'}`}>
                    {p >= 0 ? '+' : ''}
                    {p.toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
          {portfolio.holdings.length > 5 && (
            <Link
              href="/portfolio"
              className="mt-2 inline-block text-xs text-accent hover:underline"
            >
              ещё {portfolio.holdings.length - 5} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  small,
  strong,
  sign,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  small?: boolean;
  strong?: boolean;
  sign?: boolean;
}) {
  // Знак у величин, которые бывают отрицательными: полагаться на один
  // цвет нельзя, его различают не все.
  const shown = sign && tone === 'up' && !value.startsWith('-') ? `+${value}` : value;

  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={`text-muted ${small ? 'text-xs' : ''}`}>{label}</span>
      <span
        className={`num ${small ? 'text-xs' : ''} ${strong ? 'text-base font-semibold' : ''} ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''
        }`}
      >
        {shown}
      </span>
    </div>
  );
}
