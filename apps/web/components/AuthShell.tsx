'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { publicAsset } from '@/lib/public-assets';

const welcomeVideo = publicAsset('/welcome/memex-welcome-1080p.mp4');
const welcomePoster = publicAsset('/welcome/memex-welcome-poster.jpg');

/**
 * Общая оболочка первого сценария.
 *
 * Начало, вход, регистрация, подтверждение адреса и выбор тарифа —
 * это один путь, а не пять страниц. Когда каждая из них выглядела
 * по-своему, человек на каждом шаге заново решал, туда ли он попал.
 *
 * Ролик живёт здесь в единственном экземпляре. Скопировать его в пять
 * компонентов значило бы получить пять слегка разных вариантов
 * поведения при отключённой анимации, экономии трафика и ошибке
 * загрузки — а расходиться они начали бы с первой же правки.
 *
 * Главное правило вёрстки: карточка действий никогда не оказывается
 * под видео. На узких экранах ролик занимает верхнюю часть и
 * ограничен по высоте, на широких — уходит в фон слева. Человек
 * не должен прокручивать ролик, чтобы найти поле ввода.
 */

export interface AuthStep {
  id: string;
  label: string;
}

interface Props {
  /** Шаги пути. Показываются как индикатор прогресса. */
  steps: readonly AuthStep[];
  /** Текущий шаг. Должен быть одним из `steps`. */
  currentStep: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Спокойная ссылка под карточкой. Необязательна. */
  footer?: ReactNode;
}

export function AuthShell({ steps, currentStep, title, subtitle, children, footer }: Props) {
  const activeIndex = Math.max(0, steps.findIndex((s) => s.id === currentStep));

  return (
    <div className="relative isolate min-h-[100svh] overflow-hidden bg-bg text-text">
      <AuthVideo />

      {/*
        Затемнение отдельным слоем, а не фильтром на видео: фильтр
        применился бы и к постеру, и к запасному фону, и контраст
        поплыл бы ровно в тех состояниях, ради которых он нужен.
      */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,11,15,.35)_0%,rgba(8,11,15,.72)_46%,rgba(8,11,15,.94)_100%)] lg:bg-[linear-gradient(90deg,rgba(8,11,15,.35)_0%,rgba(8,11,15,.8)_52%,#080b0f_100%)]"
      />

      <div className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-[1440px] flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))] sm:px-8 lg:flex-row lg:items-center lg:gap-12 lg:px-16">
        {/*
          Левая колонка на широких экранах — эмоциональная часть.
          На узких она сжимается до логотипа: место нужно форме.
        */}
        <div className="flex shrink-0 items-center justify-between lg:min-h-[60svh] lg:w-[46%] lg:flex-col lg:items-start lg:justify-center">
          <Link
            href="/"
            className="rounded text-xl font-bold tracking-tight drop-shadow-[0_2px_10px_rgba(0,0,0,.7)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:text-2xl"
          >
            me<span className="text-accent">mex</span>
          </Link>

          <div className="hidden lg:mt-8 lg:block">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-up">
              Live signal intelligence
            </p>
            <p className="mt-4 max-w-[420px] text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.03em] drop-shadow-[0_4px_24px_rgba(0,0,0,.65)]">
              See the signal.
              <br />
              Make your move.
            </p>
          </div>

          {/* Индикатор шагов на узких экранах стоит в шапке. */}
          <StepDots steps={steps} activeIndex={activeIndex} className="lg:hidden" />
        </div>

        {/*
          Карточка действий. Ширина фиксирована, чтобы поля не прыгали
          между шагами: одинаковая форма читается как один процесс,
          а разъезжающаяся — как разные страницы.
        */}
        <div className="flex flex-1 items-center justify-center py-8 lg:py-0">
          <div className="w-full max-w-[420px]">
            <StepDots steps={steps} activeIndex={activeIndex} className="mb-6 hidden lg:flex" />

            <div
              // Устойчивая метка карточки. Проверки не должны цепляться
              // за классы оформления: те меняются при первой правке
              // стилей и уносят с собой смысл проверки.
              data-auth-card=""
              className="rounded-2xl border border-white/10 bg-[rgba(12,16,22,.82)] p-5 shadow-[0_24px_70px_rgba(0,0,0,.55)] backdrop-blur-md sm:p-7"
            >
              <h1 className="text-balance text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-[28px]">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-2 text-sm leading-relaxed text-white/65">{subtitle}</p>
              )}

              <div className="mt-6">{children}</div>
            </div>

            {footer && <div className="mt-5 text-center text-sm text-white/55">{footer}</div>}

            <p className="mt-6 text-center text-[10px] leading-relaxed text-white/40 sm:text-[11px]">
              Crypto assets are highly volatile. No result is guaranteed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Индикатор шагов.
 *
 * Точки, а не номера: номер обещает, что шагов ровно столько и они
 * не изменятся, а точка просто показывает, где человек находится.
 * Название текущего шага рядом — иначе точки ничего не сообщают.
 */
function StepDots({
  steps,
  activeIndex,
  className = '',
}: {
  steps: readonly AuthStep[];
  activeIndex: number;
  className?: string;
}) {
  return (
    <nav aria-label="Шаги" className={`flex items-center gap-2 ${className}`}>
      <ol className="flex items-center gap-1.5">
        {steps.map((step, index) => (
          <li key={step.id}>
            <span
              data-step={step.id}
              data-state={index === activeIndex ? 'current' : index < activeIndex ? 'done' : 'next'}
              // Служебная точка: смысл несёт подпись справа.
              aria-hidden="true"
              className={`block h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none ${
                index === activeIndex
                  ? 'w-6 bg-accent'
                  : index < activeIndex
                    ? 'w-1.5 bg-white/55'
                    : 'w-1.5 bg-white/20'
              }`}
            />
          </li>
        ))}
      </ol>
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/55">
        {steps[activeIndex]?.label}
      </span>
    </nav>
  );
}

/**
 * Фоновое видео со всеми запасными вариантами.
 *
 * Ролик — украшение, и он обязан вести себя как украшение: не мешать,
 * не тратить чужой трафик и не ломать форму, если не загрузился.
 *
 * Три причины показать вместо него постер:
 *   • человек попросил не анимировать (`prefers-reduced-motion`);
 *   • человек экономит трафик (`Save-Data`);
 *   • файл не загрузился.
 *
 * Во всех трёх случаях остаётся статичная картинка, а не пустота:
 * форма стоит на фоне, а не в воздухе.
 */
function AuthVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [posterOnly, setPosterOnly] = useState(false);

  useEffect(() => {
    /*
     * Экономия трафика проверяется один раз, до загрузки.
     *
     * Поле нестандартное и есть не везде, поэтому читается мягко:
     * его отсутствие означает «ограничений нет», а не ошибку.
     */
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) {
      setPosterOnly(true);
      return;
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');

    const sync = () => {
      const video = videoRef.current;
      if (!video) return;

      if (media.matches) {
        video.pause();
        // Возврат к началу: замерший на середине кадр выглядит
        // случайным, а первый кадр совпадает с постером.
        video.currentTime = 0;
        setPosterOnly(true);
        return;
      }

      setPosterOnly(false);
      /*
       * `play()` не везде возвращает промис.
       *
       * В старых Safari и в некоторых средах он возвращает
       * `undefined`, и `.catch` на нём падает — то есть попытка
       * красиво обработать запрет автозапуска сама ломает страницу.
       * `Promise.resolve` уравнивает оба случая.
       */
      void Promise.resolve(video.play()).catch(() => {
        // Браузер вправе запретить автозапуск. Постер остаётся
        // полноценным фоном, и ничего чинить не нужно.
      });
    };

    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return (
    <div
      aria-hidden="true"
      /*
       * На узких экранах ролик занимает верх и ограничен по высоте:
       * иначе форма уезжает за нижний край, и человек прокручивает
       * видео, чтобы найти поле ввода. На широких — весь фон.
       */
      className="absolute inset-x-0 top-0 h-[38svh] overflow-hidden lg:inset-0 lg:h-full"
    >
      <img
        src={welcomePoster}
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[60%_center] lg:object-center"
      />
      {!posterOnly && (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover object-[60%_center] lg:object-center"
          src={welcomeVideo}
          poster={welcomePoster}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          // Ошибка загрузки не ломает форму: убираем видео и
          // оставляем постер, который уже лежит слоем ниже.
          onError={() => setPosterOnly(true)}
        />
      )}
      {/* Мягкая граница между роликом и карточкой на узких экранах. */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-[linear-gradient(180deg,transparent,#080b0f)] lg:hidden" />
    </div>
  );
}
