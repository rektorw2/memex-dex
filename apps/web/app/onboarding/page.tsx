'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { appRelativePath, onboardingStep, type OnboardingStep } from '@memex/core';
import { AuthShell } from '@/components/AuthShell';
import { ONBOARDING_STEPS } from '@/components/onboarding-steps';
import { DEPLOY_BASE_PATH } from '@/lib/app-path';
import { api, ApiError } from '@/lib/api';
import { useAccess } from '@/lib/access';

/**
 * Первый сценарий после регистрации.
 *
 * Один адрес и несколько состояний вместо цепочки страниц: состояния
 * переходят друг в друга по ответу сервера, и на отдельных адресах
 * каждый переход стал бы редиректом, а два спорящих редиректа дают
 * бесконечный круг. Здесь круга нет по построению — шаг вычисляется,
 * а не назначается.
 *
 * Источник истины — `/api/access/me`. То, что интерфейс помнит о себе
 * сам, переживает выход, смену аккаунта и вкладку, открытую вчера.
 *
 * Бесплатный период включается автоматически при подтверждении
 * адреса. Отдельного нажатия больше нет: оно не несло решения —
 * отказаться от бесплатного доступа никто не хотел, — но исправно
 * теряло часть людей между экранами.
 */

const STEP_TITLE: Record<OnboardingStep, string> = {
  login: 'Нужен вход',
  'verify-email': 'Подтвердите почту',
  activate: 'Включаем Pro',
  'plans-only': 'Тарифы',
  done: 'Готово',
};

/** Какой шаг оболочки подсветить. Внутренние шаги в него сворачиваются. */
const SHELL_STEP: Record<OnboardingStep, string> = {
  login: 'auth',
  'verify-email': 'verify',
  activate: 'verify',
  'plans-only': 'plans',
  done: 'plans',
};

function OnboardingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { access, loading, anonymous, reload } = useAccess();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);

  /**
   * Идёт ли выдача периода прямо сейчас.
   *
   * Живёт только в этой вкладке: потерять безопасно, шаг
   * пересчитается по ответу сервера.
   */
  const [activating, setActivating] = useState(false);

  /** Что сервер сообщил о периоде после подтверждения. */
  const [trialOutcome, setTrialOutcome] = useState<string | null>(null);
  const [trialExpiresAt, setTrialExpiresAt] = useState<string | null>(null);

  const step: OnboardingStep = onboardingStep({
    authenticated: !anonymous,
    plan: access?.effectivePlan ?? 'EXPIRED',
    emailVerified: access?.emailVerified ?? false,
    canStartTrial: access?.canStartTrial ?? false,
    serviceAccess: access?.serviceAccess ?? false,
    activating,
  });

  /**
   * Куда уходить, когда сценарий пройден.
   *
   * Префикс развёртывания снимается: роутер добавит его сам. Раньше
   * здесь получался `/memex-dex/memex-dex/agent` — человека
   * возвращало на несуществующую страницу после успешного входа.
   */
  const destination = appRelativePath(params.get('next'), DEPLOY_BASE_PATH) ?? '/plans';

  useEffect(() => {
    if (loading) return;
    if (step === 'done') router.replace(destination);
  }, [loading, step, router, destination]);

  // Обратный отсчёт паузы между письмами. Считается от значения,
  // которое прислал сервер: часы браузера здесь не участвуют.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await api('/access/email/code', { method: 'POST', base: 'root' });
      setCodeSent(true);
      setNotice('Письмо отправлено. Код действует 15 минут.');
      setCooldown(60);
    } catch (e) {
      const body =
        e instanceof ApiError
          ? (e.body as { code?: string; retryAfterSeconds?: number } | undefined)
          : undefined;

      if (body?.code === 'TOO_SOON') {
        // Пауза считается сервером. Своя была бы подсказкой,
        // а не ограничением: время в браузере правится мгновенно.
        setCooldown(body.retryAfterSeconds ?? 60);
        setCodeSent(true);
        setNotice('Письмо уже отправлено. Проверьте почту.');
      } else if (body?.code === 'ALREADY_VERIFIED') {
        await reload();
      } else if (body?.code === 'EMAIL_DELIVERY_UNAVAILABLE') {
        setError('Отправка писем сейчас не работает. Напишите в поддержку — это не ваша ошибка.');
      } else if (body?.code === 'EMAIL_DELIVERY_FAILED') {
        setError('Почтовый сервис не принял письмо. Попробуйте ещё раз.');
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось отправить код');
      }
    } finally {
      setBusy(false);
    }
  }, [reload]);

  async function verify() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setActivating(true);

    try {
      const res = (await api('/access/email/verify', {
        method: 'POST',
        base: 'root',
        body: JSON.stringify({ code: code.trim() }),
      })) as {
        trial?: { outcome?: string; expiresAt?: string | null };
      } | null;

      /*
       * Старый ответ API этого поля не содержит.
       *
       * Фронт и API выкатываются раздельно, и несколько минут между
       * ними — обычное дело. `undefined` здесь означает «сервер ещё
       * не умеет рассказывать про период», а не «периода нет».
       */
      setTrialOutcome(res?.trial?.outcome ?? null);
      setTrialExpiresAt(res?.trial?.expiresAt ?? null);

      // Права перечитываются у сервера. Ответ о проверке кода
      // подтверждением плана не является.
      await reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;

      const text: Record<string, string> = {
        CODE_EXPIRED: 'Код устарел. Запросите новый.',
        CODE_WRONG: 'Код не подошёл. Проверьте письмо.',
        TOO_MANY_ATTEMPTS: 'Слишком много попыток. Запросите новый код.',
        NO_CODE: 'Код не запрашивался. Отправьте письмо заново.',
      };

      setError(text[body?.code ?? ''] ?? 'Код не принят');
    } finally {
      setActivating(false);
      setBusy(false);
    }
  }

  /**
   * Повтор выдачи периода.
   *
   * Путь восстановления, а не обычный шаг. Нужен ровно в одном
   * случае: подтверждение прошло, а выдача не удалась. Вызов
   * идемпотентный — второго периода он не создаёт.
   */
  async function retryTrial() {
    setBusy(true);
    setError(null);

    try {
      await api('/access/trial/activate', { method: 'POST', base: 'root' });
      await reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;

      if (body?.code === 'TRIAL_ALREADY_USED') {
        setError('Бесплатный период уже был использован.');
        await reload();
      } else {
        setError('Не удалось включить период. Попробуйте ещё раз.');
      }
    } finally {
      setBusy(false);
    }
  }

  const shellStep = SHELL_STEP[step] ?? 'verify';

  return (
    <AuthShell
      steps={ONBOARDING_STEPS}
      currentStep={shellStep}
      title={STEP_TITLE[step]}
      subtitle={
        step === 'verify-email'
          ? 'Отправим код на адрес, указанный при регистрации. Подтверждение открывает 5 дней Pro.'
          : undefined
      }
    >
      {loading ? (
        <p className="text-sm text-white/60" role="status" aria-live="polite">
          Загружаем…
        </p>
      ) : (
        <>
          {error && (
            <p
              className="mb-4 rounded-lg border border-down/30 bg-down/10 p-3 text-sm text-down"
              role="alert"
            >
              {error}
            </p>
          )}

          {notice && !error && (
            <p className="mb-4 text-sm text-white/60" role="status" aria-live="polite">
              {notice}
            </p>
          )}

          {step === 'verify-email' && (
            <VerifyEmail
              busy={busy}
              code={code}
              codeSent={codeSent}
              cooldown={cooldown}
              onCode={setCode}
              onSend={sendCode}
              onVerify={verify}
            />
          )}

          {step === 'activate' && (
            <p className="text-sm leading-relaxed text-white/70" role="status" aria-live="polite">
              Адрес подтверждён. Включаем бесплатный период…
            </p>
          )}

          {step === 'plans-only' && (
            <TrialUnavailable outcome={trialOutcome} onRetry={retryTrial} busy={busy} />
          )}

          {step === 'done' && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-white/70" role="status">
                {trialOutcome === 'STARTED'
                  ? 'Бесплатный период Pro активен.'
                  : 'Доступ открыт.'}
                {trialExpiresAt && ` Действует до ${formatUntil(trialExpiresAt)}.`}
              </p>
              <p className="text-sm text-white/50">Переходим…</p>
            </div>
          )}
        </>
      )}
    </AuthShell>
  );
}

/**
 * Период не выдан. Два разных случая под одним экраном.
 *
 * `PENDING` — сбой на нашей стороне: подтверждение прошло, выдача
 * нет. Здесь уместен повтор. Всё остальное означает, что период уже
 * был израсходован, и повторять нечего: предлагать кнопку, которая
 * заведомо откажет, — это обещание, которого мы не выполним.
 */
function TrialUnavailable({
  outcome,
  onRetry,
  busy,
}: {
  outcome: string | null;
  onRetry: () => void;
  busy: boolean;
}) {
  if (outcome === 'PENDING') {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-white/70">
          Адрес подтверждён, но включить период не удалось. Это сбой на нашей
          стороне — попробуйте ещё раз.
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:bg-[#7C3AED] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          {busy ? 'Включаем…' : 'Повторить'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-white/70">
        Бесплатный период уже был использован — он даётся один раз на аккаунт.
        Дальше только платные тарифы.
      </p>
      <div className="grid gap-3">
        <Link
          href="/plans"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:bg-[#7C3AED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          Посмотреть тарифы
        </Link>
        <Link
          href="/terminal"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-white/15 px-6 text-sm text-white/80 transition hover:border-white/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          В терминал
        </Link>
      </div>
      <p className="text-xs leading-relaxed text-white/45">
        Портфель, продажа своих активов и вывод средств остаются доступными без плана.
      </p>
    </div>
  );
}

/**
 * Ввод кода из письма.
 *
 * `one-time-code` в `autocomplete` — не украшение: с ним телефон
 * предлагает код из уведомления, и человеку не нужно переключаться
 * между приложениями и запоминать шесть цифр.
 */
function VerifyEmail({
  busy,
  code,
  codeSent,
  cooldown,
  onCode,
  onSend,
  onVerify,
}: {
  busy: boolean;
  code: string;
  codeSent: boolean;
  cooldown: number;
  onCode: (v: string) => void;
  onSend: () => void;
  onVerify: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (codeSent) inputRef.current?.focus();
  }, [codeSent]);

  if (!codeSent) {
    return (
      <button
        type="button"
        onClick={onSend}
        disabled={busy}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:bg-[#7C3AED] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        {busy ? 'Отправляем…' : 'Отправить код'}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onVerify();
      }}
      className="space-y-4"
    >
      <div>
        <label htmlFor="code" className="mb-1.5 block text-sm text-white/70">
          Код из письма
        </label>
        <input
          ref={inputRef}
          id="code"
          value={code}
          onChange={(e) => onCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          // `numeric` вместо `tel`: клавиатура без решётки и звёздочки.
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          className="w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-center font-mono text-xl tracking-[0.4em] text-white placeholder:tracking-normal placeholder:text-white/30 focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          placeholder="000000"
        />
      </div>

      <button
        type="submit"
        disabled={busy || code.trim().length < 4}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:bg-[#7C3AED] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        {busy ? 'Проверяем…' : 'Подтвердить'}
      </button>

      <button
        type="button"
        onClick={onSend}
        disabled={busy || cooldown > 0}
        className="w-full rounded px-2 py-1 text-sm text-white/55 underline underline-offset-4 transition hover:text-white disabled:no-underline disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {cooldown > 0 ? `Отправить ещё раз можно через ${cooldown} с` : 'Отправить письмо заново'}
      </button>
    </form>
  );
}

/** Дата окончания периода словами. Часовой пояс — браузера. */
function formatUntil(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <p className="py-16 text-center text-sm text-muted" role="status">
          Загружаем…
        </p>
      }
    >
      <OnboardingInner />
    </Suspense>
  );
}
