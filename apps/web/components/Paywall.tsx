'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAccess } from '../lib/access';

/**
 * Заглушка закрытого раздела.
 *
 * Показывается вместо содержимого, когда права нет. Ключевое здесь —
 * не сама заглушка, а то, что рядом с ней всегда стоят две ссылки:
 * продать свои активы и вывести средства. Эти возможности
 * не закрываются никогда, и человек, упёршийся в paywall, должен
 * видеть это сразу, а не выяснять поиском по меню.
 *
 * Решение о доступе принимает сервер. Компонент только читает уже
 * полученный ответ: если он ошибётся в сторону «показать», сервер
 * всё равно откажет; если в сторону «скрыть» — человек увидит
 * заглушку там, где мог бы работать, и это заметно.
 */
export function Requires({
  capability,
  title,
  children,
}: {
  capability: string;
  title: string;
  children: ReactNode;
}) {
  const { can, access, loading, anonymous } = useAccess();

  if (loading) return <p style={{ color: 'var(--muted)' }}>Проверяем доступ…</p>;

  if (anonymous) {
    return (
      <div style={{ padding: '24px 0' }}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <p style={{ color: 'var(--muted)' }}>Войдите, чтобы продолжить.</p>
        <Link href="/login">Войти</Link>
      </div>
    );
  }

  if (can(capability)) return <>{children}</>;

  return (
    <div style={{ padding: '24px 0' }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>

      <p style={{ color: 'var(--muted)', maxWidth: '52ch' }}>
        {access?.canStartTrial
          ? 'Раздел входит в бесплатный период. Включите его — пять дней, без карты.'
          : 'Раздел доступен на платном плане.'}
      </p>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
        <Link href="/plans">Посмотреть тарифы</Link>

        {/*
          Две ссылки ниже стоят здесь всегда и намеренно. Человек,
          упёршийся в закрытый раздел, не должен искать, как забрать
          свои деньги: они его, и платформа за них платы не берёт.
        */}
        <Link href="/portfolio">Продать активы</Link>
        <Link href="/wallet">Вывести средства</Link>
      </div>
    </div>
  );
}
