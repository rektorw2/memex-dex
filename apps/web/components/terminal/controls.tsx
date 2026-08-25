'use client';

import { useId, type ReactNode } from 'react';

/**
 * Контролы терминала.
 *
 * ─── Что было ───────────────────────────────────────────────────────
 *
 * Поиск и два выпадающих списка пользовались общим классом `.input`
 * и выглядели тремя разными элементами. Причин было три, и каждая
 * мелкая по отдельности.
 *
 * `.input` включает `num` — моноширинный шрифт. Он там уместен:
 * класс задуман для полей ввода сумм, где цифры обязаны стоять
 * в разрядах. Но поиск по тикеру и названия сетей моноширинными быть
 * не должны, и каждое место дописывало `font-sans` руками — то есть
 * боролось с собственным базовым классом.
 *
 * `min-height: 36px` у `.input` меньше сорока четырёх пикселей,
 * с которых начинается надёжное попадание пальцем.
 *
 * У `select` не было `appearance-none`, поэтому браузер рисовал свою
 * стрелку и свою рамку. На светлой системной теме эта рамка видна
 * поверх тёмной панели, и два соседних поля отличались формой.
 *
 * ─── Что здесь ──────────────────────────────────────────────────────
 *
 * Общая форма вынесена в одну строку классов, и все контролы берут
 * её оттуда. Это и есть проверяемый контракт: тест сравнивает классы
 * поиска, списков «Рынка» и списков GEMS между собой, а не
 * с переписанным от руки ожиданием.
 *
 * Глобальный `.input` не тронут: он используется на других страницах,
 * и менять его ради терминала значило бы чинить одно, ломая другое.
 *
 * ─── Почему не библиотека ───────────────────────────────────────────
 *
 * Нативный `select` уже умеет клавиатуру, поиск по первой букве,
 * системный список на телефоне и чтение с экрана. Кастомный dropdown
 * всё это воспроизводит заново и обычно хуже. Здесь заменена только
 * внешность — поведение осталось браузерным.
 */

/**
 * Общая форма поля.
 *
 * Высота, радиус, фон, рамка, отступы, шрифт и переходы — всё, что
 * делает три разных контрола похожими на один набор.
 */
export const TERMINAL_CONTROL_SHAPE =
  'h-11 w-full rounded-md border border-border bg-bg font-sans text-sm text-white ' +
  'transition-colors hover:border-border/80 ' +
  'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-accent/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  // Движение отключается вместе с остальным по системной настройке.
  'motion-reduce:transition-none';

/** Отступы поля ввода. У списка справа больше — там стрелка. */
export const TERMINAL_INPUT_PADDING = 'pl-9 pr-9';
export const TERMINAL_SELECT_PADDING = 'pl-3 pr-9';

/**
 * Общая форма чипа быстрого фильтра.
 *
 * Отдельно от полей: чип ниже и плотнее, но радиус и переходы те же,
 * чтобы набор читался как одна система.
 */
export const TERMINAL_CHIP_SHAPE =
  // `px-2` и `gap-1` вместо прежних `px-2.5` и `gap-1.5`: пять чипов
  // в ряду на 375 пикселях не помещались, и последний обрезался краем.
  'inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border ' +
  'px-2 text-xs transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
  'motion-reduce:transition-none';

// ─────────────────────────────── Поиск ──────────────────────────────────────

export function TerminalSearchField({
  value,
  onChange,
  label = 'Поиск токена',
  placeholder = 'Поиск по тикеру или адресу',
}: {
  value: string;
  onChange: (v: string) => void;
  /** Доступное имя. Визуально скрыто: в панели фильтров подпись избыточна. */
  label?: string;
  placeholder?: string;
}) {
  const id = useId();

  return (
    <div className="relative min-w-0">
      {/*
        Подпись существует всегда, просто не показывается.
        `placeholder` доступным именем не является: он исчезает при
        первом введённом символе, и человек, читающий экран, теряет
        назначение поля ровно тогда, когда начинает им пользоваться.
      */}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>

      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
      </span>

      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${TERMINAL_CONTROL_SHAPE} ${TERMINAL_INPUT_PADDING} placeholder:text-muted/70 ` +
          // Своя крестовина у `type="search"` в WebKit спорит с нашей.
          '[&::-webkit-search-cancel-button]:appearance-none'}
      />

      {/*
        Кнопка очистки появляется только при непустом запросе.
        Постоянно висящий крестик в пустом поле обещает действие,
        которого нет, и отбирает место у текста.
      */}
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Очистить поиск"
          title="Очистить поиск"
          className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ───────────────────────────── Выпадающий список ────────────────────────────

export function TerminalSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Доступное имя. Обязательно: без него список читается как «список». */
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  const id = useId();

  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>

      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        /*
         * `appearance-none` убирает системную стрелку и рамку.
         *
         * Без него браузер рисует своё поверх нашего: на светлой
         * системной теме вокруг поля появляется белая обводка,
         * и рядом с полем поиска это выглядит как две разные системы.
         *
         * Поведение при этом остаётся нативным: клавиатура, поиск
         * по первой букве и системный список на телефоне работают
         * как работали.
         */
        className={`${TERMINAL_CONTROL_SHAPE} ${TERMINAL_SELECT_PADDING} cursor-pointer appearance-none truncate`}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>

      {/*
        Своя стрелка — та же у сети, сортировки и списков GEMS.
        `pointer-events-none`, чтобы нажатие проходило к самому
        списку; правый отступ поля отведён под неё, поэтому длинное
        название не заезжает под значок, а обрезается многоточием.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

// ──────────────────────────── Быстрый фильтр ────────────────────────────────

/**
 * Смысловая окраска чипа.
 *
 * `accent` — обычный выбор. `check` — прошедшая проверка: бирюзовый
 * здесь не украшение, а тот же цвет, которым размечена безопасность
 * во всём продукте.
 */
export type TerminalChipTone = 'accent' | 'check';

const CHIP_ACTIVE: Record<TerminalChipTone, string> = {
  accent: 'border-accent/40 bg-accent/15 text-accent',
  check: 'border-up/40 bg-up/15 text-up',
};

export function TerminalFilterChip({
  active,
  onClick,
  children,
  tone = 'accent',
  title,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: TerminalChipTone;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      /*
       * Состояние не только цветом.
       *
       * `aria-pressed` читает программа чтения с экрана, галочка
       * видна тому, кто не различает оттенки, рамка меняет форму
       * пятна. Восемь процентов мужчин не различают красный
       * и зелёный, и полагаться на один канал нельзя.
       */
      aria-pressed={active}
      title={title}
      className={`${TERMINAL_CHIP_SHAPE} ${
        active
          ? CHIP_ACTIVE[tone]
          : 'border-border/70 text-muted hover:border-border hover:bg-raised hover:text-white'
      }`}
    >
      {icon}
      {children}
      {active && (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
          className="shrink-0"
        >
          <path d="M4 12l5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/**
 * Ряд быстрых фильтров.
 *
 * ─── Почему перенос, а не прокрутка ─────────────────────────────────
 *
 * Сначала здесь была горизонтальная прокрутка без видимой полосы.
 * На 375 пикселях выбранный «Проверенные» оказывался за правым краем
 * наполовину: чипы помещались не все, а полоса скрыта, и понять,
 * что ряд продолжается, было нельзя. Выбранный фильтр, которого
 * не видно, — худший из возможных случаев: человек не знает, почему
 * список короткий.
 *
 * Прокрутить активный элемент в видимую область скриптом можно, но
 * это лечит следствие: ряд всё равно остаётся обрезанным, просто
 * в другом месте, и при пяти фильтрах два из них видны не будут.
 *
 * Перенос по строкам гарантирует, что видны все, — без скрипта,
 * без движения и без зависимости от того, сколько чипов добавят
 * завтра. Цена — вторая строка на узком экране; она дешевле
 * невидимого включённого фильтра.
 */
export function TerminalChipRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {children}
    </div>
  );
}

// ───────────────────────────── Панель фильтров ──────────────────────────────

/**
 * Контейнер панели.
 *
 * ─── Почему всё в столбик, а не в строку на десктопе ────────────────
 *
 * Прежде здесь стоял `lg:flex-row`: с 1024 пикселей поиск и два
 * списка собирались в одну строку. Медиазапрос смотрит на ширину
 * окна, а панель живёт в левой колонке терминала шириной 340–380
 * пикселей. На широком мониторе условие срабатывало, три контрола
 * делили триста сорок пикселей на всех, и поиск схлопывался
 * до иконки с многоточием.
 *
 * Правильный ответ на «сколько места у контейнера» дают контейнерные
 * запросы, но полагаться на них здесь незачем: ответ известен заранее
 * и он один. Панель фильтров рынка всегда живёт в узкой колонке —
 * на телефоне это ширина экрана, на десктопе ширина `aside`, и обе
 * меньше того, при котором строка из трёх контролов читаема.
 *
 * Поэтому раскладка одна на всех ширинах: поиск строкой, списки
 * строкой ниже двумя равными колонками. Это скучно и предсказуемо —
 * ровно то, чего ждёшь от панели фильтров.
 */
export function TerminalFilterBar({
  search,
  selects,
  chips,
  notice,
}: {
  search: ReactNode;
  selects: ReactNode;
  chips?: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {/* Поиск — главный элемент панели и занимает строку целиком. */}
      <div className="min-w-0">{search}</div>

      {/* Две равные колонки: списки одинаковой ширины читаются как
          пара, а разной — как случайность вёрстки. */}
      <div className="grid grid-cols-2 gap-2">{selects}</div>

      {chips}
      {notice}
    </div>
  );
}

// ──────────────────────────────── Вкладки ───────────────────────────────────

/**
 * Переключатель источника списка.
 *
 * Часть той же панели, что и фильтры: вкладка меняет состав списка,
 * фильтры — его срез, и визуальный разрыв между ними заставлял бы
 * читать их как разные механизмы.
 *
 * Активная вкладка отмечена подчёркиванием и цветом текста, а не
 * заливкой: заливка спорит с чипами фильтров, которые стоят строкой
 * ниже и означают совсем другое.
 */
export function TerminalTabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: ReadonlyArray<readonly [T, string]>;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 border-b border-border">
      {items.map(([v, text]) => {
        const active = value === v;

        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 motion-reduce:transition-none ${
              active
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:border-border hover:text-white'
            }`}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
