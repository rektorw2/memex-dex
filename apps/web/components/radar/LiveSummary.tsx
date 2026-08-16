'use client';

import { timeAgo } from '@memex/core';

/**
 * Живая сводка над лентой.
 *
 * Отвечает на вопрос «что происходит сейчас» до того, как человек
 * начнёт читать карточки. Пять чисел, из которых три — про состав
 * находок, одно — про их среднюю судьбу, и одно — про свежесть самих
 * данных.
 *
 * Последнее важнее, чем кажется. Инструмент, который называет себя
 * живым, обязан показывать, когда он последний раз что-то узнал:
 * иначе замерший радар и спокойный рынок выглядят одинаково,
 * и отличить их нельзя никак.
 *
 * Пауза сделана явной кнопкой. Список, который перестраивается под
 * курсором в момент нажатия, — это способ открыть не тот токен,
 * и человеку нужен способ его остановить.
 */

export interface RadarSummary {
  found24h: number;
  lowRisk: number;
  highRisk: number;
  avgGrowthPct: number | null;
  lastCheckedAt: string | null;
}

export function LiveSummary({
  summary,
  paused,
  onTogglePause,
  updatedAt,
}: {
  summary?: RadarSummary;
  paused: boolean;
  onTogglePause: () => void;
  /** Когда страница последний раз получила ответ. */
  updatedAt: number | null;
}) {
  if (!summary) {
    return (
      <div className="panel flex h-[62px] items-center gap-6 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-3 w-20 animate-pulse rounded bg-raised" />
        ))}
      </div>
    );
  }

  const growth = summary.avgGrowthPct;

  return (
    <div className="panel scroll-x flex items-center gap-6 px-4 py-2.5">
      <Stat label="Найдено за сутки" value={String(summary.found24h)} />
      <Stat label="Низкий риск" value={String(summary.lowRisk)} tone="up" />
      <Stat label="Высокий риск" value={String(summary.highRisk)} tone="down" />
      <Stat
        label="Средний рост"
        value={
          growth == null
            ? '—'
            : `${growth >= 0 ? '+' : '−'}${Math.abs(growth).toFixed(Math.abs(growth) >= 10 ? 0 : 1)}%`
        }
        tone={growth == null ? undefined : growth >= 0 ? 'up' : 'down'}
      />

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5 text-[11px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                paused ? 'bg-muted' : 'animate-pulse bg-up'
              }`}
              aria-hidden
            />
            <span className={paused ? 'text-muted' : 'text-up'}>
              {paused ? 'Пауза' : 'Live'}
            </span>
          </div>
          <div className="text-[11px] text-muted/70">
            {updatedAt ? `обновлено ${timeAgo(new Date(updatedAt))}` : 'ожидаем данные'}
          </div>
        </div>

        <button
          onClick={onTogglePause}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-muted transition-colors hover:text-white"
          aria-label={paused ? 'Возобновить обновление' : 'Приостановить обновление'}
          title={paused ? 'Возобновить обновление' : 'Приостановить обновление'}
        >
          {paused ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M3 2l7 4-7 4V2z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <rect x="3" y="2" width="2.5" height="8" fill="currentColor" />
              <rect x="7" y="2" width="2.5" height="8" fill="currentColor" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="shrink-0">
      <div className="text-[11px] leading-tight text-muted">{label}</div>
      <div
        className={`num text-sm leading-tight ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
