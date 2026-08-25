'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  accessIndicatorState,
  type AccessIndicatorIcon,
  type AccessIndicatorTone,
  type AccessIndicatorView,
} from '@memex/core';
import { useAccess, trialRemainingLabel, formatUntil } from '@/lib/access';

/**
 * Состояние доступа в верхней панели.
 *
 * ─── Что было ───────────────────────────────────────────────────────
 *
 * Под шапкой на каждой странице висела полоса во всю ширину: два-три
 * предложения текста и ссылка, теряющаяся справа. Она занимала
 * полезную высоту всегда, выглядела как системное предупреждение —
 * то есть как поломка, а не как состояние аккаунта, — и на телефоне
 * съедала заметную часть первого экрана.
 *
 * ─── Что стало ──────────────────────────────────────────────────────
 *
 * Компактный индикатор рядом с бейджем `paper`. Оба говорят
 * о состоянии, но о разном: `paper` — режим торговли, этот —
 * доступ. Сливать их нельзя, поэтому они стоят рядом, а не вместо.
 *
 * ─── Два представления, одно решение ────────────────────────────────
 *
 * До 1024 пикселей верхняя панель отдана логотипу, гамбургеру
 * и аккаунту — места на статусы там нет, и втискивание индикатора
 * подрезало навигацию. Поэтому на узких экранах он переезжает
 * в выдвижную панель отдельной строкой, где хватает ширины
 * на полную подпись.
 *
 * Оба представления — один компонент с разным оформлением, а не два
 * похожих. Два компонента означали бы два набора условий по тарифам,
 * и разошлись бы они молча: на телефоне человек видел бы одно,
 * на ноутбуке другое.
 *
 * ─── Почему ссылка, а не кнопка с попапом ───────────────────────────
 *
 * У каждого состояния ровно одно осмысленное продолжение: посмотреть
 * состояние доступа или выбрать план. Попап поставил бы между
 * человеком и этим продолжением лишнее нажатие ради текста, который
 * всё равно подробнее написан на той странице, куда он ведёт.
 *
 * Пояснение остаётся: подсказка появляется по наведению и по фокусу
 * с клавиатуры и снимается по Escape. На телефоне, где наведения нет,
 * то же самое доступно через `aria-label` и `title`.
 *
 * ─── Чего здесь нет ─────────────────────────────────────────────────
 *
 * Решения о том, что показывать. Оно целиком в `accessIndicatorState`
 * и проверено тестами; здесь только оформление. Разрозненные условия
 * по тарифам в разметке — это и есть тот способ, которым состояния
 * расходятся с правами.
 *
 * Нового запроса тоже нет: `AccessProvider` уже загрузил `/access/me`
 * и объединяет параллельные обращения.
 */

const TONE_CLASS: Record<AccessIndicatorTone, string> = {
  // Акцентный фиолетовый — у главного действия и у действующего доступа.
  accent: 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/20',
  // Предупреждающий — только у действительно закончившегося доступа.
  warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
  neutral: 'border-border bg-raised text-muted hover:text-white',
};

/**
 * Значки.
 *
 * Рисуются здесь, а не приходят из состояния: `accessIndicatorState`
 * возвращает имя, и это правильная граница — правило о доступе
 * не должно знать про длину пути в SVG.
 */
function Icon({ name }: { name: AccessIndicatorIcon }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'shrink-0',
  };

  switch (name) {
    case 'gift':
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="4" rx="1" />
          <path d="M12 8v13M5 12v9h14v-9" />
          <path d="M12 8a3 3 0 1 1 3-3 6 6 0 0 1-3 3 6 6 0 0 1-3-3 3 3 0 1 1 3 3z" />
        </svg>
      );

    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );

    case 'lock':
      return (
        <svg {...common}>
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      );

    case 'crown':
      return (
        <svg {...common}>
          <path d="M3 18h18M4 8l4 4 4-7 4 7 4-4-1.5 10h-13z" />
        </svg>
      );

    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
        </svg>
      );

    case 'pending':
      // Пустой круг: место занято, утверждения нет.
      return (
        <svg {...common} strokeWidth={1.5}>
          <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
        </svg>
      );
  }
}

/**
 * Где рисуется индикатор.
 *
 * `compact` — верхняя панель от 1024 пикселей: значок и короткая
 * подпись в строку с `paper`.
 *
 * `menu` — строка внутри выдвижной панели на узких экранах: полная
 * ширина, полная подпись, надпись «Доступ» над состоянием.
 */
export type AccessStatusVariant = 'compact' | 'menu';

export function AccessStatusControl({
  variant = 'compact',
}: {
  variant?: AccessStatusVariant;
} = {}) {
  const { access, loading, anonymous, hasSession } = useAccess();

  const view = accessIndicatorState({
    /*
     * Наличие сессии и ответ сервера — разные вопросы.
     *
     * `anonymous` начинается с `true`: провайдер ещё не спрашивал.
     * Пока индикатор смотрел только на него, вошедший человек при
     * каждой загрузке страницы полсекунды считался гостем — элемент
     * не рисовался, а затем появлялся и сдвигал соседей в шапке.
     */
    hasSession,
    anonymous,
    loading,
    access,
    /*
     * Остаток и дата приходят готовыми.
     *
     * Оба считаются от секунд, присланных сервером. Второй таймер
     * по часам браузера показал бы «осталось 4 дня» при закончившемся
     * периоде, если часы на машине сбиты, — и человек не понял бы,
     * почему ничего не работает.
     */
    trialRemaining: access ? trialRemainingLabel(access.trialRemainingSeconds) : undefined,
    trialUntil: access ? formatUntil(access.trialExpiresAt) : undefined,
  });

  // Гость не получает ни индикатора, ни пустого места под него —
  // ни в шапке, ни в меню.
  if (view.variant === 'hidden') return null;

  return variant === 'menu' ? <MenuRow view={view} /> : <CompactPill view={view} />;
}

// ────────────────────────── Строка в меню ───────────────────────────────────

const MENU_TONE: Record<AccessIndicatorTone, string> = {
  accent: 'text-accent',
  warn: 'text-warn',
  neutral: 'text-muted',
};

/**
 * Состояние доступа в выдвижной панели.
 *
 * Карточка, а не баннер: надпись сверху, состояние крупно, ничего
 * лишнего. Место под заголовком панели и над разделами выбрано
 * не случайно — это первое, что человек видит, открыв меню,
 * и одновременно то, что не мешает ему пройти к разделам мимо.
 *
 * Подпись здесь полная: ширины хватает, и прятать её, как в шапке,
 * незачем.
 */
function MenuRow({ view }: { view: AccessIndicatorView }) {
  const body = (
    <>
      <span
        aria-hidden
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-raised ${MENU_TONE[view.tone]}`}
      >
        <Icon name={view.icon} />
      </span>

      <span className="min-w-0 flex-1">
        {/* Короткое слово над состоянием: без него «Trial · 4 дн 8 ч»
            в списке разделов читается как ещё один раздел. */}
        <span className="block text-[11px] uppercase tracking-wide text-muted/70">Доступ</span>
        <span className={`block truncate text-[14px] ${MENU_TONE[view.tone]}`}>
          {view.label || view.accessibleLabel}
        </span>
      </span>

      {view.href && (
        <span aria-hidden className="shrink-0 text-muted/60">
          ›
        </span>
      )}
    </>
  );

  const shape =
    'flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 ' +
    'focus-visible:outline-accent';

  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      {view.href ? (
        /*
         * Вся строка — одна ссылка.
         *
         * Панель закроется сама: `MobileNav` реагирует на смену
         * маршрута. Отдельного обработчика закрытия здесь нет
         * намеренно — второй способ закрывать панель разошёлся бы
         * с первым при первой же правке.
         */
        <Link
          href={view.href}
          aria-label={view.accessibleLabel}
          title={view.accessibleLabel}
          className={`${shape} transition-colors hover:bg-raised motion-reduce:transition-none`}
        >
          {body}
        </Link>
      ) : (
        // Пока состояние неизвестно, вести некуда: ссылка была бы
        // догадкой о том, что человеку нужно.
        <span
          role="status"
          aria-live="polite"
          aria-label={view.accessibleLabel}
          title={view.accessibleLabel}
          className={`${shape} cursor-default`}
        >
          {body}
        </span>
      )}
    </div>
  );
}

// ──────────────────────── Пилюля в верхней панели ───────────────────────────

function CompactPill({ view }: { view: AccessIndicatorView }) {
  const [hinted, setHinted] = useState(false);
  const tipId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hinted) return;

    const onKey = (e: KeyboardEvent) => {
      // Escape снимает подсказку, не уводя фокус: человек, дошедший
      // сюда с клавиатуры, продолжает обход с того же места.
      if (e.key === 'Escape') setHinted(false);
    };

    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setHinted(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [hinted]);

  /*
   * Общий вид: тот же рост и та же скруглённость, что у `paper`.
   *
   * Подпись показывается целиком: пилюля существует только от 1024
   * пикселей, а там места хватает. Прежде она пряталась на узких
   * экранах через `hidden lg:inline` — оставался безымянный значок
   * в и без того тесной шапке. Теперь на узких экранах индикатора
   * в шапке нет вовсе, а состояние живёт строкой в выдвижной панели.
   */
  const shape =
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 ' +
    'text-xs transition-colors focus-visible:outline focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    // Движение отключается вместе с остальным по системной настройке.
    'motion-reduce:transition-none';

  const className = `${shape} ${TONE_CLASS[view.tone]}`;

  const label = (
    <>
      <Icon name={view.icon} />
      {view.label && <span>{view.label}</span>}
    </>
  );

  const shared = {
    'aria-label': view.accessibleLabel,
    title: view.accessibleLabel,
    'aria-describedby': view.tooltip ? tipId : undefined,
    onMouseEnter: () => setHinted(true),
    onMouseLeave: () => setHinted(false),
    onFocus: () => setHinted(true),
    onBlur: () => setHinted(false),
  };

  return (
    /*
     * Пилюли нет до 1024 пикселей.
     *
     * Тот же порог, что у гамбургера и полной навигации: ниже него
     * верхняя панель отдана логотипу, меню и аккаунту. Прежде
     * индикатор жил здесь на всех ширинах и отбирал у навигации
     * ещё сорок пикселей ровно там, где ей и так не хватало, —
     * в полосе 768–1023.
     */
    <div ref={boxRef} className="relative hidden items-center lg:flex">
      {view.href ? (
        <Link href={view.href} className={className} {...shared}>
          {label}
        </Link>
      ) : (
        /*
         * Состояние без продолжения.
         *
         * Пока ответа нет, вести некуда: любая ссылка здесь была бы
         * догадкой о том, что человеку нужно. `span` вместо
         * `button`, потому что нажимать не на что.
         */
        <span
          className={`${className} cursor-default`}
          role="status"
          aria-live="polite"
          {...shared}
        >
          {label}
          {view.variant === 'pending' && (
            /*
             * Ширина под будущую подпись.
             *
             * Ответ придёт и принесёт «Бесплатный доступ» или
             * «Trial · 4 дн 8 ч»; без резерва соседние элементы
             * шапки дёрнулись бы в этот момент. В выдвижной панели
             * резерв не нужен: строка там и так во всю ширину.
             */
            <span aria-hidden className="inline-block w-[92px]" />
          )}
        </span>
      )}

      {view.tooltip && (
        <span
          id={tipId}
          role="tooltip"
          // Подсказка всегда есть в разметке — так её читает
          // `aria-describedby` независимо от наведения.
          className={`pointer-events-none absolute right-0 top-full z-50 mt-2 max-w-[240px] rounded-md border border-border bg-panel px-3 py-2 text-[11px] leading-snug text-muted shadow-xl transition-opacity motion-reduce:transition-none ${
            hinted ? 'opacity-100' : 'invisible opacity-0'
          }`}
        >
          {view.tooltip}
        </span>
      )}
    </div>
  );
}
