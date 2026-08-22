'use client';

import Link from 'next/link';
import { useAccess, trialRemainingLabel, formatUntil } from '../lib/access';

/**
 * Полоса состояния доступа.
 *
 * Показывает одно из трёх: приглашение начать бесплатный период,
 * остаток этого периода или сообщение о его окончании. Ничего
 * из этого интерфейс не вычисляет — всё приходит из `/api/access/me`.
 *
 * Важное решение: полоса не появляется у платных планов вовсе.
 * Постоянное напоминание «у вас PRO» ничего не добавляет и занимает
 * место на экране, где человек смотрит на цены.
 */
export function AccessBanner() {
  const { access, loading, anonymous } = useAccess();

  if (loading || anonymous || !access) return null;
  if (access.effectivePlan !== 'TRIAL' && access.effectivePlan !== 'EXPIRED') return null;

  const box: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
    padding: '10px 16px',
    fontSize: '14px',
    borderBottom: '1px solid var(--border)',
  };

  if (access.effectivePlan === 'TRIAL') {
    return (
      <div style={box}>
        <span>
          Бесплатный доступ активен до <strong>{formatUntil(access.trialExpiresAt)}</strong>
        </span>
        <span style={{ color: 'var(--muted)' }}>
          осталось {trialRemainingLabel(access.trialRemainingSeconds)}
        </span>
        <Link href="/plans" style={{ marginLeft: 'auto' }}>
          Тарифы
        </Link>
      </div>
    );
  }

  if (access.canStartTrial) {
    return (
      <div style={box}>
        <span>Пять дней полного доступа к радару и терминалу — бесплатно.</span>
        {/*
          Полоса не включает период сама. Включение требует
          подтверждённого адреса, и вести человека сразу к кнопке,
          за которой стоит отказ, — худший способ познакомить
          его с продуктом.
        */}
        <Link href="/access" style={{ marginLeft: 'auto' }}>
          Подключить бесплатный период
        </Link>
      </div>
    );
  }

  return (
    <div style={box}>
      <span>Бесплатный период закончился. Радар и новые покупки закрыты.</span>
      <span style={{ color: 'var(--muted)' }}>
        Продажа своих активов и вывод средств доступны всегда.
      </span>
      <Link href="/plans" style={{ marginLeft: 'auto' }}>
        Выбрать план
      </Link>
    </div>
  );
}
