'use client';

import useSWR from 'swr';
import {
  pnlBlock,
  shouldRequestPrivateData,
  formatExactUsd,
  formatSignedUsd,
  PNL_EMPTY_TEXT,
  PNL_DISCLAIMER,
} from '@memex/core';
import { fetcher } from '@/lib/api';
import { useAccess } from '@/lib/access';

/**
 * PnL без догадок.
 *
 * Раздел необязательный: он показывает результат человека, а тарифы
 * существуют независимо от того, есть ли у него позиции. Поэтому его
 * ошибка не должна ломать страницу — при неудачном ответе он просто
 * не отрисовывается, и человек по-прежнему видит цены.
 *
 * Гостю не показывается вовсе и не запрашивается: приватных данных
 * у него нет по определению.
 *
 * Ноль вместо неизвестного значения здесь запрещён. «Результат равен
 * нулю» и «результата ещё нет» — разные утверждения, и второе
 * встречается чаще.
 */
export function PnlBlock() {
  const { anonymous, loading: accessLoading } = useAccess();

  const canAsk = shouldRequestPrivateData({ authenticated: !anonymous, accessLoading });

  const { data, error, isLoading } = useSWR<Record<string, unknown>>(
    canAsk ? '/portfolio' : null,
    fetcher,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );

  // Гость, загрузка прав, отказ сервера — во всех трёх случаях раздела
  // просто нет. Пустой блок с прочерками сообщал бы, что данные есть
  // и они нулевые.
  if (!canAsk || error) return null;

  if (isLoading) {
    return (
      <section className="mt-14">
        <div className="skeleton h-5 w-40" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="surface-2 p-4">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton mt-3 h-6 w-20" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const block = pnlBlock(data as never, { usd: (v) => (v == null ? '—' : formatExactUsd(v)), signedUsd: formatSignedUsd });

  return (
    <section className="mt-14" aria-labelledby="pnl-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pnl-heading" className="text-lg font-semibold">
          PnL без догадок
        </h2>
        <p className="text-xs text-muted">Ваш результат, а не пример</p>
      </div>

      {!block.hasPositions ? (
        <p className="surface-2 mt-4 p-5 text-sm text-muted">{PNL_EMPTY_TEXT}</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {block.cards.map((c) => (
            <div key={c.key} className="surface-2 p-4" title={c.hint}>
              <p className="text-xs leading-snug text-muted">{c.label}</p>

              <p
                className={`num mt-2 text-xl font-semibold ${
                  // Зелёный и красный означают деньги и только их.
                  // Стоимость портфеля знака не имеет, и красить её
                  // значило бы придать ей смысл прибыли.
                  c.text == null || !c.financial
                    ? ''
                    : c.sign > 0
                      ? 'text-up'
                      : c.sign < 0
                        ? 'text-down'
                        : ''
                }`}
              >
                {c.text ?? '—'}
              </p>

              {c.text == null && (
                <p className="mt-1 text-[11px] leading-snug text-muted/70">{c.hint}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted/70">{PNL_DISCLAIMER}</p>
    </section>
  );
}
