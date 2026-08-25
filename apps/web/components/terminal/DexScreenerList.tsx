'use client';

import useSWR from 'swr';
import { riskBand, riskCodeLabel } from '@memex/core';
import { fetcher, fmtUsd, fmtPrice, fmtPct } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { TokenLogo } from '@/components/TokenLogo';

/**
 * Продвигаемые токены DexScreener.
 *
 * Первое, что должен понять человек, открывший эту вкладку, — что это
 * за список. У DexScreener он называется «boosted», и слово читается
 * как «отобранные» или «на подъёме». На деле оно означает «за место
 * в списке заплатили»: там прозрачный ценник, купить может кто угодно,
 * и мошенник покупает первым, потому что у него это окупается быстрее
 * всех.
 *
 * Поэтому пояснение стоит вверху и написано прямо. Умолчать о нём
 * значило бы выдать рекламный блок за подборку, а разницу человек
 * обнаружил бы своими деньгами.
 *
 * Сам список проходит нашу проверку риска: заблокированные не
 * показываются вообще, непроверенные помечены как непроверенные.
 * Оплаченное продвижение в оценку не входит ни в плюс, ни в минус —
 * бюджет на маркетинг ничего не говорит о свойствах контракта.
 */

interface DexToken {
  id: string | null;
  chain: string;
  address: string;
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  riskLevel: string | null;
  riskCodes: string[];
  riskScore: number | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
  priceChange24h: string | null;
  boostAmount: number | null;
  isNew: boolean;
}

export function DexScreenerList({
  chain,
  onChain,
  safeOnly,
  onSafeOnly,
}: {
  chain: string;
  onChain?: (v: string) => void;
  safeOnly: boolean;
  onSafeOnly?: (v: boolean) => void;
}) {
  /*
   * Фильтры вкладки — свои.
   *
   * Прежде сюда приходили `chain` и `safeOnly` от «Рынка». Человек
   * включал их для своей витрины, а действовали они на чужую:
   * `safeOnly` по умолчанию включён, и вкладка молча оставляла
   * только те продвигаемые токены, которые уже прошли нашу проверку.
   * Их единицы — отсюда и список из двух строк.
   */
  const params = new URLSearchParams({ limit: '40' });
  if (chain) params.set('chain', chain);
  if (!safeOnly) params.set('safeOnly', 'false');

  const { data, isLoading } = useSWR<{
    source: string;
    total: number;
    unchecked: number;
    tokens: DexToken[];
    pending?: DexToken[];
  }>(`/tokens/dexscreener?${params}`, fetcher, {
    // Состав рекламного списка меняется часами, а не секундами:
    // продвижение покупают на сутки.
    refreshInterval: 120_000,
    keepPreviousData: true,
  });

  const tokens = data?.tokens ?? [];

  /*
   * Ожидающие проверки — отдельный список, а не отсутствие списка.
   *
   * Раньше сервер удалял их фильтром `safeOnly`, и при семнадцати
   * ожидающих человек видел «Ничего не прошло проверку» на пустом
   * экране. Показать их можно и нужно, но так, чтобы `pending`
   * нельзя было прочесть как «проверено».
   */
  const pending = data?.pending ?? [];

  return (
    <div className="space-y-3">
      {/* Пояснение первым делом, а не сноской внизу. */}
      <div className="rounded-lg border border-warn/30 bg-warn/10 p-3">
        <p className="text-xs font-medium text-warn">Это оплаченное продвижение</p>
        <p className="mt-1 text-[11px] leading-relaxed text-warn/80">
          DexScreener берёт деньги за место в этом списке. Попадание сюда говорит
          о бюджете на маркетинг, а не о качестве токена. Уровень риска рядом
          с каждым — наш собственный, продвижение в нём не учитывается.
        </p>
      </div>

      {data && (
        <p className="text-[11px] text-muted">
          В списке DexScreener: {data.total}
          {data.unchecked > 0 && (
            <>
              {' · '}
              <span className="text-muted/70">
                не проверено нами: {data.unchecked} — они появятся по мере проверки
              </span>
            </>
          )}
        </p>
      )}

      {isLoading && tokens.length === 0 ? (
        <div className="space-y-px p-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex h-row animate-pulse items-center gap-3 px-2">
              <div className="h-8 w-8 shrink-0 rounded-full bg-raised" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-16 rounded bg-raised" />
                <div className="h-2.5 w-24 rounded bg-raised/60" />
              </div>
            </div>
          ))}
        </div>
      ) : tokens.length === 0 && pending.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-muted">Показывать нечего</p>
          <p className="mx-auto mt-1 max-w-[280px] text-xs leading-relaxed text-muted/70">
            {data && data.total > 0
              ? `Все ${data.total} продвигаемых токенов не прошли проверку и скрыты.`
              : 'Список продвижения пуст либо DexScreener недоступен.'}
          </p>
        </div>
      ) : (
        <div className="min-w-0">
          {tokens.length > 0 && (
            <div role="list">
              {tokens.map((t) => (
                <Row key={`${t.chain}:${t.address}`} token={t} />
              ))}
            </div>
          )}

          {pending.length > 0 && (
            <>
              <div className="border-y border-border bg-raised px-4 py-2">
                <p className="text-xs font-medium">Ещё не проверены — {pending.length}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                  Проверка не завершена: о риске этих токенов нам пока ничего
                  не известно. Торговля отсюда недоступна.
                </p>
              </div>

              <div role="list">
                {pending.map((t) => (
                  <Row key={`pending:${t.chain}:${t.address}`} token={t} pending />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ token: t, pending }: { token: DexToken; pending?: boolean }) {
  const band = riskBand(t.riskScore);
  const ch = t.priceChange24h == null ? null : Number(t.priceChange24h);
  const chain = CHAINS[t.chain];

  const tone =
    band?.tone === 'up'
      ? 'text-up'
      : band?.tone === 'warn'
        ? 'text-warn'
        : band?.tone === 'riskHigh'
          ? 'text-riskHigh'
          : band?.tone === 'down'
            ? 'text-down'
            : 'text-muted';

  return (
    <div
      className={`flex items-center gap-3 border-b border-border/50 px-3 py-2.5 ${
        // Ожидающие приглушены намеренно: они не должны выглядеть
        // наравне с проверенными.
        pending ? 'opacity-70' : ''
      }`}
    >
      <TokenLogo symbol={t.symbol} address={t.address} logoUrl={t.logoUrl} size={32} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{t.symbol}</span>

          {pending && (
            <span
              className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted"
              title="Проверка не завершена"
            >
              не проверен
            </span>
          )}

          {/* Уровень риска словом, а не только цветом. */}
          {!pending && band ? (
            <span className={`shrink-0 text-[10px] ${tone}`} title={band.label}>
              {band.sign} {Math.round(t.riskScore!)}
            </span>
          ) : (
            <span className="shrink-0 text-[10px] text-muted" title="Проверка ещё не выполнялась">
              не проверен
            </span>
          )}
        </div>

        <div className="truncate text-xs text-muted">
          {chainLabel(t.chain)} · {fmtUsd(t.liquidityUsd)}
          {t.riskCodes.length > 0 && <> · {riskCodeLabel(t.riskCodes[0]!)}</>}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="num text-sm">{fmtPrice(t.priceUsd)}</div>
        <div
          className={`num text-[11px] ${
            ch == null ? 'text-muted' : ch >= 0 ? 'text-up' : 'text-down'
          }`}
        >
          {ch == null ? '—' : fmtPct(ch)}
        </div>
      </div>

      {chain && (
        <a
          href={chain.dexScreener(t.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/15"
        >
          ↗
        </a>
      )}
    </div>
  );
}
