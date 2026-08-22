'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { onboardingStep, safeNextPath, type OnboardingStep } from '@memex/core';
import { api, ApiError } from '@/lib/api';
import { useAccess } from '@/lib/access';

/**
 * Первый сценарий после регистрации.
 *
 * Один адрес и несколько состояний вместо цепочки страниц. Причина
 * практическая: состояния переходят друг в друга по ответу сервера,
 * и на отдельных адресах каждый переход стал бы редиректом, а два
 * редиректа, спорящих между собой, дают бесконечный круг. Здесь
 * круга нет по построению — шаг вычисляется, а не назначается.
 *
 * Источник истины — `/api/access/me`. То, что интерфейс помнит о себе
 * сам, переживает выход, смену аккаунта и вкладку, открытую вчера;
 * каждый из этих случаев показал бы человеку чужой шаг.
 *
 * Пробный период не начинается сам. Ни регистрация, ни вход, ни
 * открытие этой страницы, ни запрос кода его не включают: пять суток
 * даются один раз за всё время, и потратить их на человека, который
 * зашёл посмотреть, значит отобрать их у него же через месяц.
 * Включает только явное нажатие.
 */

const STEP_TITLE: Record<OnboardingStep, string> = {
  login: 'Нужен вход',
  'choose-plan': 'Выберите тариф',
  'verify-email': 'Подтвердите почту',
  activate: 'Включаем бесплатный период',
  'plans-only': 'Тарифы',
  done: 'Готово',
};

function OnboardingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { access, loading, anonymous, reload } = useAccess();

  /**
   * Нажал ли человек «Pro — бесплатный период».
   *
   * Намерение, а не состояние: на сервере его нет и быть не должно.
   * Живёт только в этой вкладке и только до перезагрузки — потерять
   * его безопасно, человек просто нажмёт ещё раз.
   */
  const [choseTrial, setChoseTrial] = useState(false);

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);

  const step: OnboardingStep = onboardingStep({
    authenticated: !anonymous,
    plan: access?.effectivePlan ?? 'EXPIRED',
    emailVerified: access?.emailVerified ?? false,
    canStartTrial: access?.canStartTrial ?? false,
    choseTrial,
  });

  /**
   * Куда уходить, когда онбординг пройден.
   *
   * Конец цепочки: закрытый маршрут → первый экран → вход →
   * онбординг → исходный адрес. Здесь параметр перестаёт жить,
   * и здесь же он проверяется в последний раз — чужой хост
   * в этом месте увёл бы человека сразу после успешного входа.
   */
  const destination = safeNextPath(params.get('next')) ?? '/terminal';

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

    try {
      await api('/access/email/verify', {
        method: 'POST',
        base: 'root',
        body: JSON.stringify({ code: code.trim() }),
      });

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
      setBusy(false);
    }
  }

  async function activateTrial() {
    setBusy(true);
    setError(null);

    try {
      // Идемпотентно: повторный вызов находит существующий период
      // и возвращает его, не двигая ни начала, ни конца.
      await api('/access/trial/activate', { method: 'POST', base: 'root' });
      await reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;

      if (body?.code === 'EMAIL_NOT_VERIFIED') {
        setError('Сначала подтвердите адрес почты.');
        await reload();
      } else if (body?.code === 'TRIAL_ALREADY_USED') {
        setError('Бесплатный период уже был использован.');
        await reload();
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось включить период');
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <p className="py-16 text-center text-sm text-muted" role="status" aria-live="polite">
        Загружаем…
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-8 sm:py-14">
      <Progress step={step} />

      <h1 className="mt-6 text-2xl font-bold tracking-tight">{STEP_TITLE[step]}</h1>

      {error && (
        <p
          className="mt-4 rounded border border-down/30 bg-down/10 p-3 text-sm text-down"
          role="alert"
        >
          {error}
        </p>
      )}

      {notice && !error && (
        <p className="mt-4 text-sm text-muted" role="status" aria-live="polite">
          {notice}
        </p>
      )}

      {step === 'choose-plan' && (
        <ChoosePlan busy={busy} onChooseTrial={() => setChoseTrial(true)} />
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
          onBack={() => setChoseTrial(false)}
        />
      )}

      {step === 'activate' && (
        <section className="mt-6 space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            Почта подтверждена. Осталось включить период — 5 суток доступа
            уровня Pro. Списание не начнётся: карту мы не спрашивали
            и не спросим.
          </p>

          <button onClick={activateTrial} disabled={busy} className="btn-primary px-6 py-2.5">
            {busy ? 'Включаем…' : 'Включить бесплатный период'}
          </button>
        </section>
      )}

      {step === 'plans-only' && (
        <section className="mt-6 space-y-4">
          <p className="max-w-[52ch] text-sm leading-relaxed text-muted">
            Бесплатный период уже был использован — он даётся один раз
            на аккаунт. Дальше только платные тарифы.
          </p>

          <div className="flex flex-wrap gap-3">
            <Link href="/plans" className="btn-primary px-6 py-2.5 text-sm">
              Посмотреть тарифы
            </Link>
            <Link href="/terminal" className="btn px-5 py-2.5 text-sm text-muted hover:text-white">
              В терминал
            </Link>
          </div>

          <p className="text-xs leading-relaxed text-muted/70">
            Портфель, продажа своих активов и вывод средств остаются
            доступными без плана.
          </p>
        </section>
      )}

      {step === 'done' && (
        <p className="mt-6 text-sm text-muted" role="status">
          Доступ открыт. Переходим…
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────── Выбор плана ─────────────────────────────────

/**
 * Тарифы на этом шаге.
 *
 * Semi Auto и Auto показаны, но выбрать их нельзя: они ещё не готовы.
 * Показать активную кнопку, за которой ничего нет, хуже, чем честно
 * написать «скоро» — человек нажмёт и решит, что сломался он.
 *
 * Кнопок покупки за 50/100/200 USDC здесь нет намеренно. Платёжные
 * модули работают и не тронуты, но к этому сценарию не подключены:
 * первый экран после регистрации не место для оплаты.
 */
const PLAN_CARDS = [
  {
    code: 'PRO',
    title: 'Pro',
    badge: 'Бесплатный период',
    price: '5 суток бесплатно',
    available: true,
    features: [
      'Радар находок',
      'Разбор токена в терминале',
      'Смарт-кошельки',
      'Ручная покупка и продажа',
      'Защитные выходы',
    ],
  },
  {
    code: 'SEMI_AUTO',
    title: 'Semi Auto',
    badge: 'Coming soon',
    price: 'Скоро',
    available: false,
    features: ['Всё из Pro', 'Копирование покупок лидера', 'Вход по сигналу'],
  },
  {
    code: 'FULL_AUTO',
    title: 'Auto',
    badge: 'Coming soon',
    price: 'Скоро',
    available: false,
    features: ['Всё из Semi Auto', 'Автоматическая покупка', 'Автоматический выход'],
  },
] as const;

function ChoosePlan({ busy, onChooseTrial }: { busy: boolean; onChooseTrial: () => void }) {
  return (
    <div className="mt-6 space-y-4">
      <p className="max-w-[52ch] text-sm leading-relaxed text-muted">
        Начните с Pro — первые 5 суток бесплатно, карта не нужна. Списание
        автоматически не начинается: когда период закончится, доступ просто
        закроется, и вы решите, продолжать ли.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {PLAN_CARDS.map((p) => (
          <section
            key={p.code}
            className={`panel flex flex-col p-4 ${p.available ? '' : 'opacity-60'}`}
            aria-disabled={!p.available}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-semibold">{p.title}</h2>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                  p.available ? 'bg-accent/15 text-accent' : 'bg-raised text-muted'
                }`}
              >
                {p.badge}
              </span>
            </div>

            <p className="mt-1 text-sm text-muted">{p.price}</p>

            <ul className="mt-3 flex-1 space-y-1.5 text-xs leading-relaxed text-muted">
              {p.features.map((f) => (
                <li key={f}>· {f}</li>
              ))}
            </ul>

            {p.available ? (
              <button
                onClick={onChooseTrial}
                disabled={busy}
                className="btn-primary mt-4 w-full py-2 text-sm"
              >
                Выбрать
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-disabled="true"
                title="Пока недоступно"
                className="btn mt-4 w-full cursor-not-allowed py-2 text-sm text-muted"
              >
                Coming soon
              </button>
            )}
          </section>
        ))}
      </div>

      <p className="text-xs text-muted/70">
        <Link href="/terminal" className="hover:text-white">
          Пока просто посмотреть терминал →
        </Link>
      </p>
    </div>
  );
}

// ───────────────────────────── Подтверждение почты ───────────────────────────

function VerifyEmail({
  busy,
  code,
  codeSent,
  cooldown,
  onCode,
  onSend,
  onVerify,
  onBack,
}: {
  busy: boolean;
  code: string;
  codeSent: boolean;
  cooldown: number;
  onCode: (v: string) => void;
  onSend: () => void;
  onVerify: () => void;
  onBack: () => void;
}) {
  return (
    <section className="mt-6 space-y-4">
      <p className="max-w-[52ch] text-sm leading-relaxed text-muted">
        {/* Адрес не спрашиваем и не показываем полем ввода: код уходит
            только на почту этого аккаунта. Поле означало бы возможность
            подтвердить чужой адрес. */}
        Отправим код на адрес вашего аккаунта. Это нужно один раз — без
        подтверждённой почты бесплатный период не выдаётся.
      </p>

      {!codeSent ? (
        <button onClick={onSend} disabled={busy} className="btn-primary px-6 py-2.5 text-sm">
          {busy ? 'Отправляем…' : 'Отправить код'}
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onVerify();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label" htmlFor="verify-code">
              Код из письма
            </label>
            <input
              id="verify-code"
              className="input num max-w-[200px] tracking-[0.3em]"
              value={code}
              onChange={(e) => onCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              required
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="btn-primary px-6 py-2.5 text-sm"
            >
              {busy ? 'Проверяем…' : 'Подтвердить'}
            </button>

            <button
              type="button"
              onClick={onSend}
              disabled={busy || cooldown > 0}
              className="text-xs text-accent disabled:text-muted"
            >
              {cooldown > 0 ? `Отправить снова через ${cooldown} с` : 'Отправить код заново'}
            </button>
          </div>
        </form>
      )}

      <button type="button" onClick={onBack} className="text-xs text-muted hover:text-white">
        ← Назад к тарифам
      </button>
    </section>
  );
}

// ─────────────────────────────── Полоса шагов ────────────────────────────────

const VISIBLE_STEPS: { key: OnboardingStep; label: string }[] = [
  { key: 'choose-plan', label: 'Тариф' },
  { key: 'verify-email', label: 'Почта' },
  { key: 'activate', label: 'Доступ' },
];

function Progress({ step }: { step: OnboardingStep }) {
  const current = VISIBLE_STEPS.findIndex((s) => s.key === step);
  if (current === -1) return null;

  return (
    <ol className="flex items-center gap-2 text-xs text-muted">
      {VISIBLE_STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={
              i < current ? 'text-accent' : i === current ? 'font-medium text-white' : 'text-muted/60'
            }
            aria-current={i === current ? 'step' : undefined}
          >
            {i + 1}. {s.label}
          </span>
          {i < VISIBLE_STEPS.length - 1 && <span aria-hidden className="text-muted/40">→</span>}
        </li>
      ))}
    </ol>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-muted">Загружаем…</p>}>
      <OnboardingInner />
    </Suspense>
  );
}
