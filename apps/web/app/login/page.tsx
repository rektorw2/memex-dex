'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken, ApiError, NetworkError } from '@/lib/api';

/**
 * Вход в систему. В dev-режиме показывает готовые учётные записи из сида —
 * без этого локальный запуск упирается в невозможность получить токен.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isDev = process.env.NODE_ENV === 'development';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        setMode('login');
        setError('Аккаунт создан — теперь войдите');
        return;
      }

      const res = await api<{ accessToken: string; refreshToken: string; role: string }>(
        '/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }),
        },
      );

      setToken(res.accessToken);
      localStorage.setItem('refreshToken', res.refreshToken);
      localStorage.setItem('role', res.role);
      router.push(res.role === 'ADMIN' ? '/admin' : '/');
    } catch (err) {
      // Сервер сигналит, что пароль верный, но нужен второй фактор.
      if (err instanceof ApiError && err.status === 401 && err.message.includes('2FA')) {
        setNeed2fa(true);
        setError('Введите код из приложения-аутентификатора');
        return;
      }

      if (err instanceof NetworkError) {
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        // Раньше сюда попадало всё подряд и показывалось «Не удалось войти»,
        // из-за чего неподнятый бэкенд выглядел как неверный пароль.
        setError(`Неожиданная ошибка: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  function fillDev(devEmail: string) {
    setEmail(devEmail);
    setPassword('DevPassword123!');
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <form onSubmit={submit} className="panel p-6 space-y-4">
        <h1 className="text-xl font-bold">
          {mode === 'login' ? 'Вход' : 'Регистрация'}
        </h1>

        <div>
          <label className="label">Email</label>
          <input
            className="input font-sans"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label className="label">
            Пароль {mode === 'register' && <span className="text-muted">(минимум 10 символов)</span>}
          </label>
          <input
            className="input font-sans"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 10 : undefined}
          />
        </div>

        {need2fa && (
          <div>
            <label className="label">Код 2FA</label>
            <input
              className="input"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
            />
          </div>
        )}

        {error && (
          <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="btn bg-accent hover:bg-accent/80 text-white w-full"
        >
          {busy ? '...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          className="text-xs text-accent w-full text-center"
        >
          {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>
      </form>

      {isDev && (
        <div className="panel p-4 mt-4 space-y-2">
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
              className="w-full text-left text-xs p-2 rounded bg-bg hover:bg-border transition-colors"
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
