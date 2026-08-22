'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { needsOnboarding } from '@memex/core';
import { useAccess, trialRemainingLabel, formatUntil } from '@/lib/access';

/**
 * Состояние доступа. Только показывает.
 *
 * Раньше здесь был второй, независимый путь включения бесплатного
 * периода: своя форма подтверждения почты и своя кнопка активации.
 * Два пути к одному действию — это не удобство, а два набора правил,
 * которые расходятся при первой же правке одного из них. Здешний
 * путь к тому же обходил явный выбор тарифа: человек включал период,
 * ни разу не увидев, что именно он получает и что бывает дальше.
 *
 * Теперь включение живёт ровно в одном месте — в `/onboarding`,
 * и тот, кому период ещё доступен, отправляется туда. Здесь остаётся
 * то, для чего страница и нужна: посмотреть, что сейчас действует
 * и до какого числа.
 */
export default function AccessPage() {
  const router = useRouter();
  const { access, loading, anonymous } = useAccess();

  const shouldOnboard =
    !loading &&
    !anonymous &&
    access != null &&
    needsOnboarding({
      authenticated: true,
      plan: access.effectivePlan,
      emailVerified: access.emailVerified,
      canStartTrial: access.canStartTrial,
      // Намерения у страницы нет: она никого ни к чему не подталкивает,
      // а только отправляет туда, где выбор делается явно.
      choseTrial: false,
    });

  useEffect(() => {
    if (shouldOnboard) router.replace('/onboarding');
  }, [shouldOnboard, router]);

  if (loading) {
    return (
      <p className="text-muted" role="status" aria-live="polite">
        Загружаем…
      </p>
    );
  }

  // Сюда не должен доходить никто: маршрут закрыт сторожем.
  // Но если дошёл — честный ответ вместо пустого экрана.
  if (anonymous || !access) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Доступ</h1>
        <p className="text-muted">Войдите, чтобы продолжить.</p>
        <Link href="/login" className="text-accent hover:underline">
          Войти
        </Link>
      </div>
    );
  }

  if (shouldOnboard) {
    return (
      <p className="text-muted" role="status" aria-live="polite">
        Переходим…
      </p>
    );
  }

  const trialActive = access.effectivePlan === 'TRIAL';

  return (
    <div className="grid max-w-[640px] gap-6">
      <h1 className="text-xl font-bold">Доступ</h1>

      <section className="rounded-xl border border-border p-4">
        <h2 className="mt-0 text-lg font-medium">
          {trialActive ? 'Бесплатный период' : 'Текущий план'}
        </h2>

        {trialActive ? (
          <p className="m-0 text-sm">
            Активен до <strong>{formatUntil(access.trialExpiresAt)}</strong>, осталось{' '}
            {trialRemainingLabel(access.trialRemainingSeconds)}.
          </p>
        ) : access.effectivePlan !== 'EXPIRED' ? (
          <p className="m-0 text-sm">
            Действует <strong>{access.effectivePlan}</strong>.
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">
            Действующего плана нет.{' '}
            {/* Кнопки активации здесь нет намеренно: бесплатный период
                уже использован, а платные тарифы живут на своей странице. */}
            <Link href="/plans" className="text-accent hover:underline">
              Тарифы
            </Link>
            .
          </p>
        )}
      </section>

      <p className="m-0 text-sm text-muted">
        Продажа своих активов, вывод средств и просмотр портфеля доступны всегда —
        независимо от плана и от того, закончился ли период.
      </p>
    </div>
  );
}
