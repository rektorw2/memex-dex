'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TokenLogo } from '@/components/TokenLogo';
import { PriceChart } from '@/components/PriceChart';
import { fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
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
  candles: unknown[] | undefined;
  interval: string;
  onInterval: (v: string) => void;
  /** Высота графика. На телефоне меньше. */
  chartHeight?: number;
  /** Показывать шапку с ценой. На телефоне она своя, выше. */
  showHeader?: boolean;
}

export function ChartPanel({
  token,
  candles,
  interval,
  onInterval,
  chartHeight = 420,
  showHeader = true,
}: Props) {
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
  const hasCandles = Array.isArray(candles) && candles.length > 0;

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
      </div>

      {/* График занимает остаток высоты. */}
      <div className="min-h-0 flex-1 px-2 py-2">
        {hasCandles ? (
          <PriceChart candles={candles as never} height={chartHeight} />
        ) : (
          <div
            style={{ height: chartHeight }}
            className="flex flex-col items-center justify-center gap-1.5 text-center"
          >
            <p className="text-sm text-muted">Свечи ещё не загружены</p>
            <p className="max-w-[320px] text-xs leading-relaxed text-muted/70">
              {token.hasChart
                ? 'Загрузчик обходит токены по кругу — данные появятся в течение нескольких минут'
                : 'Для этого токена не найден пул ликвидности'}
            </p>
          </div>
        )}
      </div>

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
