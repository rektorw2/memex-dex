/**
 * Сцена правила выхода: одна условная траектория цены, прогнанная
 * через настоящий движок ядра.
 *
 * Карточка режима не рисует правило «по мотивам»: она прогоняет ту же
 * `evaluatePaperExit`, что ведёт настоящие позиции, по одной и той же
 * траектории для всех пяти режимов. Поэтому отметки продаж, уровни
 * стопа и точка закрытия на картинке — это то, что агент сделал бы
 * на самом деле, а разница между режимами видна на одинаковом
 * движении цены.
 *
 * Модуль чистый: ни React, ни DOM. Его же использует скрипт экспорта
 * карточек в PNG, чтобы картинка на сайте и картинка для экспорта не
 * могли разойтись.
 */
import {
  advancePaperExitState,
  evaluatePaperExit,
  initialPaperExitState,
  paperStopPrice,
  type PaperExitPlan,
  type PaperExitReason,
  type PaperExitState,
} from '@memex/core';

/**
 * Опорные точки траектории: доля времени 0..1 → кратное от входа.
 *
 * Подобрана так, чтобы на одном движении сработало всё, что есть в
 * пресетах: ранний откат (проверить, что стоп не задет), ступени на
 * 1.6× и 2×, максимум 2.4× и откат, глубокий ровно настолько, чтобы
 * трейлинг −25% и −50% успели закрыть остаток. Время условное:
 * вся сцена укладывается в 30 минут, и выходы по времени не
 * вмешиваются — они не про форму движения, а про его отсутствие.
 */
export const SCENE_KEYPOINTS: ReadonlyArray<readonly [t: number, multiple: number]> = [
  [0, 1],
  [0.07, 0.86],
  [0.15, 1.18],
  [0.22, 1.06],
  [0.3, 1.38],
  [0.38, 1.62],
  [0.44, 1.5],
  [0.52, 1.84],
  [0.58, 2.02],
  [0.66, 2.24],
  [0.72, 2.42],
  [0.78, 2.2],
  [0.84, 1.9],
  [0.9, 1.56],
  [0.95, 1.3],
  [1, 1.14],
];

export const SCENE_DURATION_MS = 30 * 60_000;
export const SCENE_SAMPLES = 96;

export interface ScenePoint {
  t: number;
  multiple: number;
}

export interface SceneStopPoint {
  t: number;
  /** Кратное, на котором стоит защита ПЕРЕД этой отметкой; `null` — защиты нет. */
  level: number | null;
  reason: PaperExitReason | null;
}

export interface SceneEvent {
  t: number;
  multiple: number;
  reason: PaperExitReason;
  /** Доля исходной позиции, проданная этим событием. */
  sellPct: number;
  /** Остаток после события, в процентах исходной позиции. */
  remainingPct: number;
  closes: boolean;
}

export interface ExitScene {
  plan: PaperExitPlan;
  points: ScenePoint[];
  stops: SceneStopPoint[];
  events: SceneEvent[];
  /** Доля времени, когда позиция закрылась; `null` — до конца сцены открыта. */
  closedAt: number | null;
  /** Уровни, которые стоит подписать: ступени и цель. */
  levels: Array<{ multiple: number; label: string; kind: 'leg' | 'target' }>;
  peak: number;
}

/** Линейная интерполяция опорных точек в равномерную выборку. */
export function scenePoints(samples = SCENE_SAMPLES): ScenePoint[] {
  const out: ScenePoint[] = [];
  for (let i = 0; i < samples; i += 1) {
    const t = i / (samples - 1);
    let k = 0;
    while (k < SCENE_KEYPOINTS.length - 2 && SCENE_KEYPOINTS[k + 1]![0] < t) k += 1;
    const [t0, m0] = SCENE_KEYPOINTS[k]!;
    const [t1, m1] = SCENE_KEYPOINTS[k + 1]!;
    const w = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    out.push({ t, multiple: m0 + (m1 - m0) * w });
  }
  return out;
}

export function buildExitScene(plan: PaperExitPlan, samples = SCENE_SAMPLES): ExitScene {
  const points = scenePoints(samples);
  const entryAt = 0;
  let state: PaperExitState = initialPaperExitState(1, entryAt);
  const stops: SceneStopPoint[] = [];
  const events: SceneEvent[] = [];
  let closedAt: number | null = null;
  let peak = 1;

  for (const point of points) {
    peak = Math.max(peak, point.multiple);
    if (closedAt != null) {
      stops.push({ t: point.t, level: null, reason: null });
      continue;
    }
    const stop = paperStopPrice(plan, state);
    stops.push({ t: point.t, level: stop?.priceUsd ?? null, reason: stop?.reason ?? null });
    const decision = evaluatePaperExit(plan, state, point.multiple, entryAt + point.t * SCENE_DURATION_MS);
    if (decision.action === 'SELL') {
      const next = advancePaperExitState(state, decision, point.multiple);
      events.push({
        t: point.t,
        multiple: point.multiple,
        reason: decision.reason,
        sellPct: decision.sellPct,
        remainingPct: next.remainingPct,
        closes: decision.closes,
      });
      state = next;
      if (decision.closes) closedAt = point.t;
      continue;
    }
    state = advancePaperExitState(state, decision, point.multiple);
  }

  const levels: ExitScene['levels'] = plan.legs.map((leg) => ({
    multiple: leg.multiple,
    label: `${leg.multiple}× · продать ${leg.sellPct}%`,
    kind: 'leg' as const,
  }));
  if (plan.targetMultiple != null) levels.push({ multiple: plan.targetMultiple, label: `${plan.targetMultiple}× · выход`, kind: 'target' });

  return { plan, points, stops, events, closedAt, levels, peak };
}

/* ─────────────────────────── Геометрия ─────────────────────────── */

export interface SceneFrame {
  width: number;
  height: number;
  /** Отступы: слева под подписи уровней, справа под подпись стопа. */
  padding: { top: number; right: number; bottom: number; left: number };
  minMultiple: number;
  maxMultiple: number;
}

export const DEFAULT_FRAME: SceneFrame = {
  width: 320,
  height: 150,
  padding: { top: 14, right: 14, bottom: 12, left: 14 },
  minMultiple: 0.45,
  maxMultiple: 2.6,
};

export function sceneScales(frame: SceneFrame) {
  const innerW = frame.width - frame.padding.left - frame.padding.right;
  const innerH = frame.height - frame.padding.top - frame.padding.bottom;
  const x = (t: number) => frame.padding.left + t * innerW;
  const y = (multiple: number) =>
    frame.padding.top + innerH - ((multiple - frame.minMultiple) / (frame.maxMultiple - frame.minMultiple)) * innerH;
  return { x, y, innerW, innerH };
}

const fmt = (value: number) => value.toFixed(1);

/** Линия цены как SVG path. `until` — обрезать по доле времени. */
export function pricePath(scene: ExitScene, frame: SceneFrame, from = 0, until = 1): string {
  const { x, y } = sceneScales(frame);
  const pts = scene.points.filter((p) => p.t >= from - 1e-9 && p.t <= until + 1e-9);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${fmt(x(p.t))} ${fmt(y(p.multiple))}`).join(' ');
}

/**
 * Линия стопа — лесенкой: горизонтальный отрезок держит уровень до
 * следующей отметки, вертикальный — поднимает его. Так видно, что стоп
 * не опускается, а трейлинг «подтягивается» за максимумом.
 */
export function stopPath(scene: ExitScene, frame: SceneFrame): string {
  const { x, y } = sceneScales(frame);
  let d = '';
  let previous: number | null = null;
  for (let i = 0; i < scene.stops.length; i += 1) {
    const stop = scene.stops[i]!;
    if (stop.level == null) break;
    const px = x(stop.t);
    const py = y(stop.level);
    if (previous == null) d += `M${fmt(px)} ${fmt(py)}`;
    else if (Math.abs(stop.level - previous) > 1e-9) d += ` L${fmt(px)} ${fmt(y(previous))} L${fmt(px)} ${fmt(py)}`;
    else if (i === scene.stops.length - 1 || scene.stops[i + 1]!.level == null) d += ` L${fmt(px)} ${fmt(py)}`;
    previous = stop.level;
  }
  // Довести до последней отметки с уровнем.
  const last = [...scene.stops].reverse().find((s) => s.level != null);
  if (last && previous != null) d += ` L${fmt(x(last.t))} ${fmt(y(previous))}`;
  return d;
}

/** Уровень стопа в последней точке, где он есть. */
export function finalStop(scene: ExitScene): SceneStopPoint | null {
  return [...scene.stops].reverse().find((s) => s.level != null) ?? null;
}

export const SCENE_REASON_LABELS: Record<PaperExitReason, string> = {
  TARGET_REACHED: 'выход по цели',
  TAKE_PROFIT_LEG: 'ступень',
  STOP_LOSS: 'стоп-лосс',
  BREAKEVEN_STOP: 'безубыток',
  TRAILING_STOP: 'трейлинг',
  TIME_STOP: 'выход по времени',
  MAX_HOLD: 'предел удержания',
  MANUAL_PANIC: 'Panic',
  DRAWDOWN_BREAKER: 'предохранитель',
};
