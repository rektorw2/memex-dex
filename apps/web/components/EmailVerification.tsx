'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAccess } from '../lib/access';

/**
 * Подтверждение адреса почты.
 *
 * Два шага, и они намеренно разделены с третьим. Подтверждение адреса
 * только открывает возможность включить бесплатный период — само оно
 * его не запускает. Человек, подтвердивший почту в понедельник
 * и вернувшийся в пятницу, не должен обнаружить, что четыре дня
 * бесплатного доступа прошли без него.
 *
 * Компонент ничего не решает о правах. Подтверждён ли адрес, можно ли
 * начать период — всё это приходит из `/api/access/me`. Здесь только
 * два запроса и показ того, что ответил сервер.
 */

interface CodeResponse {
  sent: true;
  expiresAt: string;
  /** Только на транспорте разработки. В production поля нет. */
  devCode?: string;
}

const IS_DEV = process.env.NODE_ENV === 'development';

export function EmailVerification() {
  const { access, reload } = useAccess();

  const [step, setStep] = useState<'idle' | 'sent'>('idle');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState(0);

  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Обратный отсчёт до следующего письма.
   *
   * Считается от числа, которое прислал сервер, а не от собственного
   * таймера с момента нажатия. Вкладку закрывают, часы переводят,
   * страницу перезагружают — сервер знает, сколько осталось, браузер
   * нет.
   */
  useEffect(() => {
    if (retryIn <= 0) return;

    tick.current = setInterval(() => setRetryIn((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [retryIn]);

  if (!access || access.upgradeRequired === undefined) return null;

  async function requestCode() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const res = await api<CodeResponse>('/access/email/code', {
        method: 'POST',
        base: 'root',
      });

      setStep('sent');
      setNotice('Письмо отправлено. Код действует 15 минут.');
      setRetryIn(60);
      setDevCode(IS_DEV && res.devCode ? res.devCode : null);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { code?: string; retryAfterSeconds?: number } | undefined;

        // Пауза — не ошибка пользователя. Показываем остаток и даём
        // ввести код из уже отправленного письма.
        if (body?.code === 'TOO_SOON') {
          setStep('sent');
          setRetryIn(body.retryAfterSeconds ?? 60);
          setNotice('Письмо уже отправлено. Проверьте почту.');
        } else if (body?.code === 'EMAIL_DELIVERY_UNAVAILABLE') {
          setError('Отправка писем не настроена. Напишите в поддержку — это не на вашей стороне.');
        } else if (body?.code === 'EMAIL_DELIVERY_FAILED') {
          // Пауза не началась: письма не было. Кнопка остаётся живой.
          setRetryIn(0);
          setError('Почтовый сервис не принял письмо. Попробуйте ещё раз.');
        } else if (body?.code === 'ALREADY_VERIFIED') {
          await reload();
        } else {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось запросить код');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (code.trim().length === 0) {
      setError('Введите код из письма');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api('/access/email/verify', {
        method: 'POST',
        base: 'root',
        body: JSON.stringify({ code: code.trim() }),
      });

      setCode('');
      setDevCode(null);
      setNotice('Адрес подтверждён.');
      // Права пересчитывает сервер. Интерфейс просто перечитывает их.
      await reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;

      const messages: Record<string, string> = {
        CODE_WRONG: 'Код не подходит. Проверьте цифры из письма.',
        CODE_EXPIRED: 'Код истёк. Запросите новый.',
        TOO_MANY_ATTEMPTS: 'Слишком много попыток. Запросите новый код.',
        NO_CODE: 'Код не запрашивался. Нажмите «Отправить код».',
      };

      setError(messages[body?.code ?? ''] ?? (e instanceof Error ? e.message : 'Код не принят'));
    } finally {
      setBusy(false);
    }
  }

  const verified = access.canStartTrial === false || access.effectivePlan !== 'EXPIRED';

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '16px',
        maxWidth: '520px',
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: '18px' }}>Подтверждение адреса</h2>

      <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 16px' }}>
        Код нужен один раз. После подтверждения бесплатный период включается
        отдельной кнопкой — сам он не начнётся.
      </p>

      {step === 'idle' ? (
        <button onClick={requestCode} disabled={busy}>
          {busy ? 'Отправляем…' : 'Отправить код'}
        </button>
      ) : (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ''));
              setError(null);
            }}
            style={{ width: '120px', letterSpacing: '4px', fontSize: '16px' }}
          />

          <button onClick={submitCode} disabled={busy}>
            {busy ? 'Проверяем…' : 'Подтвердить'}
          </button>

          <button onClick={requestCode} disabled={busy || retryIn > 0}>
            {retryIn > 0 ? `Новый код через ${retryIn} с` : 'Отправить снова'}
          </button>
        </div>
      )}

      {notice ? (
        <p style={{ fontSize: '14px', margin: '12px 0 0' }}>{notice}</p>
      ) : null}

      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: '14px', margin: '12px 0 0' }}>{error}</p>
      ) : null}

      {/*
        Код в интерфейсе — только на транспорте разработки, где письма
        никуда не уходят. В production сервер это поле не присылает,
        и показывать нечего.
      */}
      {devCode ? (
        <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '12px 0 0' }}>
          Письма в этой среде не отправляются. Код: <code>{devCode}</code>
        </p>
      ) : null}

      {verified ? null : (
        <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '12px 0 0' }}>
          Не приходит письмо? Проверьте папку со спамом.
        </p>
      )}
    </section>
  );
}
