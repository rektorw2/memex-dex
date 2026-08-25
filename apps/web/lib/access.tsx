'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, AUTH_CHANGED_EVENT, hasToken } from './api';

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
  status: 'expired' | 'trial' | 'active' | 'service';
  capabilities: string[];
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  trialRemainingSeconds: number;
  canStartTrial: boolean;
  /**
   * Подтверждён ли адрес почты.
   *
   * Нужен первому сценарию: без подтверждения пробный период
   * не выдаётся, и шаг «подтвердите почту» должен появляться
   * до нажатия, а не после отказа.
   */
  emailVerified: boolean;
  /**
   * Доступ выдан ролью, а не тарифом.
   *
   * Решает сервер. Интерфейс по нему только выбирает, что показать:
   * предлагать администратору купить то, что у него и так есть,
   * значит показывать, что мы не знаем собственного состояния.
   */
  serviceAccess: boolean;
  upgradeRequired: boolean;
  serverTime: string;
}

interface AccessContext {
  access: AccessState | null;
  /**
   * Идёт самая первая загрузка: о человеке ещё ничего не известно.
   *
   * Отличается от фоновой перепроверки намеренно. Раньше был один
   * признак на оба случая, и `RouteGuard` подменял страницу
   * надписью «Проверяем доступ…» при каждом обновлении прав —
   * даже когда права уже были известны и не менялись.
   */
  loading: boolean;
  /** Перепроверка поверх известного состояния. Интерфейс не прячется. */
  revalidating: boolean;
  /** Ответа нет дольше обычного: скорее всего, API просыпается. */
  coldStart: boolean;
  /** Не авторизован. Отличается от «нет прав»: тут поможет вход. */
  anonymous: boolean;
  /**
   * В браузере есть токен сессии.
   *
   * Отвечает на вопрос, на который `anonymous` до первого ответа
   * сервера ответить не может. `anonymous` начинается с `true` —
   * это не «человек гость», а «мы ещё не спрашивали». Пока
   * различия не было, вошедший человек при каждой загрузке
   * страницы полсекунды считался гостем, и всё, что зависит
   * от авторизации, успевало мигнуть чужим состоянием.
   *
   * Живёт здесь, а не в каждом компоненте: провайдер прав —
   * и есть то единственное место, где интерфейс узнаёт, кто перед
   * ним. Второй ответ на тот же вопрос рано или поздно разошёлся бы
   * с этим.
   */
  hasSession: boolean;
  error: string | null;
  reload: () => Promise<void>;
  can: (capability: string) => boolean;
}

const Ctx = createContext<AccessContext>({
  access: null,
  loading: true,
  revalidating: false,
  coldStart: false,
  anonymous: true,
  hasSession: false,
  error: null,
  reload: async () => {},
  can: () => false,
});

/**
 * Через сколько молчание считается холодным стартом.
 *
 * Бесплатный тариф Render усыпляет сервис после пятнадцати минут
 * простоя, и первый запрос ждёт около полуминуты. Без отдельного
 * состояния это выглядит как зависший интерфейс, и человек уходит
 * за десять секунд до ответа.
 */
const COLD_START_HINT_MS = 2_500;

/** Сколько ждать, прежде чем признать попытку неудачной. */
const REQUEST_TIMEOUT_MS = 60_000;

export function AccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [settled, setSettled] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [coldStart, setColdStart] = useState(false);
  const [anonymous, setAnonymous] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Запрос, который уже летит.
   *
   * Несколько компонентов зовут `reload` одновременно — после входа,
   * после подтверждения почты, после активации периода. Без этого
   * на сервер уходило бы три одинаковых запроса подряд, и каждый
   * платил бы своей задержкой.
   */
  const inFlight = useRef<Promise<void> | null>(null);

  const reload = useCallback(async () => {
    // Присоединяемся к уже летящему запросу вместо второго такого же.
    if (inFlight.current) return inFlight.current;

    const run = (async () => {
      setRevalidating(true);
      setError(null);

      // Подсказка о холодном старте появляется не сразу: при быстром
      // ответе она успела бы мигнуть и этим только помешала.
      const hint = setTimeout(() => setColdStart(true), COLD_START_HINT_MS);

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Сервер не ответил вовремя')),
          REQUEST_TIMEOUT_MS,
        ),
      );

      try {
        const res = await Promise.race([
          api<AccessState>('/access/me', { base: 'root' }),
          timeout,
        ]);

        setAccess(res);
        setAnonymous(false);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Не ошибка, а состояние: человек просто не вошёл.
          setAccess(null);
          setAnonymous(true);
        } else {
          // Прежнее состояние не стирается: у человека, чьи права
          // уже известны, интерфейс не должен схлопываться из-за
          // одной неудачной перепроверки.
          setError(e instanceof Error ? e.message : 'Не удалось получить права');
        }
      } finally {
        clearTimeout(hint);
        setColdStart(false);
        setRevalidating(false);
        setSettled(true);
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Есть ли токен сессии.
   *
   * Читается после монтирования: `sessionStorage` существует только
   * в браузере, и обращение к нему при отрисовке на сервере
   * рассинхронизировало бы гидратацию.
   *
   * Дальше состояние поддерживается событиями, а не опросом. Своё
   * событие `AUTH_CHANGED_EVENT` рассылает `api.ts` рядом
   * с единственной точкой записи токена; `storage` приносит новости
   * из других вкладок, куда своё событие не долетает.
   */
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    const read = () => setHasSession(hasToken());

    read();

    window.addEventListener(AUTH_CHANGED_EVENT, read);
    window.addEventListener('storage', read);

    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, []);

  // Загрузка — только пока ответа не было ни разу. Дальше любое
  // обновление идёт фоном, поверх уже известного состояния.
  const loading = !settled;

  const can = useCallback(
    (capability: string) => access?.capabilities.includes(capability) ?? false,
    [access],
  );

  return (
    <Ctx.Provider
      value={{
        access,
        loading,
        revalidating,
        coldStart,
        anonymous,
        hasSession,
        error,
        reload,
        can,
      }}
    >
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
