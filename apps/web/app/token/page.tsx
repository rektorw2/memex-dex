'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { fetcher, fmtPrice, fmtUsd, fmtPct } from '@/lib/api';
import { CHAINS, chainLabel, geckoTerminalPool } from '@/lib/chains';
import { PriceChart } from '@/components/PriceChart';
import { TradePanel } from '@/components/TradePanel';
import { ResearchPanel } from '@/components/ResearchPanel';
import { WalletSignal } from '@/components/WalletSignal';

/**
 * Страница токена.
 *
 * Идентификатор передаётся параметром запроса, а не сегментом пути.
 * Причина: сайт собирается статическим экспортом, а маршрут вида
 * /token/[id] потребовал бы перечислить все существующие токены на
 * этапе сборки. Токены появляются каждый час, так что это невозможно.
 */
export default function TokenPageWrapper() {
  return (
    <Suspense fallback={<div className="text-muted py-20 text-center">Загрузка…</div>}>
      <TokenPage />
    </Suspense>
  );
}

const INTERVALS = ['5m', '1h', '1d'] as const;

function TokenPage() {
  const id = useSearchParams().get('id');
  const [interval, setInterval] = useState<string>('5m');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // localStorage доступен только на клиенте; читаем после монтирования,
    // иначе Next выдаст рассинхрон при гидратации.
    setIsAdmin(localStorage.getItem('role') === 'ADMIN');
  }, []);

  const { data, error, isLoading, mutate } = useSWR<any>(
    id ? `/tokens/${id}/overview` : null,
    fetcher,
    { refreshInterval: 20_000 },
  );

  const { data: candles } = useSWR(
    data?.token?.hasChart ? `/tokens/${id}/candles?interval=${interval}` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const { data: portfolio } = useSWR<any>('/portfolio', fetcher, { refreshInterval: 15_000 });
  const { data: tokens } = useSWR<any[]>('/tokens?limit=200', fetcher);
  const usdc = tokens?.find((t) => t.symbol === 'USDC');

  if (!id) return <Empty>Не указан токен</Empty>;
  if (isLoading) return <Empty>Загрузка…</Empty>;
  if (error) return <Empty>Не удалось загрузить данные токена</Empty>;
  if (!data) return <Empty>Токен не найден</Empty>;

  const t = data.token;
  const risk = data.risk;
  const chain = CHAINS[t.chain];
  const change = Number(t.priceChange24h ?? 0);
  const position = portfolio?.holdings?.find((h: any) => h.tokenId === t.id);
  const poolUrl = t.poolAddress ? geckoTerminalPool(t.chain, t.poolAddress) : null;

  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm text-muted hover:text-white inline-block">
        ← К списку
      </Link>

      {/* Шапка */}
      <div className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold">{t.symbol}</h1>
              {t.isVerified ? (
                <span className="text-xs px-2 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                  проверен
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded bg-border text-muted">
                  не проверен
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded bg-border text-muted">
                {chainLabel(t.chain)}
              </span>
            </div>
            <p className="text-muted mt-1">{t.name}</p>
          </div>

          <div className="ml-auto text-right">
            <div className="text-2xl sm:text-3xl num">{fmtPrice(t.priceUsd)}</div>
            {t.priceChange24h != null && (
              <div className={`num ${change >= 0 ? 'text-up' : 'text-down'}`}>
                {fmtPct(change)} за 24 часа
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4 text-xs">
          <ExternalLink href={chain?.explorerToken(t.address) ?? '#'}>
            Обозреватель
          </ExternalLink>
          <ExternalLink href={chain?.dexScreener(t.address) ?? '#'}>
            DexScreener
          </ExternalLink>
          {poolUrl && <ExternalLink href={poolUrl}>GeckoTerminal</ExternalLink>}
          <button
            onClick={() => navigator.clipboard?.writeText(t.address)}
            className="px-2 py-1 rounded bg-border text-muted hover:text-white font-mono break-address text-left"
            title="Скопировать адрес контракта"
          >
            {t.address.slice(0, 6)}…{t.address.slice(-4)}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-8 space-y-4">
          {/* График */}
          <div className="panel p-4">
            <div className="flex gap-1 mb-3">
              {INTERVALS.map((iv) => (
                <button
                  key={iv}
                  onClick={() => setInterval(iv)}
                  className={`px-2 py-1 rounded text-xs ${
                    interval === iv ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'
                  }`}
                >
                  {iv}
                </button>
              ))}
            </div>

            {Array.isArray(candles) && candles.length > 0 ? (
              <PriceChart candles={candles as never} height={400} />
            ) : (
              <div className="h-[400px] flex items-center justify-center text-muted text-sm">
                {t.hasChart ? 'Свечи загружаются' : 'Пул ликвидности не найден'}
              </div>
            )}
          </div>

          {/* Метрики рынка */}
          <div className="panel p-4">
            <h2 className="font-medium mb-3">Рынок</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <Metric label="Ликвидность" value={fmtUsd(t.liquidityUsd)}
                      hint="Сколько всего в пуле. Чем меньше, тем дороже выход из позиции" />
              <Metric label="Объём 24ч" value={fmtUsd(t.volume24hUsd)} />
              <Metric label="FDV" value={fmtUsd(t.fdvUsd)}
                      hint="Полная оценка при выпуске всего предложения" />
              <Metric label="Держателей" value={t.holders?.toLocaleString('ru') ?? '—'} />
            </div>

            {t.liquidityUsd && t.volume24hUsd && (
              <p className="text-xs text-muted mt-4 leading-relaxed">
                Оборачиваемость{' '}
                <span className="num text-white">
                  {(Number(t.volume24hUsd) / Number(t.liquidityUsd)).toFixed(1)}×
                </span>{' '}
                — во столько раз дневной объём превышает ликвидность пула.
                Значения выше 10 обычно означают спекулятивный ажиотаж,
                ниже 0.5 — что рынок почти не торгуется.
              </p>
            )}
          </div>

          {/* Риски */}
          <div className="panel p-4">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="font-medium">Оценка риска</h2>
              <span
                className={`text-2xl num ${
                  risk.score > 60 ? 'text-down' : risk.score > 30 ? 'text-yellow-400' : 'text-up'
                }`}
              >
                {risk.score}
              </span>
              <span className="text-xs text-muted">из 100</span>
            </div>

            <div className="h-2 bg-border rounded overflow-hidden mb-3">
              <div
                className={`h-full ${risk.score > 60 ? 'bg-down' : risk.score > 30 ? 'bg-yellow-400' : 'bg-up'}`}
                style={{ width: `${risk.score}%` }}
              />
            </div>

            {risk.flags.length > 0 ? (
              <ul className="space-y-1.5 text-sm">
                {risk.flags.map((f: string, i: number) => (
                  <li key={i} className="flex gap-2 text-muted">
                    <span className="text-down">•</span>{f}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Явных признаков опасности не обнаружено.</p>
            )}

            {!risk.tradeable && (
              <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2 mt-3">
                Торговля этим токеном заблокирована платформой.
              </p>
            )}

            <p className="text-xs text-muted mt-4 leading-relaxed">
              Оценка учитывает ликвидность, возраст пула, концентрацию у крупных
              держателей и права эмитента. Низкий балл не означает безопасность:
              мем-коин может обесцениться до нуля при любых метриках.
            </p>
          </div>

          {/* Кто покупает — грузится отдельным запросом, чтобы не
              задерживать основные данные страницы. */}
          <WalletSignal chain={t.chain} address={t.address} />

          <ResearchPanel
            tokenId={t.id}
            research={data.research}
            isAdmin={isAdmin}
            onUpdated={() => mutate()}
          />

          {/* Коллы по токену */}
          {data.calls?.length > 0 && (
            <div className="panel p-4">
              <h2 className="font-medium mb-3">Коллы аналитиков</h2>
              <div className="space-y-3">
                {data.calls.map((c: any) => (
                  <div key={c.id} className="bg-bg rounded-md p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-medium text-sm">{c.title}</div>
                      <StatusBadge status={c.status} />
                    </div>
                    <p className="text-xs text-muted mt-1.5 line-clamp-2">{c.thesis}</p>
                    <div className="flex gap-4 mt-2 text-xs">
                      <span className="text-muted">
                        вход <span className="num text-white">{fmtPrice(c.entryPriceUsd)}</span>
                      </span>
                      {c.resultPct != null && (
                        <span className={Number(c.resultPct) >= 0 ? 'text-up num' : 'text-down num'}>
                          {fmtPct(c.resultPct)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Сделки на платформе */}
          <div className="panel p-4">
            <h2 className="font-medium mb-3">Сделки на платформе</h2>
            <div className="grid grid-cols-3 gap-4 text-sm mb-4">
              <Metric label="Всего сделок" value={String(data.platformStats.trades)} />
              <Metric label="Оборот" value={fmtUsd(data.platformStats.volumeUsd)} />
              <Metric label="Держат сейчас" value={String(data.platformStats.holders)} />
            </div>

            {data.recentTrades?.length > 0 ? (
              <div className="scroll-x">
              <table className="w-full text-sm min-w-[380px]">
                <thead className="text-xs text-muted border-b border-border">
                  <tr>
                    <th className="text-left font-normal py-2">Время</th>
                    <th className="text-left font-normal py-2">Тип</th>
                    <th className="text-right font-normal py-2">Цена</th>
                    <th className="text-right font-normal py-2">Объём</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentTrades.map((tr: any) => (
                    <tr key={tr.id} className="border-b border-border/40">
                      <td className="py-1.5 text-xs text-muted">
                        {new Date(tr.date).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className={tr.side === 'BUY' ? 'text-up text-xs' : 'text-down text-xs'}>
                        {tr.side === 'BUY' ? 'покупка' : 'продажа'}
                        {tr.source === 'COPY_TRADE' && (
                          <span className="ml-1.5 text-[10px] text-accent">копия</span>
                        )}
                      </td>
                      <td className="text-right num text-xs">{fmtPrice(tr.priceUsd)}</td>
                      <td className="text-right num text-xs">{fmtUsd(tr.valueUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <p className="text-sm text-muted">Сделок пока не было.</p>
            )}
          </div>
        </div>

        {/* Правая колонка */}
        <div className="col-span-12 xl:col-span-4 space-y-4">
          {usdc && !t.isQuote && (
            <TradePanel
              tokenId={t.id}
              tokenSymbol={t.symbol}
              quoteTokenId={usdc.id}
              quoteSymbol="USDC"
              chain={t.chain}
              currentPriceUsd={Number(t.priceUsd ?? 0)}
              availableQuote={Number(portfolio?.cashUsd ?? 0)}
              availableToken={Number(position?.quantity ?? 0)}
            />
          )}

          {position && (
            <div className="panel p-4">
              <h3 className="text-sm font-medium mb-3">Ваша позиция</h3>
              <div className="space-y-2 text-sm">
                <Row label="Количество" value={Number(position.quantity).toLocaleString('ru')} />
                <Row label="Средняя цена" value={fmtPrice(position.avgCostUsd)} />
                <Row label="Стоимость" value={fmtUsd(position.valueUsd)} />
                <Row
                  label="Нереализ. PnL"
                  value={`${fmtUsd(position.unrealizedPnlUsd)} (${fmtPct(position.unrealizedPnlPct)})`}
                  tone={Number(position.unrealizedPnlUsd) >= 0 ? 'up' : 'down'}
                />
                {Number(position.copiedSharePct) > 0 && (
                  <p className="text-xs text-muted pt-2 border-t border-border">
                    {position.copiedSharePct}% позиции набрано копитрейдингом — с этой
                    доли при продаже удержат 10% от прибыли.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="panel p-4">
            <h3 className="text-sm font-medium mb-3">О токене</h3>
            <div className="space-y-2 text-sm">
              <Row label="Сеть" value={chainLabel(t.chain)} />
              <Row label="Decimals" value={String(t.decimals)} />
              <Row label="Источник" value={t.source === 'auto' ? 'автоимпорт' : 'добавлен вручную'} />
              <Row
                label="В списке с"
                value={new Date(t.listedAt).toLocaleDateString('ru')}
              />
              {t.metricsUpdated && (
                <Row
                  label="Данные от"
                  value={new Date(t.metricsUpdated).toLocaleTimeString('ru', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-24 text-center text-muted">
      <p>{children}</p>
      <Link href="/" className="text-accent text-sm mt-3 inline-block">← К списку токенов</Link>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="px-2 py-1 rounded bg-border text-muted hover:text-white transition-colors"
    >
      {children} ↗
    </a>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-muted" title={hint}>
        {label}{hint && <span className="ml-1 opacity-60">?</span>}
      </div>
      <div className="num">{value}</div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={`num text-right ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </span>
    </div>
  );
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  PUBLISHED: { text: 'активен', cls: 'bg-accent/15 text-accent' },
  HIT_TARGET: { text: 'цель взята', cls: 'bg-up/15 text-up' },
  STOPPED_OUT: { text: 'стоп', cls: 'bg-down/15 text-down' },
  EXPIRED: { text: 'истёк', cls: 'bg-border text-muted' },
  CANCELLED: { text: 'отменён', cls: 'bg-border text-muted' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { text: status, cls: 'bg-border text-muted' };
  return <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${s.cls}`}>{s.text}</span>;
}
