'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';

/**
 * Предложения агента и решение человека.
 *
 * Экран отвечает на один вопрос: на что именно человека просят
 * согласиться. Поэтому сумма, комиссия, риск и срок стоят рядом,
 * а не разнесены по вкладкам, — согласие вслепую не является
 * согласием.
 *
 * Второе: подтверждение не отправляет транзакцию. Об этом сказано
 * прямо и до кнопок, потому что «подтвердить» в любом другом
 * продукте означает «сделать», и человек прочтёт это так же.
 *
 * Пока LIVE-контур заблокирован, кнопки отключены и подписаны.
 * Отключённая кнопка остаётся кнопкой: делать из неё ссылку значит
 * обещать переход, которого не будет.
 */

interface Presentation {
  asset: string;
  network: string;
  direction: 'BUY' | 'SELL';
  amountUsd: string;
  estimatedFeeUsd: string | null;
  maxFeeUsd: string;
  slippageBps: number;
  riskLevel: string;
  strategy: string;
  reason: string;
  expiresAt: number;
}

interface ProposalRow {
  id: string;
  status: string;
  fingerprint: string;
  presentation: Presentation;
}

interface ProposalsResponse {
  warning: string;
  liveBlocked: boolean;
  proposals: ProposalRow[];
}

const RISK_TONE: Record<string, string> = {
  LOW: 'text-up',
  MEDIUM: 'text-warn',
  HIGH: 'text-down',
  UNKNOWN: 'text-muted',
};

export function SemiAutoProposals() {
  const { data, error, mutate } = useSWR<ProposalsResponse>(
    '/live/proposals',
    fetcher,
    { refreshInterval: 30_000 },
  );

  /*
   * Часы тикают отдельно от загрузки данных.
   *
   * Иначе таймер до истечения обновлялся бы раз в тридцать секунд:
   * человек видел бы «осталось 40 секунд» ещё полминуты после того,
   * как предложение умерло.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const [busyId, setBusyId] = useState<string | null>(null);

  if (error) {
    return (
      <section className="panel p-4" aria-label="Предложения агента">
        <h2 className="font-semibold">Предложения</h2>
        <p className="mt-2 text-sm text-muted">Список недоступен.</p>
      </section>
    );
  }

  /*
   * Пока данных нет, список пуст, а не «неизвестен».
   *
   * Показывать карточки по частично загруженному ответу нельзя:
   * человек увидел бы кнопку подтверждения раньше, чем сумму.
   */
  const liveBlocked = data?.liveBlocked ?? true;
  const live = (data?.proposals ?? []).filter(
    (row) => row.status === 'CREATED' || row.status === 'AWAITING_CONFIRMATION',
  );

  async function decide(row: ProposalRow, decision: 'CONFIRM' | 'REJECT') {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await api(`/live/proposals/${row.id}/decide`, {
        method: 'POST',
        headers: {
          // Двойной щелчок на мобильном не должен становиться
          // вторым решением.
          'idempotency-key': `${row.id}:${decision}:${row.fingerprint}`,
        },
        body: JSON.stringify({ decision, shownFingerprint: row.fingerprint }),
      });
      await mutate();
    } catch {
      await mutate();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5" aria-label="Предложения агента">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted">SEMI-AUTO</p>
          <h2 className="mt-1 font-semibold">Предложения агента</h2>
        </div>
        {data?.liveBlocked && (
          <span className="rounded-full border border-warn/30 bg-warn/10 px-2.5 py-1 text-xs text-warn">
            тестовый контур
          </span>
        )}
      </div>

      {/*
        Предупреждение стоит до карточек, а не под кнопками.
        Прочитанное после нажатия не помогает.
      */}
      <p className="rounded-lg border border-border bg-raised p-3 text-xs leading-relaxed text-muted">
        {data?.warning ?? 'Подтверждение не отправляет транзакцию.'}
      </p>

      {!data && <p className="text-sm text-muted">Загрузка…</p>}

      {data && live.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">Активных предложений нет</p>
      )}

      <ul className="space-y-3">
        {live.map((row) => {
          const left = row.presentation.expiresAt - now;
          const expired = left <= 0;

          return (
            <li
              key={row.id}
              data-proposal-id={row.id}
              className="rounded-lg border border-border p-3 transition-colors duration-200 motion-reduce:transition-none"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="num text-sm">
                  {row.presentation.direction === 'BUY' ? 'Покупка' : 'Продажа'}{' '}
                  {row.presentation.asset} на ${row.presentation.amountUsd}
                </div>
                <div
                  className={`text-xs ${expired ? 'text-down' : 'text-muted'}`}
                  role="timer"
                  aria-live="off"
                >
                  {expired ? 'Срок истёк' : `Осталось ${formatLeft(left)}`}
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                <Field label="Сеть">{row.presentation.network}</Field>
                <Field label="Риск">
                  <span className={RISK_TONE[row.presentation.riskLevel] ?? 'text-muted'}>
                    {row.presentation.riskLevel}
                  </span>
                </Field>
                <Field label="Комиссия">
                  {/* Неизвестная оценка честнее выдуманной. */}
                  {row.presentation.estimatedFeeUsd == null
                    ? 'неизвестна'
                    : `≈ $${row.presentation.estimatedFeeUsd}`}
                </Field>
                <Field label="Не более">${row.presentation.maxFeeUsd}</Field>
                <Field label="Проскальзывание">{row.presentation.slippageBps} bps</Field>
                <Field label="Стратегия">{row.presentation.strategy}</Field>
              </dl>

              <p className="mt-2 text-xs leading-relaxed text-muted">
                {row.presentation.reason}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={expired || busyId != null || liveBlocked}
                  onClick={() => void decide(row, 'CONFIRM')}
                  className="min-h-11 flex-1 rounded-lg border border-border bg-raised px-4 text-sm transition-colors duration-200 disabled:text-muted motion-reduce:transition-none"
                >
                  {liveBlocked ? 'Подтверждение недоступно' : 'Подтвердить'}
                </button>
                <button
                  type="button"
                  disabled={expired || busyId != null}
                  onClick={() => void decide(row, 'REJECT')}
                  className="min-h-11 flex-1 rounded-lg border border-border px-4 text-sm transition-colors duration-200 disabled:text-muted motion-reduce:transition-none"
                >
                  Отклонить
                </button>
              </div>

              {liveBlocked && (
                <p className="mt-2 text-[11px] text-muted">
                  LIVE-контур ещё не подключён. Это подготовка, а не сделка.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="num mt-0.5">{children}</dd>
    </div>
  );
}

/** Остаток времени словами. Секунды важны только под конец. */
function formatLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} с`;
  return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
}
