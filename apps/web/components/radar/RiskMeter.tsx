'use client';

import { useState } from 'react';
import { riskBand, riskLabel, riskCodeLabel } from '@memex/core';

/**
 * Показ риска на карточке находки.
 *
 * Заменяет полоску с подписью «риск 50». У той было три беды сразу.
 * Она не говорила, куда растёт шкала: пятьдесят из ста — это половина
 * опасности или половина надёжности. Она несла смысл одним цветом,
 * а красный от зелёного не различает примерно каждый двенадцатый
 * мужчина. И она не объясняла, из чего число сложилось.
 *
 * Здесь всё три признака сразу — знак, подпись, число, — и причины
 * рядом. Причин показываем две: они должны читаться, а не считаться.
 * Остальные прячутся за «Ещё N», потому что список из восьми плашек
 * перестаёт быть предупреждением и становится фоном.
 */

const TONE: Record<string, { text: string; bg: string; border: string; bar: string }> = {
  up: { text: 'text-up', bg: 'bg-up/10', border: 'border-up/30', bar: 'bg-up' },
  warn: { text: 'text-warn', bg: 'bg-warn/10', border: 'border-warn/30', bar: 'bg-warn' },
  riskHigh: {
    text: 'text-riskHigh',
    bg: 'bg-riskHigh/10',
    border: 'border-riskHigh/30',
    bar: 'bg-riskHigh',
  },
  down: { text: 'text-down', bg: 'bg-down/10', border: 'border-down/30', bar: 'bg-down' },
};

export function RiskMeter({
  score,
  codes,
  reasons,
  compact,
}: {
  score: number | null | undefined;
  /** Машинные коды причин из движка проверки. */
  codes?: string[];
  /** Тексты причин, если они есть: код говорит что, текст — почему. */
  reasons?: string[];
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const band = riskBand(score);

  // Проверка ещё не дошла до находки. Это не «безопасно» и не «опасно»,
  // и показывать шкалу здесь было бы враньём.
  if (!band) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-raised px-2.5 py-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border text-[10px] text-muted">
          ?
        </span>
        <span className="text-xs text-muted">Риск ещё не оценён</span>
      </div>
    );
  }

  const t = TONE[band.tone]!;
  const list = (codes ?? []).length > 0 ? codes! : [];
  const shown = list.slice(0, 2);
  const hidden = list.length - shown.length;

  return (
    <div className={`rounded-lg border ${t.border} ${t.bg} p-2.5`}>
      <div className="flex items-center gap-2">
        {/* Знак дублирует цвет: полагаться только на оттенок нельзя. */}
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${t.border} ${t.text} text-[10px] font-bold leading-none`}
          aria-hidden
        >
          {band.sign}
        </span>

        <span className={`text-[13px] font-medium ${t.text}`}>{band.label}</span>

        {/* Число со знаменателем: без него «50» не имеет масштаба. */}
        <span className="num ml-auto text-xs text-muted">{Math.round(score!)}/100</span>
      </div>

      {!compact && (
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-border"
          role="meter"
          aria-valuenow={Math.round(score!)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={riskLabel(score)}
        >
          <div className={`h-full ${t.bar}`} style={{ width: `${Math.max(2, score!)}%` }} />
        </div>
      )}

      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {shown.map((c) => (
            <Badge key={c} code={c} tone={t.text} />
          ))}

          {hidden > 0 && !expanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:text-white"
            >
              Ещё {hidden} {plural(hidden, 'риск', 'риска', 'рисков')}
            </button>
          )}

          {expanded && list.slice(2).map((c) => <Badge key={c} code={c} tone={t.text} />)}
        </div>
      )}

      {/* Развёрнутые пояснения: плашка называет проблему, строка
          объясняет, чем она грозит. */}
      {expanded && reasons && reasons.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {reasons.slice(0, 6).map((r, i) => (
            <li key={i} className="text-[11px] leading-snug text-muted">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Badge({ code, tone }: { code: string; tone: string }) {
  return (
    <span
      className={`rounded border border-current/25 px-1.5 py-0.5 text-[11px] ${tone}`}
      title={code}
    >
      {riskCodeLabel(code)}
    </span>
  );
}

/** Русская форма множественного числа. «Ещё 2 риска», а не «2 рисков». */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
