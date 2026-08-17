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
  state,
  completenessPercent,
  missingChecks,
  updatedAt,
}: {
  score: number | null | undefined;
  /** Машинные коды причин из движка проверки. */
  codes?: string[];
  /** Тексты причин, если они есть: код говорит что, текст — почему. */
  reasons?: string[];
  compact?: boolean;
  /**
   * Состояние проверок с сервера.
   *
   * Приходит явно, а не выводится из отсутствия числа: по пустому
   * баллу нельзя отличить «ещё проверяем» от «данных не хватает»,
   * а разница между ними и есть весь смысл.
   */
  state?: string | null;
  completenessPercent?: number | null;
  missingChecks?: string[];
  updatedAt?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  /*
   * Состояния без числа обрабатываются до шкалы.
   *
   * Раньше карточка могла показать «Низкий риск 5/100» рядом
   * с «Собираем данные»: балл был низким потому, что проверок было
   * мало, а не потому, что токен безопасен. Незнание выглядело
   * безопасностью — самая дорогая из возможных ошибок на этом экране.
   */
  if (state && state !== 'low' && state !== 'medium' && state !== 'high' && state !== 'critical') {
    return (
      <UnprovenRisk
        state={state}
        completenessPercent={completenessPercent}
        missingChecks={missingChecks}
        updatedAt={updatedAt}
        expanded={expanded}
        onExpand={() => setExpanded(true)}
      />
    );
  }

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
            <Badge key={c} code={c} tone={toneForCode(c, t.text)} />
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

          {expanded &&
            list.slice(2).map((c) => <Badge key={c} code={c} tone={toneForCode(c, t.text)} />)}
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


// ───────────────────── Состояния без доказанной оценки ──────────────────────

const CHECK_LABELS: Record<string, string> = {
  honeypot: 'Возможность продажи',
  sell_tax: 'Налог на продажу',
  mint_authority: 'Возможность эмиссии',
  freeze_authority: 'Возможность заморозки',
  liquidity_locked: 'Замок ликвидности',
  owner_supply_share: 'Концентрация владельца',
  holder_count: 'Число держателей',
};

const STATE_VIEW: Record<
  string,
  { title: string; tone: 'warn' | 'muted'; note: (n: number | null, total: number) => string }
> = {
  insufficient_data: {
    title: 'Недостаточно данных',
    tone: 'warn',
    note: (_n, total) => `Проверено ${total} из 5 обязательных факторов`,
  },
  checking: {
    title: 'Проверяем контракт',
    tone: 'muted',
    note: (_n, total) => `Получено ${total} из 5 проверок`,
  },
  stale: {
    title: 'Данные устарели',
    tone: 'warn',
    note: () => 'Последняя проверка выполнялась давно',
  },
  provider_error: {
    title: 'Проверка временно недоступна',
    tone: 'muted',
    note: () => 'Источник проверок не ответил',
  },
};

/**
 * Блок без числа.
 *
 * Жёлтый или нейтральный, но никогда не зелёный: зелёный читается
 * как разрешение, а разрешения у нас нет — у нас нет сведений.
 */
function UnprovenRisk({
  state,
  completenessPercent,
  missingChecks,
  updatedAt,
  expanded,
  onExpand,
}: {
  state: string;
  completenessPercent?: number | null;
  missingChecks?: string[];
  updatedAt?: string | null;
  expanded: boolean;
  onExpand: () => void;
}) {
  const view = STATE_VIEW[state] ?? STATE_VIEW.insufficient_data!;
  const missing = missingChecks ?? [];

  // Сколько закрыто: из процента, если он пришёл, иначе из числа
  // недостающих. Пять — размер обязательного набора в обеих сетях.
  const done =
    completenessPercent != null
      ? Math.round((completenessPercent / 100) * 5)
      : Math.max(0, 5 - missing.length);

  const tone =
    view.tone === 'warn'
      ? { text: 'text-warn', bg: 'bg-warn/10', border: 'border-warn/30' }
      : { text: 'text-muted', bg: 'bg-raised', border: 'border-border' };

  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg} p-2.5`}>
      <div className="flex items-center gap-2">
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${tone.border} ${tone.text} text-[10px] font-bold leading-none`}
          aria-hidden
        >
          ?
        </span>
        <span className={`text-[13px] font-medium ${tone.text}`}>{view.title}</span>
      </div>

      <p className="mt-1 text-[11px] text-muted">{view.note(completenessPercent ?? null, done)}</p>

      {updatedAt && state === 'stale' && (
        <p className="mt-0.5 text-[11px] text-muted/70">
          Последняя проверка: {new Date(updatedAt).toLocaleTimeString('ru-RU')}
        </p>
      )}

      {missing.length > 0 && !expanded && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
          className="mt-1.5 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Что не проверено
        </button>
      )}

      {expanded && missing.length > 0 && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="text-[11px] text-muted/70">Не проверено:</p>
          <ul className="mt-1 space-y-0.5">
            {missing.map((code) => (
              <li key={code} className="text-[11px] leading-snug text-muted">
                • {CHECK_LABELS[code] ?? code}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Коды, которые нельзя красить в цвет уровня.
 *
 * «Юный пул» на карточке с низким риском выходил зелёным — то есть
 * читался как достоинство. Молодость пула достоинством не является:
 * она означает, что истории нет, проверки могли не успеть, а вывести
 * ликвидность ещё никто не пробовал. Это неопределённость, и цвет
 * у неё жёлтый.
 */
const NEUTRAL_CODES = new Set(['YOUNG_POOL', 'SINGLE_SOURCE', 'SECURITY_DATA_UNAVAILABLE']);

function toneForCode(code: string, levelTone: string): string {
  return NEUTRAL_CODES.has(code) ? 'text-warn' : levelTone;
}
