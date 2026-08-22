'use client';

import {
  COMPARISON_ROWS,
  SELLABLE_PLANS,
  comparisonCell,
  marketingFor,
  type ComparisonCell,
} from '@memex/core';

/**
 * Полная матрица возможностей.
 *
 * Строится из серверных capabilities: второй, записанный руками
 * список разошёлся бы с первым, и таблица начала бы обещать
 * не то, что даёт план.
 *
 * На широком экране — таблица. На телефоне таблица из четырёх
 * колонок неизбежно уезжает в горизонтальную прокрутку, а прокрутка
 * внутри страницы, которая и сама прокручивается, — способ потерять
 * содержимое. Поэтому там раскрывающиеся списки по планам: каждый
 * отвечает на вопрос «что входит сюда», и этого достаточно.
 */
export function Comparison({
  capabilitiesByPlan,
}: {
  capabilitiesByPlan: Record<string, string[]>;
}) {
  // Пока сервер не ответил, сравнивать нечего. Пустая таблица
  // с прочерками читалась бы как «ничего не входит».
  if (Object.keys(capabilitiesByPlan).length === 0) return null;

  return (
    <section className="mt-14" aria-labelledby="compare-heading">
      <h2 id="compare-heading" className="text-lg font-semibold">
        Что входит в каждый план
      </h2>

      {/* ─── Широкий экран ───────────────────────────────────────── */}
      <div className="surface-1 mt-4 hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-3 text-left font-medium text-muted">
                Возможность
              </th>
              {SELLABLE_PLANS.map((p) => (
                <th key={p} scope="col" className="w-32 px-4 py-3 text-center font-medium">
                  {marketingFor(p).title}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row.capability} className="border-b border-border/50 last:border-0">
                {/*
                  Доступное имя задаётся явно. Без него скринридер
                  склеивал соседние узлы без разделителя и произносил
                  «Свой портфельне отбирается» — визуальный отступ
                  паузы в речи не создаёт.
                */}
                <th
                  scope="row"
                  className="px-4 py-2.5 text-left font-normal"
                  aria-label={row.neverRevoked ? `${row.label}, не отбирается` : undefined}
                >
                  <span aria-hidden={row.neverRevoked || undefined}>{row.label}</span>
                  {row.neverRevoked && (
                    <span aria-hidden className="ml-2 text-[11px] text-muted">
                      не отбирается
                    </span>
                  )}
                </th>

                {SELLABLE_PLANS.map((p) => (
                  <td key={p} className="px-4 py-2.5 text-center">
                    <Cell value={comparisonCell(p, row.capability, capabilitiesByPlan)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── Телефон ─────────────────────────────────────────────── */}
      <div className="mt-4 space-y-2 md:hidden">
        {SELLABLE_PLANS.map((p) => (
          <details key={p} className="disclosure surface-1 overflow-hidden">
            <summary className="flex items-center gap-2 px-4 py-3 text-sm font-medium">
              <Chevron />
              {marketingFor(p).title}
              {marketingFor(p).comingSoon && (
                <span className="ml-auto text-[11px] text-muted">Coming soon</span>
              )}
            </summary>

            <ul className="disclosure-body space-y-2 border-t border-border px-4 py-3">
              {COMPARISON_ROWS.map((row) => {
                const cell = comparisonCell(p, row.capability, capabilitiesByPlan);

                return (
                  <li key={row.capability} className="flex items-center gap-2.5 text-sm">
                    <Cell value={cell} />
                    <span className={cell === 'no' ? 'text-muted/60' : ''}>
                      {row.label}
                      {row.neverRevoked && (
                        <span className="ml-2 text-[11px] text-muted">, не отбирается</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

/**
 * Значок в ячейке.
 *
 * Три состояния, а не два: «скоро» — это не «есть» и не «нет».
 * Подпись для чтения с экрана обязательна: галочка без неё
 * произносится как «графика».
 */
function Cell({ value }: { value: ComparisonCell }) {
  if (value === 'yes') {
    return (
      <span className="inline-flex" role="img" aria-label="входит">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="text-accent">
          <path
            d="M3.5 8.5l3 3 6-7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (value === 'coming-soon') {
    return (
      <span className="text-[11px] text-muted" role="img" aria-label="скоро">
        скоро
      </span>
    );
  }

  return (
    <span className="inline-flex" role="img" aria-label="не входит">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="text-muted/40">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.75 7V5.25a2.25 2.25 0 014.5 0V7" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </span>
  );
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="disclosure-chevron shrink-0 text-muted"
    >
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
