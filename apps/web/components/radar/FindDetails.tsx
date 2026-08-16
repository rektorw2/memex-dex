'use client';

import { riskBand, riskCodeLabel, timeAgo, exactTime, formatAge, multipleView } from '@memex/core';
import { fmtUsd, fmtPrice } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { TokenLogo } from '@/components/TokenLogo';
import { Sparkline } from '@/components/Sparkline';
import { CopyAddress, type RadarEvent } from './FindCard';

/**
 * Подробности находки.
 *
 * На телефоне открывается поверх ленты как отдельный экран, на десктопе
 * — как боковая панель. Причина в том, что карточка обязана оставаться
 * короткой: в неё помещается ответ на шесть вопросов, а вопросов
 * у заинтересовавшегося человека больше.
 *
 * Здесь показывается то, что в карточку не влезло и влезать не должно:
 * цена в момент находки рядом с текущей, полный разбор риска со всеми
 * причинами, состояние проверок безопасности, держатели.
 *
 * Отдельно про цену обнаружения. В карточке её нет намеренно — там
 * важен результат, а не арифметика. Но именно она объясняет, откуда
 * взялась кратность, и человек, который решает входить, имеет право
 * увидеть, от чего считали.
 */

export function FindDetails({
  event: e,
  onClose,
}: {
  event: RadarEvent;
  onClose: () => void;
}) {
  const chain = CHAINS[e.chain];
  const mv = multipleView(e.currentMultiple, e.peakMultiple);
  const band = riskBand(e.riskScore);
  const codes = e.riskCodes ?? [];
  const flags = Array.isArray(e.riskFlags) ? (e.riskFlags as string[]) : [];
  const points = Array.isArray(e.points) ? e.points : [];
  const enoughPoints = points.filter((p) => (p.m ?? p.p) != null).length >= 2;

  const tone =
    band?.tone === 'up'
      ? 'text-up'
      : band?.tone === 'warn'
        ? 'text-warn'
        : band?.tone === 'riskHigh'
          ? 'text-riskHigh'
          : 'text-down';

  return (
    <div className="flex h-full flex-col">
      {/* Шапка липкая: на длинном разборе кнопка назад не должна
          уезжать наверх — выход обязан быть под рукой всегда. */}
      <header className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border bg-panel px-4 py-3">
        <button
          onClick={onClose}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-white"
          aria-label="Назад к ленте"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>

        <TokenLogo symbol={e.symbol} address={e.address} logoUrl={null} size={32} />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{e.symbol}</div>
          <div className="truncate text-[11px] text-muted">{e.name}</div>
        </div>
      </header>

      <div className="scroll-y flex-1 space-y-4 p-4">
        {/* ── Что и когда нашли ─────────────────────────────────── */}
        <section className="space-y-2 rounded-lg bg-raised p-3">
          <Row label="Сеть" value={chainLabel(e.chain)} />
          <Row label="Обнаружен" value={`${timeAgo(e.firstSeenAt)} · в ${exactTime(e.firstSeenAt)}`} />
          <Row label="Источник" value={e.source} />
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">Контракт</span>
            <CopyAddress address={e.address} />
          </div>
        </section>

        {/* ── Что с ним стало ───────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-wide text-muted">Динамика</h2>

          {enoughPoints ? (
            <Sparkline points={points} height={120} />
          ) : (
            <div className="rounded-lg bg-raised px-3 py-4 text-center text-xs text-muted">
              Собираем данные · {points.length}{' '}
              {points.length === 1 ? 'точка' : points.length < 5 ? 'точки' : 'точек'}
              <div className="mt-1 text-[11px] text-muted/70">
                Наблюдение началось {timeAgo(e.firstSeenAt)}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Tile label="Цена при находке" value={fmtPrice(e.discoveryPriceUsd ?? null)} />
            <Tile label="Цена сейчас" value={fmtPrice(e.currentPriceUsd ?? e.priceUsd)} />
            <Tile
              label="Сейчас"
              value={mv.meaningful ? mv.currentPct : 'без движения'}
              tone={!mv.meaningful ? undefined : mv.isUp ? 'up' : 'down'}
            />
            <Tile label="Пик" value={mv.meaningful ? mv.peak : '—'} />
          </div>

          {mv.fadedFromPeak && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[11px] leading-relaxed text-warn">
              Пик пройден{e.peakAt ? ` ${timeAgo(e.peakAt)}` : ''}, сейчас токен заметно ниже.
              Кратность в заголовке относится к прошлому, а не к возможности войти сейчас.
            </p>
          )}
        </section>

        {/* ── Насколько опасно ──────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Риск</h2>

          {band ? (
            <>
              <div className={`flex items-baseline gap-2 ${tone}`}>
                <span className="text-base font-medium">{band.label}</span>
                <span className="num text-sm text-muted">{Math.round(e.riskScore!)}/100</span>
              </div>

              {/* Все причины разом: экран деталей — как раз то место,
                  где прятать их за «ещё N» бессмысленно. */}
              {codes.length > 0 ? (
                <ul className="space-y-1.5">
                  {codes.map((c, i) => (
                    <li key={c} className="flex gap-2 rounded-md bg-raised p-2.5">
                      <span className={`shrink-0 text-xs ${tone}`} aria-hidden>
                        {band.sign}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs">{riskCodeLabel(c)}</div>
                        {flags[i] && (
                          <div className="mt-0.5 text-[11px] leading-snug text-muted">
                            {flags[i]}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md bg-raised p-2.5 text-xs leading-relaxed text-muted">
                  Замечаний не найдено. Это не обещание: мем-коин может обесцениться
                  до нуля и без единого технического признака.
                </p>
              )}
            </>
          ) : (
            <p className="rounded-md bg-raised p-2.5 text-xs leading-relaxed text-muted">
              Проверка ещё не дошла до этой находки. Пустой уровень означает
              отсутствие сведений, а не их благополучие.
            </p>
          )}
        </section>

        {/* ── Ликвидность и держатели ───────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Пул</h2>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Ликвидность" value={fmtUsd(e.liquidityUsd)} />
            <Tile label="Возраст пула" value={formatAge(e.poolAgeHours)} />
            <Tile
              label="Держатели"
              value={e.holders != null ? e.holders.toLocaleString('ru-RU') : '—'}
            />
            <Tile
              label="Смарт-деньги"
              value={e.wallets?.smart ? `${e.wallets.smart} кошельков` : 'не замечены'}
              tone={e.wallets?.smart ? 'up' : undefined}
            />
          </div>
        </section>
      </div>

      {/* ── Действия ────────────────────────────────────────────── */}
      <footer className="safe-bottom sticky bottom-0 flex gap-2 border-t border-border bg-panel p-4">
        {chain && (
          <>
            <a
              href={chain.explorerToken(e.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="tap flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm text-muted"
            >
              Обозреватель
            </a>
            <a
              href={chain.dexScreener(e.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="tap flex h-11 flex-[2] items-center justify-center rounded-lg bg-accent text-sm font-medium text-white"
            >
              Открыть график
            </a>
          </>
        )}
      </footer>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="rounded-lg bg-raised p-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div
        className={`num truncate text-sm ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
