'use client';

import { useState } from 'react';
import { fmtUsd } from '@/lib/api';

/**
 * Значок уровня риска.
 *
 * Заменяет жёлтый треугольник, который стоял у всех подряд и потому
 * не значил ничего. Щит с цветом читается быстрее и различает шесть
 * состояний вместо двух.
 *
 * Отдельное состояние «не проверен» существует не для полноты, а потому
 * что молчание на непроверенном токене читается как одобрение. Пустое
 * место рядом с тикером человек истолкует в свою пользу.
 */

export type RiskLevel = 'verified' | 'low' | 'medium' | 'high' | 'blocked' | 'pending';

interface Reason {
  code: string;
  message: string;
}

const STYLES: Record<RiskLevel, { color: string; label: string; fill: boolean }> = {
  verified: { color: 'text-up', label: 'Проверен', fill: true },
  low: { color: 'text-up/70', label: 'Низкий риск', fill: false },
  medium: { color: 'text-warn', label: 'Средний риск', fill: false },
  high: { color: 'text-down', label: 'Высокий риск', fill: false },
  blocked: { color: 'text-down', label: 'Заблокирован', fill: true },
  pending: { color: 'text-muted', label: 'Не проверен', fill: false },
};

function Shield({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none">
      <path
        d="M8 1.5 3 3.3v4.2c0 3 2.1 5.8 5 6.9 2.9-1.1 5-3.9 5-6.9V3.3L8 1.5Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Компактный значок для строки списка. */
export function RiskBadge({
  level,
  onOpen,
}: {
  level?: RiskLevel | null;
  onOpen?: () => void;
}) {
  const l = level ?? 'pending';
  const s = STYLES[l];

  return (
    <button
      type="button"
      onClick={(e) => {
        // Строка списка сама по себе кнопка выбора токена — без
        // остановки всплытия нажатие на значок ещё и переключало бы
        // выбранный токен.
        e.stopPropagation();
        onOpen?.();
      }}
      title={s.label}
      aria-label={`Риск: ${s.label}`}
      className={`${s.color} tap-none shrink-0 rounded transition-opacity hover:opacity-70`}
    >
      <Shield filled={s.fill} />
    </button>
  );
}

/* ─────────────────────── Панель разбора ─────────────────────── */

export interface RiskDetails {
  symbol: string;
  address: string;
  chainLabel: string;
  level?: RiskLevel | null;
  score?: number | null;
  reasons?: Reason[];
  sources?: Record<string, unknown> | null;
  checkedAt?: string | null;
  liquidityUsd?: string | null;
  poolAgeHours?: number | null;
}

export function RiskPanel({ token, onClose }: { token: RiskDetails; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const l = token.level ?? 'pending';
  const s = STYLES[l];

  const sources = Object.entries(token.sources ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  return (
    <div className="border-border bg-raised space-y-3 border-b p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className={s.color}>
          <Shield filled={s.fill} />
        </span>
        <span className="font-medium">{s.label}</span>
        {token.score != null && (
          <span className="num text-muted">оценка {token.score}/100</span>
        )}
        <button onClick={onClose} className="text-muted ml-auto hover:text-white">
          закрыть
        </button>
      </div>

      {/* Причины с кодами. Код нужен для обращения в поддержку
          и для понимания, что именно сработало. */}
      {token.reasons && token.reasons.length > 0 ? (
        <ul className="space-y-1">
          {token.reasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <code className="text-muted/60 shrink-0 text-[10px]">{r.code}</code>
              <span className="text-muted leading-snug">{r.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted leading-relaxed">
          {l === 'pending'
            ? 'Проверка ещё не выполнялась. Это не значит, что токен чист.'
            : 'Замечаний не найдено. Мем-коин всё равно может обесцениться до нуля.'}
        </p>
      )}

      <div className="border-border grid gap-1.5 border-t pt-2">
        <Row label="Контракт">
          <span className="num truncate" title={token.address}>
            {token.address.length > 18
              ? `${token.address.slice(0, 8)}…${token.address.slice(-6)}`
              : token.address}
          </span>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(token.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="text-accent ml-2 shrink-0"
          >
            {copied ? 'скопировано' : 'копировать'}
          </button>
        </Row>

        <Row label="Сеть">
          <span>{token.chainLabel}</span>
        </Row>

        {token.liquidityUsd && (
          <Row label="Ликвидность">
            <span className="num">{fmtUsd(token.liquidityUsd)}</span>
          </Row>
        )}

        {token.poolAgeHours != null && (
          <Row label="Возраст пула">
            <span className="num">
              {token.poolAgeHours < 48
                ? `${token.poolAgeHours.toFixed(0)} ч`
                : `${(token.poolAgeHours / 24).toFixed(0)} дн`}
            </span>
          </Row>
        )}

        <Row label="Источники">
          <span className="text-muted">
            {sources.length > 0 ? sources.join(', ') : 'нет данных'}
          </span>
        </Row>

        <Row label="Проверено">
          <span className="text-muted">
            {token.checkedAt
              ? new Date(token.checkedAt).toLocaleString('ru', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })
              : 'не проверялся'}
          </span>
        </Row>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted shrink-0">{label}</span>
      <span className="flex min-w-0 items-baseline justify-end">{children}</span>
    </div>
  );
}
