'use client';

import useSWR from 'swr';
import Link from 'next/link';
import {
  timeAgo,
  confidenceOf,
  winRateView,
  formatMultiple,
  formatEntryTime,
  CATEGORY_LABELS,
  CATEGORY_EXPLAIN,
} from '@memex/core';
import { fetcher, fmtUsd, fmtPrice } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { SmartScore, Identicon } from './SmartScore';
import { WalletIdentity, statsOf, categoryOf, type Wallet } from './WalletViews';
import { FavoriteStar } from './FavoriteStar';
import { PnlBreakdown } from './PnlValue';

/**
 * Подробности кошелька.
 *
 * На широком экране — панель справа, на телефоне — экран целиком.
 * Причина одна: строка списка обязана оставаться короткой, а вопросов
 * у человека, который всерьёз рассматривает кошелёк, заметно больше,
 * чем помещается в строку.
 *
 * Порядок разделов повторяет порядок решения: кто это, насколько
 * надёжна оценка, из чего она сложилась, что кошелёк делал недавно.
 * Предупреждение о рисках стоит перед действием, а не после него.
 */

export function WalletDrawer({ wallet: w, onClose }: { wallet: Wallet; onClose: () => void }) {
  // Сделки подгружаются только при открытии: в списке они не нужны,
  // а весят больше, чем всё остальное вместе.
  const { data } = useSWR<any>(`/wallets/${w.chain}/${w.address}`, fetcher, {
    revalidateOnFocus: false,
  });

  // Лента и избранное могут открыть панель по одному адресу. Полная
  // сводка подменяет краткую, как только пришёл ответ сервера.
  const wallet: Wallet = data?.wallet ? { ...w, ...data.wallet } : w;
  const chain = CHAINS[wallet.chain];
  const s = statsOf(wallet);
  const conf = confidenceOf(s.settled);
  const wr = winRateView(wallet.wins2x, s.settled);
  const cat = categoryOf(wallet);
  const trades: any[] = data?.trades ?? [];
  const pnl = data?.pnl ?? null;

  return (
    <div className="panel fixed inset-0 z-50 flex flex-col overflow-hidden lg:inset-y-4 lg:left-auto lg:right-4 lg:w-[440px] lg:rounded-xl lg:border">
      <header className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border bg-panel px-4 py-3">
        <button
          onClick={onClose}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-white"
          aria-label="Закрыть"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <WalletIdentity wallet={wallet} size={32} />
        </div>

        {/* Та же звезда, что в списке и в ленте: состояние общее,
            и переключение здесь видно везде без перезагрузки. */}
        <FavoriteStar chain={wallet.chain} address={wallet.address} />
      </header>

      <div className="scroll-y flex-1 space-y-4 p-4">
        {/* ── Оценка и уверенность ────────────────────────────── */}
        <section className="space-y-2 rounded-lg bg-raised p-3">
          <SmartScore stats={s} />
          <p className="text-[11px] leading-relaxed text-muted">{conf.explanation}</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Локальный PnL</h2>
          <div className="rounded-lg bg-raised p-3">
            <PnlBreakdown
              realized={pnl?.realizedUsd ?? null}
              unrealized={pnl?.unrealizedUsd ?? null}
              total={pnl?.totalUsd ?? null}
              isPending={pnl == null || pnl.state === 'pending' || pnl.state === 'empty'}
              hasIncompleteHistory={pnl?.state === 'incomplete_history'}
              isAmbiguous={pnl?.state === 'ambiguous'}
              isPriceStale={pnl?.state === 'stale'}
              computedAt={pnl?.computedAt ? new Date(pnl.computedAt).getTime() : null}
            />
            <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px]">
              <span className="text-muted">Стоимость открытых активов</span>
              <span className="num">
                {pnl?.assetsUsd == null
                  ? pnl?.state === 'stale'
                    ? 'Цена устарела'
                    : 'Считается'
                  : fmtUsd(pnl.assetsUsd)}
              </span>
            </div>
            {pnl?.state === 'ambiguous' && (
              <p className="mt-2 text-[10px] leading-relaxed text-warn/80">
                Порядок части сделок неоднозначен — итог скрыт, чтобы не показывать догадку.
              </p>
            )}
            {pnl?.state === 'stale' && (
              <p className="mt-2 text-[10px] leading-relaxed text-warn/80">
                Цена открытой позиции устарела. Реализованный результат сохранён,
                общий появится после обновления котировки.
              </p>
            )}
          </div>
        </section>

        {/* ── Из чего сложилась оценка ────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Результаты</h2>
          <div className="grid grid-cols-2 gap-2">
            <Tile
              label="Сделки ≥2×"
              value={wr.text}
              tone={wr.isImpossible ? 'down' : undefined}
            />
            <Tile label="Средний максимум" value={formatMultiple(wallet.avgPeakMultiple)} />
            <Tile
              label="Медианный вход"
              value={formatEntryTime(wallet.medianEntryHours)}
              hint="После запуска пула"
            />
            <Tile label="Обнулившихся" value={String(wallet.rugs ?? 0)} tone={(wallet.rugs ?? 0) > 0 ? 'down' : undefined} />
            <Tile label="Объём покупок" value={fmtUsd(wallet.volumeUsd)} />
            <Tile
              label="Категория"
              value={CATEGORY_LABELS[cat]}
              hint={CATEGORY_EXPLAIN[cat]}
            />
          </div>
        </section>

        {/* ── Недавние сделки ─────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Последние сделки</h2>

          {trades.length === 0 ? (
            <p className="rounded-md bg-raised p-3 text-xs leading-relaxed text-muted">
              {data
                ? 'Сделок за период наблюдения не зафиксировано.'
                : 'Загружаем историю…'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {trades.slice(0, 12).map((t: any) => (
                <li
                  key={t.id}
                  className="flex items-center gap-2 rounded-md bg-raised px-2.5 py-2 text-xs"
                >
                  <span
                    className={`shrink-0 text-[10px] ${t.side === 'BUY' ? 'text-up' : 'text-down'}`}
                  >
                    {t.side === 'BUY' ? 'покупка' : 'продажа'}
                  </span>
                  {t.tokenId ? (
                    <Link
                      href={`/terminal/?token=${encodeURIComponent(t.tokenId)}`}
                      className="num truncate transition-colors hover:text-accent"
                      title="Открыть токен в графике Memex"
                    >
                      {t.tokenSymbol ?? shortAddr(t.tokenAddress)}
                    </Link>
                  ) : (
                    <span className="num truncate">{t.tokenSymbol ?? shortAddr(t.tokenAddress)}</span>
                  )}
                  <span className="num ml-auto shrink-0">{fmtUsd(t.amountUsd)}</span>
                  {t.growthPercent != null && Number.isFinite(t.growthPercent) && (
                    <span className={`num shrink-0 ${t.growthPercent >= 0 ? 'text-up' : 'text-down'}`}>
                      {t.growthPercent >= 0 ? '+' : ''}{Number(t.growthPercent).toFixed(1)}%
                    </span>
                  )}
                  {t.outcomeMultiple != null && (
                    <span
                      className={`num shrink-0 ${
                        Number(t.outcomeMultiple) >= 1 ? 'text-up' : 'text-down'
                      }`}
                    >
                      {formatMultiple(Number(t.outcomeMultiple))}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted/70">
                    {timeAgo(t.tradedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Предупреждение перед действием, а не после ──────── */}
        <p className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[11px] leading-relaxed text-warn">
          Прошлые результаты не предсказывают будущие. Повторение чужих сделок
          не снижает риск, а переносит его на вас: вы входите позже и по другой цене.
        </p>
      </div>

      <footer className="safe-bottom sticky bottom-0 flex gap-2 border-t border-border bg-panel p-4">
        {chain && (
          <a
            href={chain.explorerAddress(wallet.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="tap flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm text-muted"
          >
            Обозреватель
          </a>
        )}
        <button
          onClick={() => navigator.clipboard?.writeText(wallet.address)}
          className="tap flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm text-muted"
        >
          Копировать адрес
        </button>
      </footer>
    </div>
  );
}

function shortAddr(a?: string | null): string {
  if (!a) return '—';
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'down';
}) {
  return (
    <div className="rounded-lg bg-raised p-2.5" title={hint}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num truncate text-[13px] ${tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </div>
    </div>
  );
}
