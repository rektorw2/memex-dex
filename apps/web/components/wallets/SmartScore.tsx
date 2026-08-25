'use client';

import {
  confidenceOf,
  progressToScore,
  winRateView,
  formatMultiple,
  formatEntryTime,
} from '@memex/core';

/**
 * Оценка кошелька и уверенность в ней.
 *
 * Показываются рядом и никогда не сливаются в одно число. Причина
 * в том, что это разные утверждения: балл говорит, насколько хороши
 * результаты, уверенность — сколько за ними наблюдений. Кошелёк
 * с одной удачной сделкой на десять концов и кошелёк с восемнадцатью
 * сделками получают близкие баллы и заслуживают несопоставимо
 * разного доверия.
 *
 * Отдельно про отсутствие оценки. Прежняя плашка «оценки нет» стояла
 * у большинства кошельков, ничего не объясняла и читалась как брак
 * в данных. Вместо неё показывается прогресс: он отвечает на вопрос,
 * который человек задаёт на самом деле, — сколько ещё ждать.
 */

export interface WalletStats {
  score: number | null;
  settled: number | null;
  wins2x: number | null;
  hitRate: number | null;
  avgMultiple: number | null;
  medianEntryHours: number | null;
  rugs: number | null;
  /**
   * Сводка ещё не пересчитана новыми правилами.
   *
   * Отдельно от «мало наблюдений»: там мы знаем, сколько собрано
   * и сколько осталось, здесь не знаем ничего. Показывать прогресс
   * «0 из 5» было бы утверждением о данных, которого у нас нет.
   */
  needsRecompute?: boolean;
}

const TONE: Record<string, string> = {
  up: 'text-up',
  warn: 'text-warn',
  muted: 'text-muted',
};

export function SmartScore({ stats, compact }: { stats: WalletStats; compact?: boolean }) {
  const conf = confidenceOf(stats.settled);

  /*
   * Строка ждёт пересчёта.
   *
   * Проверяется до прогресса: прогресс опирается на число собранных
   * наблюдений, а у такой строки это число неизвестно. Нарисовать
   * пустую полоску и «0 из 5» значило бы сказать «наблюдений нет» —
   * а мы знаем только, что старым числам верить нельзя.
   */
  if (stats.needsRecompute) {
    return (
      <div className="min-w-0" title="Статистика посчитана прежними правилами и ожидает пересчёта">
        <div className="text-[13px] text-muted">Ожидает пересчёта</div>
        <div className="mt-1 text-[11px] text-muted/70">данные обновляются</div>
      </div>
    );
  }

  // Оценки нет — показываем прогресс, а не пустоту.
  if (stats.score == null) {
    const p = progressToScore(stats.settled);

    return (
      <div className="min-w-0">
        <div className="text-[13px] text-muted">{conf.label}</div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 w-16 overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-muted/60"
              style={{ width: `${Math.max(4, p.ratio * 100)}%` }}
            />
          </div>
          <span className="num text-[11px] text-muted/80">{p.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0" title={tooltip(stats)}>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[15px] font-medium">{stats.score}</span>
        <span className="num text-[11px] text-muted">/100</span>
      </div>
      <div className={`text-[11px] ${TONE[conf.tone]}`}>{conf.label}</div>
      {!compact && (
        <div className="text-[11px] text-muted/70">{stats.settled} сделок</div>
      )}
    </div>
  );
}

/**
 * Полный разбор в подсказке.
 *
 * Всё, из чего сложилась оценка, в одном месте: без этого балл
 * остаётся числом, которому предлагают верить на слово.
 */
export function tooltip(s: WalletStats): string {
  const wr = winRateView(s.wins2x, s.settled);
  const conf = confidenceOf(s.settled);

  return [
    `Завершённых сделок: ${s.settled ?? 0}`,
    `Сделки ≥2×: ${wr.text}`,
    `Средний максимум: ${formatMultiple(s.avgMultiple)}`,
    `Медианный вход: ${formatEntryTime(s.medianEntryHours)} после запуска`,
    s.rugs != null ? `Обнулившихся: ${s.rugs}` : null,
    '',
    conf.explanation,
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
}

/**
 * Идентикон кошелька.
 *
 * Нужен потому, что сокращённые адреса похожи друг на друга: строка
 * «EN67Mu…q82ps» опознаётся хуже, чем кажется, и в списке из сорока
 * кошельков глаз за неё не цепляется. Картинка, выведенная из адреса,
 * различается сразу и без чтения.
 *
 * Рисуется из самого адреса, без обращения к сети: сорок запросов
 * за картинками ради списка — плохая цена за украшение.
 */
export function Identicon({ address, size = 32 }: { address: string; size?: number }) {
  // Простое устойчивое перемешивание: одинаковый адрес всегда даёт
  // одинаковую картинку, соседние адреса — разную.
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }

  const hue = h % 360;
  const cells = 5;
  const cell = size / cells;

  const squares: React.ReactElement[] = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < Math.ceil(cells / 2); x++) {
      // Бит из хеша решает, закрашена ли клетка.
      const on = ((h >> ((y * 3 + x) % 30)) & 1) === 1;
      if (!on) continue;

      // Зеркалим по вертикали: симметричные картинки узнаются лучше.
      for (const px of [x, cells - 1 - x]) {
        squares.push(
          <rect
            key={`${x}-${y}-${px}`}
            x={px * cell}
            y={y * cell}
            width={cell}
            height={cell}
            fill={`hsl(${hue} 55% 60%)`}
          />,
        );
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 rounded-lg"
      style={{ background: `hsl(${hue} 30% 16%)` }}
      aria-hidden
    >
      {squares}
    </svg>
  );
}
