'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api';
import { useAccess, trialRemainingLabel, formatUntil } from '../../lib/access';
import { EmailVerification } from '../../components/EmailVerification';

/**
 * Доступ: подтверждение адреса и бесплатный период.
 *
 * Два шага на одной странице, но не один шаг. Подтверждение адреса
 * не запускает период — оно только снимает препятствие. Запускает
 * человек, отдельной кнопкой, когда собирается пользоваться: пять
 * суток, начавшиеся сами собой, заканчиваются раньше, чем человек
 * успевает посмотреть продукт.
 */
export default function AccessPage() {
  const { access, loading, anonymous, reload } = useAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <p style={{ color: 'var(--muted)' }}>Загружаем…</p>;

  if (anonymous || !access) {
    return (
      <div>
        <h1>Доступ</h1>
        <p style={{ color: 'var(--muted)' }}>Войдите, чтобы продолжить.</p>
        <Link href="/login">Войти</Link>
      </div>
    );
  }

  async function startTrial() {
    setBusy(true);
    setError(null);

    try {
      await api('/access/trial/activate', { method: 'POST', base: 'root' });
      await reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;

      setError(
        body?.code === 'EMAIL_NOT_VERIFIED'
          ? 'Сначала подтвердите адрес почты выше.'
          : e instanceof Error
            ? e.message
            : 'Не удалось включить период',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '24px', maxWidth: '640px' }}>
      <h1 style={{ margin: 0 }}>Доступ</h1>

      {access.canStartTrial ? <EmailVerification /> : null}

      <section style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '16px' }}>
        <h2 style={{ marginTop: 0, fontSize: '18px' }}>Бесплатный период</h2>

        {access.effectivePlan === 'TRIAL' ? (
          <p style={{ margin: 0 }}>
            Активен до <strong>{formatUntil(access.trialExpiresAt)}</strong>, осталось{' '}
            {trialRemainingLabel(access.trialRemainingSeconds)}.
          </p>
        ) : access.canStartTrial ? (
          <>
            <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 12px' }}>
              Пять суток полного доступа к радару и терминалу. Один раз на аккаунт.
              Начнётся в момент нажатия, а не раньше.
            </p>

            <button onClick={startTrial} disabled={busy}>
              {busy ? 'Включаем…' : 'Активировать бесплатный период'}
            </button>

            {error ? (
              <p style={{ color: 'var(--danger)', fontSize: '14px', margin: '12px 0 0' }}>
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <p style={{ color: 'var(--muted)', margin: 0 }}>
            Бесплатный период уже использован. <Link href="/plans">Тарифы</Link>.
          </p>
        )}
      </section>

      <p style={{ color: 'var(--muted)', fontSize: '14px', margin: 0 }}>
        Продажа своих активов, вывод средств и просмотр портфеля доступны всегда —
        независимо от плана и от того, закончился ли период.
      </p>
    </div>
  );
}
