'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { writeStored } from '@/lib/storage';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  withNext,
  loginHref,
  safeNextPath,
  normalizeEmail,
  emailLooksValid,
  passwordIssue,
  totpIssue,
  PASSWORD_MIN,
  PASSWORD_MAX,
  PASSWORD_HINT,
} from '@memex/core';
import { api, setToken, ApiError, NetworkError } from '@/lib/api';
import { useAccess } from '@/lib/access';

/**
 * Вход и регистрация.
 *
 * Куда идти после входа, решает не эта страница. Она знает только
 * одно: человек мог прийти сюда с закрытого адреса, и вернуть его
 * надо туда же. Всё остальное — есть ли план, подтверждена ли
 * почта — выясняет онбординг у сервера.
 *
 * ─── Про клиентскую проверку ────────────────────────────────────────
 *
 * Авторитет остаётся у сервера: всё, что проверяется здесь, он
 * проверяет заново. Смысл в другом — сказать человеку об ошибке
 * до отправки, а не после круга в сеть. Правила берутся из ядра
 * теми же функциями, что использует сервер: своя копия рано или
 * поздно разойдётся, и форма начнёт пропускать то, что сервер
 * отвергает.
 *
 * В dev-режиме показывает готовые учётные записи из сида: без этого
 * локальный запуск упирается в невозможность получить токен.
 */

/** Ошибки конкретных полей. Показываются под ними, а не общей строкой. */
interface FieldErrors {
  email?: string;
  password?: string;
  totp?: string;
}

/**
 * Сообщение над кнопкой.
 *
 * Вид важен не меньше текста: «аккаунт создан» и «неверный пароль»
 * не должны выглядеть одинаково, а «аккаунт уже существует» требует
 * действия, а не только чтения.
 */
type Notice =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'exists'; text: string }
  | null;

const EMAIL_MAX = 254;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { reload } = useAccess();

  // Кнопка «Регистрация» на первом экране приводит сразу на нужную
  // форму, а не на вход, где её ещё надо найти.
  const [mode, setMode] = useState<'login' | 'register'>(
    params.get('mode') === 'register' ? 'register' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Защёлка отправки.
   *
   * Ref, а не состояние: `setBusy(true)` применяется асинхронно,
   * React объединяет обновления, и два клика в одном тике оба
   * читают `busy === false`. Запрос уходит дважды — при регистрации
   * это две попытки создать один аккаунт, при входе две проверки
   * пароля против ограничения частоты.
   *
   * Состояние `busy` остаётся: оно рисует блокировку кнопки.
   * Ref решает, а состояние показывает.
   */
  const inFlight = useRef(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);

  const isDev = process.env.NODE_ENV === 'development';

  /*
   * Адрес — источник режима при навигации назад/вперёд и при клике
   * по действию в шапке. Без этой синхронизации Next сохраняет уже
   * смонтированную форму, и `/login?mode=register` может продолжить
   * показывать вход.
   */
  const modeFromUrl = params.get('mode') === 'register' ? 'register' : 'login';
  useEffect(() => {
    setMode(modeFromUrl);
  }, [modeFromUrl]);

  // Поле второго фактора получает фокус, как только появляется:
  // иначе человек ищет его глазами после уже введённого пароля.
  useEffect(() => {
    if (need2fa) totpRef.current?.focus();
  }, [need2fa]);

  /**
   * Проверка перед отправкой.
   *
   * Возвращает ошибки полей; пустой объект означает «можно отправлять».
   * Правила — из ядра: те же функции проверяют вход на сервере.
   */
  function validate(value: { email: string; password: string; totp: string }): FieldErrors {
    const next: FieldErrors = {};

    const address = normalizeEmail(value.email);

    if (address.length === 0) next.email = 'Введите адрес почты';
    else if (address.length > EMAIL_MAX) next.email = 'Адрес слишком длинный';
    else if (!emailLooksValid(address)) next.email = 'Проверьте адрес: похоже, он неполный';

    if (mode === 'register') {
      /*
       * Полные правила пароля — только при регистрации.
       *
       * На входе применять их нельзя: аккаунт мог быть заведён
       * по прежним правилам, и отказ из-за новой нижней границы
       * запер бы человека снаружи от его собственных денег.
       */
      const issue = passwordIssue(value.password);

      if (issue === 'EMPTY') next.password = 'Введите пароль';
      else if (issue === 'WHITESPACE_ONLY') next.password = 'Пароль не может состоять из пробелов';
      else if (issue === 'TOO_SHORT') next.password = `Не короче ${PASSWORD_MIN} знаков`;
      else if (issue === 'TOO_LONG') next.password = `Не длиннее ${PASSWORD_MAX} знаков`;
    } else {
      if (value.password.length === 0) next.password = 'Введите пароль';
      else if (value.password.trim().length === 0) {
        next.password = 'Пароль не может состоять из пробелов';
      } else if (value.password.length > PASSWORD_MAX) {
        // Верхняя граница остаётся и на входе: она про стоимость
        // хэширования на сервере, а не про надёжность пароля.
        next.password = `Не длиннее ${PASSWORD_MAX} знаков`;
      }
    }

    if (need2fa) {
      const issue = totpIssue(value.totp);
      if (issue != null) next.totp = 'Введите шестизначный код';
    }

    return next;
  }

  /** Фокус на первое поле с ошибкой: человек не должен её искать. */
  function focusFirstError(errors: FieldErrors): void {
    if (errors.email) emailRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
    else if (errors.totp) totpRef.current?.focus();
  }

  /**
   * Переключение на вход с сохранением адреса.
   *
   * Общее для двух случаев: аккаунт создан и аккаунт уже был.
   * В обоих человек оказывается перед формой входа с уже введённым
   * адресом и пустым полем пароля.
   */
  function switchToLogin(text: string, kind: 'info' | 'exists'): void {
    setMode('login');
    setEmail(normalizeEmail(email));
    // Пароль очищается всегда: он либо уже использован при создании,
    // либо не подошёл — оставлять его в поле незачем.
    setPassword('');
    setFields({});
    setNotice({ kind, text });

    /*
     * Адрес приводится к режиму входа без перезагрузки.
     *
     * `replace`, а не `push`: возврат назад на форму регистрации,
     * которой уже нет на экране, только запутал бы. Шапка следит
     * за тем же параметром и сама вернёт кнопку «Регистрация».
     */
    router.replace(loginHref(params.get('next')), { scroll: false });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    // Второй submit, пока первый в пути, не отправляет ничего.
    if (inFlight.current) return;

    const address = normalizeEmail(email);
    const errors = validate({ email: address, password, totp });

    if (Object.keys(errors).length > 0) {
      setFields(errors);
      setNotice(null);
      focusFirstError(errors);
      // Запрос не уходит вовсе: круг в сеть ради заранее известного
      // отказа — это только задержка.
      return;
    }

    setFields({});
    inFlight.current = true;
    setBusy(true);
    setNotice(null);

    // Нормализованный адрес попадает и в поле, и в запрос: человек
    // видит ровно то, что отправлено.
    setEmail(address);

    try {
      if (mode === 'register') {
        await api('/auth/register', {
          method: 'POST',
          // Пароль уходит как есть: пробелы могут быть его частью,
          // и `trim` сломал бы вход тем, кто их использует.
          body: JSON.stringify({ email: address, password }),
        });

        switchToLogin('Аккаунт создан — теперь войдите', 'info');
        return;
      }

      const res = await api<{ accessToken: string; refreshToken: string; role: string }>(
        '/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({
            email: address,
            password,
            ...(need2fa ? { totp: totp.trim() } : {}),
          }),
        },
      );

      setToken(res.accessToken);

      /*
       * Неудачная запись не отменяет успешный вход.
       *
       * Сессия живёт на сервере; здесь только копии для интерфейса.
       * Прямой `setItem` бросал бы в приватном режиме Safari — сразу
       * после того, как сервер уже принял пароль, — и человек видел бы
       * ошибку входа при действующей сессии.
       */
      writeStored('local', 'refreshToken', res.refreshToken);
      writeStored('local', 'role', res.role);

      // Права перечитываются до перехода: иначе следующая страница
      // отрисуется по состоянию гостя и мигнёт закрытым интерфейсом.
      await reload();

      // Адрес, с которого человека сюда отправили, идёт дальше —
      // в онбординг, а тот вернёт человека туда, куда он шёл.
      //
      // Проверка «начинается с косой черты» одна недостаточна:
      // `//evil.example/x` ей удовлетворяет, а браузер прочитает
      // его как чужой хост. Это открытый редирект, и стоит он
      // введённого у мошенника пароля.
      const next = safeNextPath(params.get('next'));

      // Онбординг сам решит, показывать выбор тарифа или пропустить:
      // он спрашивает сервер, а не помнит о себе.
      router.push(withNext('/onboarding', next));
    } catch (err) {
      /*
       * Аккаунт уже существует.
       *
       * Узнаётся по коду, а не по тексту: формулировку правят при
       * первой же редактуре, код — нет. Показывать «Аккаунт создан»
       * здесь нельзя ни в каком виде — человек уйдёт ждать письма,
       * которого не будет.
       */
      if (err instanceof ApiError && err.code === 'ACCOUNT_ALREADY_EXISTS') {
        setNotice({ kind: 'exists', text: 'Аккаунт уже существует — войдите' });
        setPassword('');
        return;
      }

      // Сервер сигналит, что пароль верный, но нужен второй фактор.
      if (err instanceof ApiError && err.status === 401 && err.message.includes('2FA')) {
        setNeed2fa(true);
        setNotice({ kind: 'info', text: 'Введите код из приложения-аутентификатора' });
        return;
      }

      if (err instanceof NetworkError) {
        // Сетевой сбой — не неверный пароль. Прежде оба показывались
        // одинаково, и неподнятый бэкенд выглядел как ошибка ввода.
        setNotice({ kind: 'error', text: err.message });
      } else if (err instanceof ApiError) {
        setNotice({ kind: 'error', text: err.message });
      } else {
        setNotice({
          kind: 'error',
          text: `Неожиданная ошибка: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function fillDev(devEmail: string) {
    setEmail(devEmail);
    setPassword('DevPassword123!');
  }

  const noticeClass =
    notice?.kind === 'info'
      ? 'border-border bg-raised text-muted'
      : notice?.kind === 'exists'
        ? 'border-warn/30 bg-warn/10 text-warn'
        : 'border-down/30 bg-down/10 text-down';

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <form onSubmit={submit} noValidate className="panel space-y-4 p-6">
        <h1 className="text-xl font-bold">{mode === 'login' ? 'Вход' : 'Регистрация'}</h1>

        <div>
          <label className="label" htmlFor="auth-email">
            Email
          </label>
          <input
            id="auth-email"
            ref={emailRef}
            className="input font-sans"
            type="email"
            value={email}
            /*
             * Значение не трогается при вводе.
             *
             * Приведение на каждом нажатии переставляет курсор
             * и мешает печатать: человек набирает заглавную букву,
             * а она тут же исчезает. Нормализация происходит при
             * потере фокуса и при отправке.
             */
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setEmail((v) => normalizeEmail(v))}
            autoComplete="email"
            maxLength={EMAIL_MAX}
            aria-invalid={fields.email ? true : undefined}
            aria-describedby={fields.email ? 'auth-email-error' : undefined}
          />
          {fields.email && (
            <p id="auth-email-error" role="alert" className="mt-1 text-xs text-down">
              {fields.email}
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="auth-password">
            Пароль
          </label>
          <input
            id="auth-password"
            ref={passwordRef}
            className="input font-sans"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            maxLength={PASSWORD_MAX}
            aria-invalid={fields.password ? true : undefined}
            aria-describedby={
              [fields.password ? 'auth-password-error' : null, mode === 'register' ? 'auth-password-hint' : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />

          {/*
            Требования, а не оценка «надёжности».
            Полоска «слабый/сильный» обещает знание, которого у нас
            нет: она измеряет форму строки, а не то, угадают ли её.
          */}
          {mode === 'register' && (
            <p id="auth-password-hint" className="mt-1 text-xs text-muted">
              {PASSWORD_HINT}
            </p>
          )}

          {fields.password && (
            <p id="auth-password-error" role="alert" className="mt-1 text-xs text-down">
              {fields.password}
            </p>
          )}
        </div>

        {need2fa && (
          <div>
            <label className="label" htmlFor="auth-totp">
              Код 2FA
            </label>
            <input
              id="auth-totp"
              ref={totpRef}
              className="input"
              value={totp}
              // Поле принимает только цифры: буквы означают, что
              // человек вставил не то, и сказать это надо сразу.
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              aria-invalid={fields.totp ? true : undefined}
              aria-describedby={fields.totp ? 'auth-totp-error' : undefined}
            />
            {fields.totp && (
              <p id="auth-totp-error" role="alert" className="mt-1 text-xs text-down">
                {fields.totp}
              </p>
            )}
          </div>
        )}

        {notice && (
          <div className={`space-y-2 rounded border p-2 text-xs ${noticeClass}`} role="status">
            <p>{notice.text}</p>

            {/*
              У существующего аккаунта есть продолжение, и оно одно.
              Сообщение без действия оставляет человека там же, где
              он был.
            */}
            {notice.kind === 'exists' && (
              <button
                type="button"
                onClick={() => switchToLogin('Введите пароль от вашего аккаунта', 'info')}
                className="btn-ghost tap px-3 py-1 text-xs"
              >
                Войти
              </button>
            )}
          </div>
        )}

        <button
          type="submit"
          // Блокировка только на время запроса: пустые поля ловит
          // проверка и объясняет причину, а отключённая кнопка
          // молчит о том, чего не хватает.
          disabled={busy}
          className="btn w-full bg-accent text-white hover:bg-accent/80"
        >
          {busy ? '...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>

        <button
          type="button"
          onClick={() => {
            const nextMode = mode === 'login' ? 'register' : 'login';
            setMode(nextMode);
            setFields({});
            setNotice(null);
            router.replace(
              loginHref(params.get('next'), { register: nextMode === 'register' }),
              { scroll: false },
            );
          }}
          className="w-full text-center text-xs text-accent"
        >
          {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>

        <p className="text-center text-xs text-muted">
          <Link href="/terminal" className="hover:text-white">
            Посмотреть терминал без входа
          </Link>
        </p>
      </form>

      {isDev && (
        <div className="panel mt-4 space-y-2 p-4">
          <p className="text-xs text-muted">
            Тестовые аккаунты из сида (только в режиме разработки):
          </p>
          {[
            ['admin@memex.local', 'Админ — публикация коллов'],
            ['leader@memex.local', 'Лидер копитрейдинга'],
            ['user@memex.local', 'Пользователь, подписан на лидера'],
          ].map(([mail, desc]) => (
            <button
              key={mail}
              onClick={() => fillDev(mail!)}
              className="w-full rounded bg-bg p-2 text-left text-xs transition-colors hover:bg-border"
            >
              <div className="font-mono">{mail}</div>
              <div className="text-muted">{desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="mt-16 text-center text-muted">Загружаем…</p>}>
      <LoginForm />
    </Suspense>
  );
}
