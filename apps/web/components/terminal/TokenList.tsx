'use client';

import { TokenLogo } from '@/components/TokenLogo';
import { fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
import type { Token } from './types';
import { CHAIN_LABEL } from './types';

/**
 * Список рынков.
 *
 * Строка целиком — одна кнопка. Раньше в конце каждой висела ссылка
 * «подробнее»: она повторялась шестьдесят раз, съедала ширину и
 * создавала две разные цели нажатия в одной строке. Теперь нажатие
 * выбирает токен, а перейти на его страницу можно из шапки графика.
 *
 * Числовые колонки выровнены по правому краю и набраны моноширинным:
 * в плотной таблице сравнение идёт по разрядам, и «плавающая» ширина
 * цифр эту возможность убивает.
 */

interface Props {
  tokens: Token[] | undefined;
  activeId: string | null;
  onSelect: (t: Token) => void;
  /** Загрузка первой порции. */
  isLoading?: boolean;
  /** Компактный режим для телефона: крупнее площадь нажатия. */
  touch?: boolean;
}

export function TokenList({ tokens, activeId, onSelect, isLoading, touch }: Props) {
  if (isLoading && !tokens) {
    return (
      <div className="space-y-px p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-row animate-pulse items-center gap-3 px-2">
            <div className="h-8 w-8 shrink-0 rounded-full bg-raised" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-16 rounded bg-raised" />
              <div className="h-2.5 w-24 rounded bg-raised/60" />
            </div>
            <div className="h-3 w-16 rounded bg-raised" />
          </div>
        ))}
      </div>
    );
  }

  const rows = tokens?.filter((t) => !t.isQuote) ?? [];

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <p className="text-sm text-muted">Ничего не найдено</p>
        <p className="max-w-[260px] text-xs leading-relaxed text-muted/70">
          Попробуйте снять фильтры. Если список пуст совсем — импортёр наполняет
          его раз в час, запустить сразу можно из админки.
        </p>
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Список токенов" className="min-w-0">
      {/* Заголовок колонок липнет к верху при прокрутке списка. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[11px] uppercase tracking-wide text-muted">
        <span className="flex-1">Токен</span>
        <span className="w-[92px] text-right">Цена</span>
        <span className="w-[68px] text-right">24ч</span>
      </div>

      {rows.map((t) => {
        const ch = t.priceChange24h == null ? null : Number(t.priceChange24h);
        const isActive = t.id === activeId;

        return (
          <button
            key={t.id}
            role="option"
            aria-selected={isActive}
            onClick={() => onSelect(t)}
            className={`relative flex w-full items-center gap-3 border-b border-border/50 px-3 text-left transition-colors ${
              touch ? 'min-h-[60px] py-2' : 'h-row'
            } ${
              isActive
                ? 'bg-accent/10'
                : 'hover:bg-raised active:bg-raised/70'
            }`}
          >
            {/* Полоса слева вместо заливки целиком: выбранная строка
                должна отличаться, но не выпадать из ритма таблицы. */}
            {isActive && (
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
            )}

            <TokenLogo symbol={t.symbol} address={t.address} logoUrl={t.logoUrl} size={32} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{t.symbol}</span>
                {t.isVerified && (
                  <span className="shrink-0 text-[10px] text-accent" title="Проверен админом">
                    ✓
                  </span>
                )}
                <ScamMark verdict={t.scamVerdict} reasons={t.scamReasons} />
              </div>
              <div className="truncate text-xs text-muted">
                {CHAIN_LABEL[t.chain] ?? t.chain} · {fmtUsd(t.liquidityUsd)}
              </div>
            </div>

            <span className="num w-[92px] shrink-0 text-right text-sm">
              {fmtPrice(t.priceUsd)}
            </span>

            <span
              className={`num w-[68px] shrink-0 text-right text-sm ${
                ch == null ? 'text-muted' : ch >= 0 ? 'text-up' : 'text-down'
              }`}
              title={t.priceChange24h ?? undefined}
            >
              {/* Знак ставится всегда: полагаться только на цвет нельзя —
                  восемь процентов мужчин их не различают. */}
              {ch == null ? '—' : fmtPct(ch)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Метка проверки токена.
 *
 * Три состояния, и третье не менее важно первых двух: «не проверялся»
 * должно отличаться от «проверен и чист». Молчание на непроверенном
 * читается как одобрение, хотя означает лишь то, что до него ещё
 * не дошла очередь.
 */
export function ScamMark({
  verdict,
  reasons,
}: {
  verdict?: string | null;
  reasons?: { blockers?: string[]; warnings?: string[] } | null;
}) {
  if (!verdict) {
    return (
      <span
        title="Контракт ещё не проверялся — это не значит, что токен чист"
        className="shrink-0 text-[10px] text-muted"
      >
        ?
      </span>
    );
  }

  if (verdict === 'OK') return null;

  const list = verdict === 'BLOCK' ? reasons?.blockers : reasons?.warnings;
  const hint = list?.length ? list.join('; ') : 'Требует внимания';

  return (
    <span
      title={hint}
      className={`shrink-0 text-[10px] ${verdict === 'BLOCK' ? 'text-down' : 'text-warn'}`}
    >
      {verdict === 'BLOCK' ? '⛔' : '⚠'}
    </span>
  );
}
