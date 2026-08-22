'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

/**
 * Права пользователя в интерфейсе.
 *
 * Единственный источник — ответ сервера. Здесь нет ни таблицы планов,
 * ни правила «пробный период длится пять суток», ни списка того, что
 * даёт PRO. Всё это уже описано один раз, в `packages/core`, и второй
 * список рано или поздно с ним разойдётся — а разойдясь, покажет
 * человеку кнопку, за которой стоит отказ.
 *
 * Поэтому интерфейс спрашивает и показывает, но не решает. Скрытая
 * кнопка защитой всё равно не является: запрос можно отправить и без
 * неё, и сервер отказывает сам.
 */

export type PlanCode = 'EXPIRED' | 'TRIAL' | 'PRO' | 'SEMI_AUTO' | 'FULL_AUTO';

export interface AccessState {
  effectivePlan: PlanCode;
  status: 'expired' | 'trial' | 'active';
  capabilities: string[];
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  trialRemainingSeconds: number;
  canStartTrial: boolean;
  upgradeRequired: boolean;
  serverTime: string;
}

interface AccessContext {
  access: AccessState | null;
  loading: boolean;
  /** Не авторизован. Отличается от «нет прав»: тут поможет вход. */
  anonymous: boolean;
  error: string | null;
  reload: () => Promise<void>;
  can: (capability: string) => boolean;
}

const Ctx = createContext<AccessContext>({
  access: null,
  loading: true,
  anonymous: true,
  error: null,
  reload: async () => {},
  can: () => false,
});

export function AccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [anonymous, setAnonymous] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await api<AccessState>('/access/me', { base: 'root' });
      setAccess(res);
      setAnonymous(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Не ошибка, а состояние: человек просто не вошёл.
        setAccess(null);
        setAnonymous(true);
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось получить права');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const can = useCallback(
    (capability: string) => access?.capabilities.includes(capability) ?? false,
    [access],
  );

  return (
    <Ctx.Provider value={{ access, loading, anonymous, error, reload, can }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAccess(): AccessContext {
  return useContext(Ctx);
}

/**
 * Остаток пробного периода словами.
 *
 * Считается от значения, которое прислал сервер, а не от разницы
 * с часами браузера. Часы на компьютере могут отставать на сутки,
 * и «осталось 4 дня» при истёкшем периоде — худший из возможных
 * ответов: человек не поймёт, почему кнопка не работает.
 */
export function trialRemainingLabel(seconds: number): string {
  if (seconds <= 0) return 'Период закончился';

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days} дн ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

/** Дата окончания в местном формате. Для баннера. */
export function formatUntil(iso: string | null): string {
  if (!iso) return '';

  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
