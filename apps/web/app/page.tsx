'use client';

import Link from 'next/link';
import { withNext, loginHref } from '@memex/core';
import { useAccess } from '@/lib/access';
import { useNextParam } from '@/lib/next-param';
import { TopGainerCard } from '@/components/TopGainerCard';

/**
 * Первый экран.
 *
 * До этого релиза корень открывал терминал: три колонки цифр человеку,
 * который ещё не знает, что это за продукт и зачем ему аккаунт. Теперь
 * терминал живёт на `/terminal` и остаётся открытым без входа —
 * с первого экрана туда ведёт отдельная кнопка.
 *
 * Экран говорит три вещи и на этом останавливается: что это,
 * что тут происходит прямо сейчас, и что делать дальше. Список
 * возможностей, цены и сравнение планов сюда не выносятся —
 * человек, впервые открывший торговый терминал, не читает таблицы,
 * он смотрит, живой ли рынок.
 *
 * Карточка лидера роста здесь именно поэтому: это единственное
 * доказательство, что за интерфейсом есть настоящие данные. И она же
 * ведёт в терминал с уже выбранным токеном — самый короткий путь
 * от «что это» до «покажи».
 *
 * Вошедшему человеку экран не мешает: он видит кнопку в приложение
 * вместо предложения зарегистрироваться.
 */
export default function WelcomePage() {
  const { anonymous, loading, access } = useAccess();

  /**
   * Куда человек шёл, когда его сюда отправили.
   *
   * Сторож приводит на первый экран с этим параметром, и дальше его
   * надо нести до конца цепочки: вход → онбординг → исходный адрес.
   * Кнопка, потерявшая его здесь, обрывает путь ровно посередине —
   * человек входит и оказывается не там, куда шёл.
   */
  const next = useNextParam();

  // Пока права загружаются, показываем нейтральный вариант без кнопок
  // аккаунта. Мигание «Регистрация» → «В приложение» на каждой
  // загрузке выглядит как сбой.
  const showAccountActions = !loading;
  const hasPlan = !anonymous && access != null && access.effectivePlan !== 'EXPIRED';

  return (
    <div className="mx-auto flex min-h-[calc(100vh-var(--header-h,56px)-2rem)] max-w-5xl flex-col justify-center py-10 sm:py-16">
      <div className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-14">
        {/* ─── Что это ───────────────────────────────────────────────── */}
        <div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            me<span className="text-accent">mex</span>
          </h1>

          <p className="mt-4 max-w-[46ch] text-lg leading-relaxed text-muted sm:text-xl">
            Терминал для мем-коинов на Solana и BNB Chain. Находки, оценка риска
            до покупки и защитные выходы — в одном месте.
          </p>

          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-muted/80">
            Каждый токен проверяется до того, как попадёт в список: ликвидность,
            владелец контракта, возможность продать. Непроверенное помечено
            непроверенным, а не безопасным.
          </p>

          {/* ─── Что делать дальше ──────────────────────────────────── */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {showAccountActions && hasPlan ? (
              <Link href={next ?? '/terminal'} className="btn-primary px-6 py-2.5 text-sm">
                {next ? 'Продолжить' : 'В приложение'}
              </Link>
            ) : showAccountActions && !anonymous ? (
              // Вошёл, но плана нет — самый частый случай возврата.
              <Link href={withNext('/onboarding', next)} className="btn-primary px-6 py-2.5 text-sm">
                Продолжить
              </Link>
            ) : showAccountActions ? (
              <>
                <Link
                  href={loginHref(next, { register: true })}
                  className="btn-primary px-6 py-2.5 text-sm"
                >
                  Начать бесплатно
                </Link>
                <Link
                  href={loginHref(next)}
                  className="btn px-5 py-2.5 text-sm text-muted hover:text-white"
                >
                  Войти
                </Link>
              </>
            ) : null}

            {/* Терминал открыт всегда и всем. Кнопка стоит рядом
                с регистрацией намеренно: продукт, который просят
                оценить вслепую, закрывают не глядя. */}
            <Link
              href="/terminal"
              className={`text-sm underline-offset-4 hover:underline ${
                hasPlan ? 'text-muted hover:text-white' : 'text-accent'
              }`}
            >
              Открыть терминал без регистрации →
            </Link>
          </div>

          {showAccountActions && anonymous && (
            <p className="mt-4 text-xs text-muted/70">
              Бесплатный период — 5 суток, без карты. Один раз на аккаунт.
            </p>
          )}
        </div>

        {/* ─── Что происходит прямо сейчас ──────────────────────────── */}
        <div className="flex justify-start lg:justify-end">
          <TopGainerCard />
        </div>
      </div>

      {/* ─── Честное предупреждение ────────────────────────────────── */}
      <p className="mt-12 max-w-[64ch] text-xs leading-relaxed text-muted/60">
        Мем-коины крайне волатильны и могут обесцениться до нуля. Оценка риска
        и статистика находок не являются инвестиционной рекомендацией. Торговля
        ведётся в бумажном режиме: заявки исполняются по реальным котировкам,
        деньги не задействованы.
      </p>
    </div>
  );
}
