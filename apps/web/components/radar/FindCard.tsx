'use client';

import { useState } from 'react';
import { timeAgo, exactTime, formatAge, multipleView } from '@memex/core';
import { fmtUsd, fmtPrice } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { TokenLogo } from '@/components/TokenLogo';
import { Sparkline } from '@/components/Sparkline';
import { RiskMeter } from './RiskMeter';

/**
 * Карточка находки.
 *
 * Порядок блоков задаёт порядок чтения, и он выбран под вопрос,
 * с которым человек приходит на радар: что нашли, когда, насколько
 * выросло, насколько опасно, почему опасно, куда идти дальше.
 * Каждый следующий блок отвечает на следующий вопрос, поэтому
 * карточку можно бросить читать на любом месте.
 *
 * Три решения, которые стоит объяснить.
 *
 * График сворачивается, когда точек мало. Пустая рамка высотой
 * в семьдесят пикселей на карточке только что найденного токена —
 * это норма, а не исключение: наблюдение началось минуту назад.
 * Резервировать под неё место значит делать половину ленты дырявой.
 *
 * Пара «Пик 1.00× · Сейчас 1.00×» не показывается вовсе. Она занимает
 * самое видное место и не сообщает ничего; вместо неё короткая строка
 * о том, что изменений пока нет.
 *
 * Адрес показывается коротким и рядом с сетью, а не кнопкой во всю
 * ширину. Копирование — действие редкое и вспомогательное, а место
 * главного действия принадлежит графику.
 */

export interface RadarEvent {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  priceUsd: string | null;
  discoveryPriceUsd?: string | null;
  currentPriceUsd?: string | null;
  liquidityUsd: string | null;
  poolAgeHours: number | null;
  holders?: number | null;
  riskScore: number | null;
  /**
   * Состояние проверок с сервера.
   *
   * Без него карточка выводила состояние из отсутствия числа
   * и показывала «Низкий риск 5/100» при одной пройденной проверке.
   */
  riskState?: string | null;
  riskCompletenessPercent?: number | null;
  missingChecks?: string[];
  riskUpdatedAt?: string | null;
  riskLevel?: string | null;
  riskCodes?: string[];
  riskFlags?: unknown;
  source: string;
  points: Array<{ t: number; p: number | null; m: number | null }>;
  firstSeenAt: string;
  currentMultiple: number | null;
  peakMultiple: number | null;
  peakAt?: string | null;
  wallets?: { smart: number; whale: number; smartVolumeUsd: string; strength: number };
}

export function FindCard({
  event: e,
  isNew,
  onOpen,
}: {
  event: RadarEvent;
  /** Появилась в текущей сессии: помечается на время, без мигания. */
  isNew?: boolean;
  onOpen?: () => void;
}) {
  const chain = CHAINS[e.chain];
  const mv = multipleView(e.currentMultiple, e.peakMultiple);
  const points = Array.isArray(e.points) ? e.points : [];
  const enoughPoints = points.filter((p) => (p.m ?? p.p) != null).length >= 2;
  const flags = Array.isArray(e.riskFlags) ? (e.riskFlags as string[]) : [];

  return (
    <article
      className={`panel group flex flex-col gap-3 p-4 transition-colors ${
        isNew ? 'border-accent/40' : ''
      } hover:border-border/80`}
    >
      {/* ── 1. Что нашли и когда ───────────────────────────────── */}
      <header className="flex items-start gap-2.5">
        <TokenLogo symbol={e.symbol} address={e.address} logoUrl={null} size={36} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{e.symbol}</span>
            {isNew && (
              <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                Новый
              </span>
            )}
          </div>
          {/* Название и сеть в одну строку: тикер не уникален,
              и без сети две одноимённые находки не различить. */}
          <div className="truncate text-xs text-muted">
            {e.name} · {chainLabel(e.chain)}
          </div>
        </div>

        <div className="shrink-0 text-right">
          {/* Никогда голое «04:06»: без подписи такое время читается
              как что угодно. */}
          <div className="text-[11px] text-muted" title={`Обнаружен в ${exactTime(e.firstSeenAt)}`}>
            {timeAgo(e.firstSeenAt)}
          </div>
          {mv.meaningful ? (
            <div
              className={`num text-sm font-medium ${mv.isUp ? 'text-up' : 'text-down'}`}
              title="Изменение с момента обнаружения"
            >
              {mv.currentPct}
            </div>
          ) : (
            <div className="text-[11px] text-muted/70">без движения</div>
          )}
        </div>
      </header>

      {/* ── 2. Насколько выросло ───────────────────────────────── */}
      {mv.meaningful ? (
        <div className="flex items-baseline gap-3 text-xs">
          <span className="text-muted">
            Пик <span className="num text-white">{mv.peak}</span>
          </span>
          {mv.fadedFromPeak && (
            <span className="text-warn" title="Пик пройден, сейчас заметно ниже">
              момент упущен
            </span>
          )}
          {e.peakAt && (
            <span className="ml-auto text-[11px] text-muted/70">пик {timeAgo(e.peakAt)}</span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Изменений пока нет</p>
      )}

      {/* ── 3. График, если есть что рисовать ──────────────────── */}
      {enoughPoints ? (
        <Sparkline points={points} height={68} />
      ) : (
        <div className="rounded-md bg-raised px-2.5 py-1.5 text-[11px] text-muted">
          Собираем данные · {points.length}{' '}
          {points.length === 1 ? 'точка' : points.length < 5 ? 'точки' : 'точек'}
        </div>
      )}

      {/* ── 4. Ключевые метрики ────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 rounded-md bg-raised p-2.5">
        <Metric label="Цена" value={fmtPrice(e.priceUsd)} />
        <Metric label="Ликвидность" value={fmtUsd(e.liquidityUsd)} />
        <Metric
          label={e.holders != null ? 'Держатели' : 'Возраст'}
          value={
            e.holders != null ? e.holders.toLocaleString('ru-RU') : formatAge(e.poolAgeHours)
          }
        />
      </div>

      {/* ── 5. Риск и его причины ──────────────────────────────── */}
      <RiskMeter
        score={e.riskScore}
        codes={e.riskCodes}
        reasons={flags}
        state={e.riskState}
        completenessPercent={e.riskCompletenessPercent}
        missingChecks={e.missingChecks}
        updatedAt={e.riskUpdatedAt}
      />

      {/* Покупки размеченных кошельков. Молчит, когда их нет:
          «0 смарт-денег» на каждой карточке перестаёт читаться. */}
      {e.wallets && (e.wallets.smart > 0 || e.wallets.whale > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-raised px-2.5 py-2 text-[11px]">
          {e.wallets.smart > 0 && (
            <span className="text-up">
              {e.wallets.smart} с историей · {fmtUsd(e.wallets.smartVolumeUsd)}
            </span>
          )}
          {e.wallets.whale > 0 && <span className="text-accent">{e.wallets.whale} крупных</span>}
          <span className="num ml-auto text-muted">{e.wallets.strength}/100</span>
        </div>
      )}

      {/* ── 6. Куда идти дальше ────────────────────────────────── */}
      <footer className="mt-auto flex items-center gap-2 border-t border-border pt-3">
        <CopyAddress address={e.address} />

        <div className="ml-auto flex items-center gap-2">
          {onOpen && (
            <button
              onClick={onOpen}
              className="rounded-lg px-2.5 py-2 text-xs text-muted transition-colors hover:text-white"
            >
              Подробнее
            </button>
          )}
          {chain && (
            <a
              href={chain.dexScreener(e.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-accent/15 px-3 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/25"
            >
              Открыть график
            </a>
          )}
        </div>
      </footer>
    </article>
  );
}

/**
 * Короткий адрес с копированием.
 *
 * Заменяет кнопку «Копировать адрес» во всю ширину карточки. Та занимала
 * место главного действия, хотя копирование — действие вспомогательное.
 * Здесь адрес заодно виден: тикер не уникален, и сверить контракт
 * глазами человек должен иметь возможность не открывая ничего.
 */
export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={address}
      aria-label={`Копировать адрес ${address}`}
      className="num flex min-h-[36px] items-center gap-1.5 rounded-lg px-1.5 text-[11px] text-muted transition-colors hover:text-white"
    >
      {short(address)}
      {copied ? (
        <span className="text-up">скопировано</span>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  );
}

export function short(a: string): string {
  if (!a) return '';
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="num truncate text-[13px]">{value}</div>
    </div>
  );
}
