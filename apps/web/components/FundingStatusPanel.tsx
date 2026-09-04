'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import type { FundingSafetyState } from '@memex/core';

/**
 * Состояние приёма депозитов для дежурного.
 *
 * Панель показывает путь денег как четыре шага и один тупик.
 * Внутренних состояний здесь восемь, но человеку важно другое:
 * докуда дошёл перевод и есть ли то, что требует его решения.
 *
 * Чего здесь нет намеренно: адресов кошельков, адреса RPC, владельца
 * аренды и ответов провайдера. Экран статуса не должен превращаться
 * в способ узнать, за какими кошельками следит платформа.
 *
 * И ещё одного нет: кнопки «продолжить». Защёлку безопасности
 * снимает не интерфейс.
 */

interface FundingStatus {
  network: string;
  fundingEnabled: boolean;
  liveReachable: boolean;
  withdrawalsEnabled: boolean;
  executionMode: string;
  depositSource: string;
  safetyState: FundingSafetyState;
  automaticCreditAllowed: boolean;
  openIssues: number;
  stages: Record<string, number>;
  depositWorker: {
    running: boolean;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
    checkpoint: string | null;
    heldBack: number;
  };
  reconciliationWorker: {
    running: boolean;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
    matched: number;
    mismatched: number;
    missing: number;
    unreachable: number;
  };
}

/** Порядок шагов совпадает с порядком движения денег. */
const PIPELINE: ReadonlyArray<{ stage: string; label: string }> = [
  { stage: 'DETECTED', label: 'Обнаружен' },
  { stage: 'CONFIRMING', label: 'Подтверждается' },
  { stage: 'FINALIZED', label: 'Финализирован' },
  { stage: 'CREDITED', label: 'Зачислен' },
];

const SAFETY_LABEL: Readonly<Record<FundingSafetyState, string>> = {
  HEALTHY: 'В норме',
  DEGRADED: 'Узел отвечает не всегда',
  PAUSED: 'Зачисления остановлены',
  REVIEW_REQUIRED: 'Требуется решение человека',
};

const SAFETY_TONE: Readonly<Record<FundingSafetyState, string>> = {
  HEALTHY: 'text-muted',
  DEGRADED: 'text-warn',
  PAUSED: 'text-warn',
  REVIEW_REQUIRED: 'text-down',
};

export function FundingStatusPanel() {
  const { data, error } = useSWR<FundingStatus>('/admin/funding/status', fetcher, {
    refreshInterval: 30_000,
  });

  if (error) {
    return (
      <section className="panel p-4" aria-label="Приём депозитов">
        <h2 className="font-semibold">Приём депозитов</h2>
        <p className="mt-2 text-sm text-muted">Состояние недоступно.</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel p-4" aria-label="Приём депозитов">
        <h2 className="font-semibold">Приём депозитов</h2>
        <p className="mt-2 text-sm text-muted">Загрузка…</p>
      </section>
    );
  }

  const review = data.stages.REVIEW ?? 0;

  return (
    <section className="panel space-y-4 p-4" aria-label="Приём депозитов">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Приём депозитов</h2>
        {/*
          Формулировка выбрана так, чтобы её нельзя было прочитать
          как «депозиты работают». Пока контур выключен, любая
          цифра ниже — это счётчик проверок, а не денег.
        */}
        <span className="text-xs text-muted">
          Сеть {data.network} · {data.fundingEnabled ? 'приём включён' : 'приём выключен'}
        </span>
      </div>

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PIPELINE.map((step) => (
          <li key={step.stage} className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted">{step.label}</div>
            <div className="num mt-1 text-lg">{data.stages[step.stage] ?? 0}</div>
          </li>
        ))}
      </ol>

      {review > 0 && (
        <p className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          Требуется проверка: {review}. Записи сохранены, зачисление не выполнено.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Row label="Состояние контура">
          <span className={SAFETY_TONE[data.safetyState]}>{SAFETY_LABEL[data.safetyState]}</span>
        </Row>
        <Row label="Открытых расхождений">{data.openIssues}</Row>
        <Row label="Удержано до решения">{data.depositWorker.heldBack}</Row>
        <Row label="Чтение цепочки">
          {data.depositWorker.running ? 'идёт' : 'остановлено'}
          {data.depositWorker.lastErrorCode ? ` · ${data.depositWorker.lastErrorCode}` : ''}
        </Row>
        <Row label="Сверка">
          {data.reconciliationWorker.running ? 'идёт' : 'остановлена'}
          {data.reconciliationWorker.lastErrorCode
            ? ` · ${data.reconciliationWorker.lastErrorCode}`
            : ''}
        </Row>
        <Row label="Безопасная граница">
          {data.withdrawalsEnabled ? 'выводы включены' : 'выводы выключены'} ·{' '}
          {data.liveReachable ? 'LIVE доступен' : 'LIVE недоступен'} · {data.executionMode}
        </Row>
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num mt-0.5">{children}</dd>
    </div>
  );
}
