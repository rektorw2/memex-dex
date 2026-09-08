'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { PAPER_EXIT_PRESETS, describePaperExitPlan, type PaperExitMode, type PaperExitPlan } from '@memex/core';
import { publicAsset } from '@/lib/public-assets';
import {
  DEFAULT_FRAME,
  SCENE_REASON_LABELS,
  buildExitScene,
  finalStop,
  pricePath,
  sceneScales,
  stopPath,
  type ExitScene,
  type SceneFrame,
} from '@/lib/exit-scene';

/**
 * Карточка правила выхода.
 *
 * Три слоя: авторский фон (картинка, у каждого режима своя), текст
 * (настоящий, чтобы оставался чётким и доступным) и сцена — SVG,
 * посчитанный движком ядра по общей траектории. Картинка ничего не
 * утверждает о правиле: все уровни, отметки и точка закрытия идут из
 * `buildExitScene`, а не нарисованы руками.
 *
 * Движение — только у выбранной карточки, и только один раз за выбор:
 * пять бесконечных циклов на одном экране превращают выбор в шум.
 * Остальные стоят в статичном итоговом состоянии, из которого правило
 * тоже читается. Повтор — отдельной кнопкой.
 */

export interface ExitModeCopy {
  key: PaperExitMode;
  label: string;
  tag: string;
  summary: string;
  chips: string[];
  /** Слаг файлов фона в /public/exit-modes. */
  art: string;
}

export const EXIT_MODE_COPY: ExitModeCopy[] = [
  { key: 'TARGET', label: 'Цель 2×', tag: 'контрольный', art: 'target', summary: 'Один полный выход на 2×. Защиты нет — это точка сравнения для остальных.', chips: ['цель 2×', 'без стопа'] },
  { key: 'PROTECTED', label: 'Защищённый', tag: 'стоп + время', art: 'protected', summary: 'Стоп −35% и цель 2×. Через 45 минут без +30% позиция закрывается; дольше 4 часов не держится.', chips: ['стоп −35%', 'цель 2×', '45 мин', 'до 4 ч'] },
  { key: 'LADDER', label: 'Лестница', tag: 'ступени', art: 'ladder', summary: 'Часть фиксируется на 1.6× и 2×, стоп после первой ступени в безубытке, остаток ведёт трейлинг.', chips: ['40% на 1.6×', '30% на 2×', 'стоп −35%', 'трейлинг −25%'] },
  { key: 'TRAILING', label: 'Трейлинг', tag: 'тело + трейлинг', art: 'trailing', summary: 'До 2× стоп стоит на −50%. На 2× фиксируется половина, остаток идёт за максимумом.', chips: ['стоп −50%', '50% на 2×', 'трейлинг −50%', 'до 6 ч'] },
  { key: 'TRAILING_PURE', label: 'Чистый трейлинг', tag: 'сопровождение с входа', art: 'trailing-pure', summary: 'Стоп идёт за максимумом с первой секунды. На 2× фиксируется половина, остаток продолжает путь.', chips: ['трейлинг −50% с входа', '50% на 2×', 'до 6 ч'] },
];

/** Сцены считаются один раз на модуль: пресеты неизменяемы. */
const SCENES: Record<PaperExitMode, ExitScene> = Object.fromEntries(
  EXIT_MODE_COPY.map((copy) => [copy.key, buildExitScene(PAPER_EXIT_PRESETS[copy.key])]),
) as Record<PaperExitMode, ExitScene>;

export function exitSceneFor(mode: PaperExitMode, plan?: PaperExitPlan): ExitScene {
  return plan ? buildExitScene(plan) : SCENES[mode];
}

export type ScenePlay = 'static' | 'demo';

/** Длительность демонстрации: столько идёт «время» сцены слева направо. */
export const SCENE_DEMO_MS = 3600;

export function prefersReducedMotionNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { setInView(true); observer.disconnect(); } }, { rootMargin: '0px 0px -10% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, inView };
}

export function ExitModeCard({ copy, plan, selected, index, onSelect, onKeyDown }: {
  copy: ExitModeCopy;
  /** План с правками администратора; без него — пресет. */
  plan?: PaperExitPlan;
  selected: boolean;
  index: number;
  onSelect: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const scene = exitSceneFor(copy.key, plan);
  const { ref, inView } = useInView<HTMLDivElement>();
  const [replay, setReplay] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const play: ScenePlay = selected && inView && !reduced ? 'demo' : 'static';
  const detailsId = useId();
  const art = (size: 'desktop' | 'mobile', ext: 'avif' | 'webp') => publicAsset(`/exit-modes/${copy.art}-${size}.${ext}`);

  return (
    <div
      ref={ref}
      data-exit-card={copy.key}
      data-selected={selected ? 'true' : undefined}
      data-inview={inView ? 'true' : 'false'}
      className={`agent-exit-card relative overflow-hidden rounded-2xl border transition-colors ${selected ? 'border-accent' : 'border-border hover:border-accent/40'}`}
      style={{ '--i': index } as CSSProperties}
    >
      <picture aria-hidden className="pointer-events-none absolute inset-0">
        <source media="(min-width: 640px)" type="image/avif" srcSet={art('desktop', 'avif')} />
        <source media="(min-width: 640px)" type="image/webp" srcSet={art('desktop', 'webp')} />
        <source type="image/avif" srcSet={art('mobile', 'avif')} />
        <img src={art('mobile', 'webp')} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      </picture>
      <div aria-hidden className="agent-exit-veil pointer-events-none absolute inset-0" />

      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-describedby={detailsId}
        data-exit-mode={copy.key}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="relative block w-full p-4 text-left focus-visible:outline-none sm:p-5"
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,46%)] sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-accent' : 'border-muted/60'}`}>
                {selected && <span className="agent-step-done h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="text-base font-semibold sm:text-lg">{copy.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] tracking-wide ${selected ? 'bg-accent/20 text-accent' : 'bg-white/5 text-muted'}`}>{copy.tag}</span>
            </div>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{copy.summary}</p>
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Параметры">
              {copy.chips.slice(0, 4).map((chip) => (
                <li key={chip} className={`num rounded-md border px-1.5 py-0.5 text-[11px] ${selected ? 'border-accent/40 bg-accent/10 text-white' : 'border-white/10 bg-bg/40 text-muted'}`}>{chip}</li>
              ))}
            </ul>
          </div>
          <ExitModeScene key={`${copy.key}:${replay}`} scene={scene} play={play} label={copy.label} />
        </div>
      </button>

      <div className="relative flex items-center justify-between gap-3 px-4 pb-3 sm:px-5">
        <details className="disclosure min-w-0 text-xs text-muted">
          <summary className="inline-flex min-h-8 cursor-pointer items-center gap-1 hover:text-white"><span className="disclosure-chevron" aria-hidden>▸</span> Подробнее</summary>
          <p id={detailsId} className="disclosure-body mt-1 max-w-xl leading-relaxed">{describePaperExitPlan(scene.plan)}. {closingSentence(scene)}</p>
        </details>
        {selected && !reduced && (
          <button type="button" data-action="replay-scene" onClick={() => setReplay((n) => n + 1)} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <span aria-hidden>↻</span> Повторить показ
          </button>
        )}
      </div>
    </div>
  );
}

function closingSentence(scene: ExitScene): string {
  const last = scene.events[scene.events.length - 1];
  if (!last || !last.closes) return 'На этой траектории позиция остаётся открытой до конца сцены.';
  const legs = scene.events.filter((event) => !event.closes);
  const parts = legs.map((event) => `${event.sellPct}% на ${event.multiple.toFixed(2)}×`);
  return `На общей траектории: ${parts.length ? `${parts.join(', ')}, ` : ''}остаток закрыт на ${last.multiple.toFixed(2)}× — ${SCENE_REASON_LABELS[last.reason]}`;
}

/* ───────────────────────────── Сцена ───────────────────────────── */

const fmtX = (value: number) => `${value.toFixed(2)}×`;

/**
 * SVG-сцена. Все элементы уже на месте; демонстрация — это маска,
 * которая открывает время слева направо, и отметки, появляющиеся в
 * свой момент. Так статичное и анимированное состояния — одна и та же
 * картинка, и при `prefers-reduced-motion` ничего не приходится
 * перерисовывать: снимается только движение.
 */
export function ExitModeScene({ scene, play, label, frame = DEFAULT_FRAME }: { scene: ExitScene; play: ScenePlay; label: string; frame?: SceneFrame }) {
  const id = useId().replace(/:/g, '');
  const { x, y } = sceneScales(frame);
  const closedAt = scene.closedAt ?? 1;
  const last = scene.events[scene.events.length - 1] ?? null;
  const stop = finalStop(scene);
  /*
   * Если позиция закрыта тем же стопом, подпись стопа сливается с
   * подписью закрытия: оставляем одну, с уровнем.
   */
  const stopClosed = !!(last?.closes && stop && last.reason === stop.reason);
  const at = (t: number) => ({ '--at': t } as CSSProperties);
  const entryY = y(1);
  const priceTo = pricePath(scene, frame, 0, closedAt);
  const priceAfter = scene.closedAt != null ? pricePath(scene, frame, closedAt, 1) : '';

  return (
    <svg
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      role="img"
      aria-label={`${label}: ${closingSentence(scene)}`}
      data-play={play}
      className="agent-scene h-auto w-full select-none"
      style={{ '--demo': `${SCENE_DEMO_MS}ms` } as CSSProperties}
    >
      <defs>
        <clipPath id={`${id}-reveal`}>
          <rect className="agent-scene-reveal" x="0" y="0" width={frame.width} height={frame.height} />
        </clipPath>
        <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#8B5CF6" stopOpacity=".22" />
          <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Подложка сцены: на любой картинке линии читаются */}
      <rect x="0" y="0" width={frame.width} height={frame.height} rx="10" className="fill-panel/50" />

      {/* Ось входа 1× */}
      <line x1={frame.padding.left} x2={frame.width - frame.padding.right} y1={entryY} y2={entryY} className="stroke-white/15" strokeWidth="1" />
      <text x={frame.padding.left} y={entryY - 3} className="fill-white/40 text-[8px]" fontSize="8">вход 1×</text>

      {/* Уровни: ступени и цель */}
      {scene.levels.map((level) => (
        <g key={level.label} className="agent-scene-level" style={at(0.02)}>
          <line x1={frame.padding.left} x2={frame.width - frame.padding.right} y1={y(level.multiple)} y2={y(level.multiple)} className="stroke-up/70" strokeWidth="1" strokeDasharray="3 3" />
          <text x={frame.padding.left} y={y(level.multiple) - 3} className="num agent-scene-halo fill-up" fontSize="8.5">{level.label}</text>
        </g>
      ))}

      {/* Заливка под ценой до закрытия */}
      <g clipPath={`url(#${id}-reveal)`}>
        <path d={`${priceTo} L${x(closedAt).toFixed(2)} ${y(frame.minMultiple).toFixed(2)} L${x(0).toFixed(2)} ${y(frame.minMultiple).toFixed(2)} Z`} fill={`url(#${id}-area)`} />
        <path d={priceTo} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {priceAfter && <path d={priceAfter} fill="none" className="stroke-white/25" strokeWidth="1.5" strokeDasharray="2 3" strokeLinejoin="round" />}
        {/* Стоп-линия — лесенкой, синхронно с ценой */}
        {stop && <path d={stopPath(scene, frame)} fill="none" className="stroke-down" strokeWidth="1.5" strokeDasharray="4 2.5" strokeLinejoin="round" />}
      </g>

      {/* Подпись стопа в конце */}
      {stop && !stopClosed && (
        <g className="agent-scene-mark" style={at(Math.min(closedAt, stop.t))}>
          <text x={x(stop.t) > frame.width * 0.7 ? x(stop.t) - 2 : x(stop.t) + 4} y={y(stop.level!) + 11} textAnchor={x(stop.t) > frame.width * 0.7 ? 'end' : 'start'} className="num agent-scene-halo fill-down" fontSize="8.5">
            {stop.reason === 'TRAILING_STOP' ? 'трейлинг' : stop.reason === 'BREAKEVEN_STOP' ? 'безубыток' : 'стоп'} {fmtX(stop.level!)}
          </text>
        </g>
      )}
      {!stop && <text x={frame.padding.left} y={frame.height - 3} className="fill-down/80" fontSize="8.5">защиты нет</text>}

      {/* События: частичные продажи и закрытие */}
      {scene.events.map((event) => (
        <g key={`${event.reason}:${event.t}`} transform={`translate(${x(event.t).toFixed(2)} ${y(event.multiple).toFixed(2)})`}>
        <g className="agent-scene-mark" style={at(event.t)}>
          {event.closes
            ? <>
                <circle r="6" className="fill-none stroke-white/70" strokeWidth="1.5" />
                <circle r="2.2" className="fill-white" />
              </>
            : <>
                <circle r="5" className="fill-panel stroke-up" strokeWidth="1.8" />
                <circle r="2" className="fill-up" />
              </>}
          <text
            x={event.closes ? -8 : 0}
            y={event.closes ? (event.reason === 'TARGET_REACHED' ? -8 : 22) : 13}
            textAnchor={event.closes ? 'end' : 'middle'}
            className={`num agent-scene-halo ${event.closes ? 'fill-white' : 'fill-up'}`}
            fontSize="8.5"
          >
            {event.closes ? `${SCENE_REASON_LABELS[event.reason]}${stopClosed && stop ? ` ${fmtX(stop.level!)}` : ''}` : `−${event.sellPct}%`}
          </text>
        </g>
        </g>
      ))}

      {/* Итог сцены */}
      {last?.closes && (
        <g className="agent-scene-done" style={at(closedAt)}>
          <rect x={frame.padding.left} y={frame.height - 14} width="112" height="12" rx="6" className="fill-white/10" />
          <text x={frame.padding.left + 56} y={frame.height - 5} textAnchor="middle" className="fill-white/80" fontSize="7.5">закрыто · сценарий завершён</text>
        </g>
      )}
    </svg>
  );
}
