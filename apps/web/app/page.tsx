'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { loginHref } from '@memex/core';
import { AuthShell } from '@/components/AuthShell';
import { ONBOARDING_STEPS } from '@/components/onboarding-steps';
import { useAccess } from '@/lib/access';
import { useNextParam } from '@/lib/next-param';

/**
 * Первый экран для человека без аккаунта.
 *
 * Раньше он вёл сразу на форму входа — визуально другую страницу,
 * с другим фоном и другой композицией. Переход читался как «меня
 * куда-то перебросили», и часть людей на нём и останавливалась.
 *
 * Теперь выбор появляется здесь же, в той же карточке: ролик,
 * логотип и оболочка остаются на месте, меняется только содержимое.
 * Это один путь, а не набор страниц.
 */
export default function HomePage() {
  const router = useRouter();
  const next = useNextParam();
  const { access, anonymous, loading } = useAccess();

  /**
   * Показан ли выбор способа входа.
   *
   * Состояние экрана, а не приложения: перезагрузка возвращает
   * человека к началу, и это правильно — начало ничего не стоит.
   */
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (loading || anonymous) return;

    const hasProductAccess =
      access?.serviceAccess === true ||
      access?.status === 'active' ||
      access?.status === 'trial' ||
      access?.status === 'service';

    // Вошедшего человека держать на приветствии незачем.
    router.replace(hasProductAccess ? '/terminal' : '/onboarding');
  }, [access, anonymous, loading, router]);

  return (
    <AuthShell
      steps={ONBOARDING_STEPS}
      currentStep={choosing ? 'auth' : 'start'}
      title={choosing ? 'Вход в Memex' : 'See the signal. Make your move.'}
      subtitle={
        choosing
          ? 'Новый аккаунт создаётся за минуту. Подтверждение адреса открывает пять дней Pro.'
          : 'GEMS, живые цены, графики и отслеживание ATH — в одном терминале.'
      }
      footer={
        choosing ? (
          <button
            type="button"
            onClick={() => setChoosing(false)}
            className="rounded px-2 py-1 underline underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Назад
          </button>
        ) : (
          <Link
            href="/terminal"
            className="rounded px-2 py-1 underline underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Посмотреть терминал без входа
          </Link>
        )
      }
    >
      {!choosing ? (
        <button
          type="button"
          onClick={() => setChoosing(true)}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-7 text-sm font-semibold text-white shadow-[0_14px_40px_rgba(139,92,246,.35)] transition duration-200 hover:bg-[#7C3AED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent motion-reduce:transition-none"
        >
          Get Started
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <div className="grid gap-3">
          {/*
            Регистрация первая и выделена: человек, дошедший до этого
            экрана, чаще всего здесь впервые. Вход рядом и не спрятан —
            возвращающимся не приходится его искать.
          */}
          <Link
            href={loginHref(next, { register: true })}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent px-7 text-sm font-semibold text-white shadow-[0_14px_40px_rgba(139,92,246,.35)] transition duration-200 hover:bg-[#7C3AED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent motion-reduce:transition-none"
          >
            Создать аккаунт
          </Link>
          <Link
            href={loginHref(next)}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-white/15 px-7 text-sm font-medium text-white transition duration-200 hover:border-white/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent motion-reduce:transition-none"
          >
            У меня уже есть аккаунт
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
