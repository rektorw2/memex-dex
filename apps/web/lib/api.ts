import { apiBaseFor } from '@memex/core';
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    /**
     * Тело ответа целиком.
     *
     * `details` исторически несёт разбор полей от zod, и класть туда
     * же машинный код причины значило бы получить поле, смысл
     * которого зависит от того, кто ошибку бросил. Коды вроде
     * `TOO_SOON` или `EMAIL_DELIVERY_FAILED` живут здесь — интерфейсу
     * они нужны, чтобы отличить паузу от поломки.
     */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Сеть не ответила: сервер не запущен, упал, не тот порт или CORS.
 * Отдельный класс нужен, чтобы интерфейс не показывал «неверный пароль»
 * там, где на самом деле не поднят бэкенд.
 */
export class NetworkError extends Error {
  constructor(public url: string, public cause?: unknown) {
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
    super(
      isLocal
        ? `API не отвечает по адресу ${url}. Проверьте, что бэкенд запущен (npm run dev) ` +
            `и открывается http://localhost:4000/health`
        : // На бесплатных тарифах сервис засыпает после простоя, и первый
          // запрос обрывается по таймауту. Без этой подсказки выглядит
          // как поломка, хотя достаточно просто повторить попытку.
          `Сервер не ответил (${new URL(url).origin}). Если приложение развёрнуто ` +
            `на бесплатном тарифе, оно могло уснуть — подождите около минуты ` +
            `и повторите. Иначе проверьте, что API запущен и его адрес указан в CORS.`,
    );
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Токен держим в памяти модуля + sessionStorage.
  // localStorage сознательно не используем: XSS-утечка долгоживущего
  // токена на бирже стоит дороже, чем повторный вход после закрытия вкладки.
  return sessionStorage.getItem('accessToken');
}

/**
 * Основание пути.
 *
 * Почти всё живёт под `/api/v1`, но маршруты доступа — под `/api`:
 * они не про версию торгового интерфейса, а про то, кто пользователь
 * и что ему разрешено. Держать их в одной версии с торговыми
 * маршрутами значило бы менять адрес прав при каждой смене версии
 * торгового API.
 */
export type ApiBase = 'v1' | 'root';

function baseFor(kind: ApiBase): string {
  return kind === 'root' ? BASE.replace(/\/v1$/, '') : BASE;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { idempotencyKey?: string; base?: ApiBase } = {},
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = {
    // Заголовок ставится только когда тело действительно есть.
    // Fastify отклоняет запрос с content-type: application/json и пустым
    // телом — а такие у нас все действия без параметров: публикация колла,
    // запуск импорта, выход из сессии.
    ...(init.body != null ? { 'content-type': 'application/json' } : {}),
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  /*
   * База выбирается по таблице, если её не задали явно.
   *
   * Раньше умолчанием было `v1`, и всякий вызов к маршрутам доступа
   * или оплаты требовал помнить про `base: 'root'`. Один раз
   * не вспомнили — страница тарифов получила три ответа 404 и молча
   * показала пустой каталог.
   *
   * Явно указанный `base` сохраняет приоритет: таблица описывает
   * обычный случай, а не запрещает исключения.
   */
  const url = `${baseFor(init.base ?? apiBaseFor(path))}${path}`;

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (cause) {
    // fetch отклоняется только при сетевом сбое — HTTP-коды сюда не попадают.
    throw new NetworkError(url, cause);
  }

  const text = await res.text();

  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Не JSON — обычно это HTML-страница ошибки от прокси или
      // стектрейс. Показываем начало ответа, иначе причина теряется.
      throw new ApiError(
        `Сервер вернул не JSON (HTTP ${res.status}): ${text.slice(0, 120)}`,
        res.status,
      );
    }
  }

  if (!res.ok) {
    throw new ApiError(
      data?.error ?? `Ошибка ${res.status}`,
      res.status,
      data?.details,
      data ?? undefined,
    );
  }
  return data as T;
}

/**
 * Загрузчик для SWR.
 *
 * Базу выбирает `api`, по той же таблице. Здесь не повторяется:
 * два места, где выбирают базу, — это два места, где её однажды
 * выберут по-разному.
 */
export const fetcher = <T>(path: string) => api<T>(path);

/**
 * Явный загрузчик для маршрутов под `/api`.
 *
 * Делает то же самое, что `fetcher`, — таблица даёт для этих путей
 * ту же базу, — но говорит об этом на месте вызова. На странице,
 * где рядом стоят запросы к обеим базам, читать намерение полезнее,
 * чем догадываться о нём.
 *
 * Отдельная стабильная ссылка, а не стрелка на месте вызова: SWR
 * сравнивает загрузчик по ссылке, и новая функция на каждый рендер
 * заставляла бы его перезапрашивать.
 */
export const rootFetcher = <T>(path: string) => api<T>(path, { base: 'root' });

/**
 * Единая расшифровка ошибки для интерфейса.
 *
 * Раньше каждый экран писал своё «Не удалось …» для всего, что не ApiError,
 * и настоящая причина — неподнятый бэкенд, CORS, опечатка в адресе —
 * пропадала. Пользователь видел «неверный пароль» там, где сервер
 * вообще не отвечал.
 */
export function errorMessage(e: unknown, fallback = 'Что-то пошло не так'): string {
  if (e instanceof NetworkError) return e.message;
  if (e instanceof ApiError) {
    if (e.details && typeof e.details === 'object') {
      const fields = Object.entries(e.details as Record<string, string[]>)
        .map(([k, v]) => `${k}: ${v.join(', ')}`)
        .join('; ');
      return fields ? `${e.message} — ${fields}` : e.message;
    }
    return e.message;
  }
  if (e instanceof Error) return `${fallback}: ${e.message}`;
  return fallback;
}

export function setToken(token: string) {
  sessionStorage.setItem('accessToken', token);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ─── Форматирование ────────────────────────────────────────────────────────

export function fmtUsd(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';

  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  // Ступень миллиардов обязательна. Без неё общий объём рынка
  // выглядел как «$33211.25M» — формально верно, но прочитать
  // порядок величины с одного взгляда невозможно.
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Число для оси графика.
 *
 * Отличается от fmtPrice тем, что не показывает лишних знаков:
 * подпись «2.5000000000» съедает половину ширины оси и ничего
 * не добавляет к «2.50».
 */
export function fmtAxis(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);

  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  if (abs >= 0.0001) return v.toFixed(6);
  // Микроцены: значащие цифры важнее позиции запятой.
  return v.toPrecision(3);
}

/** Мем-коины стоят 0.0000000123 — обычный toFixed(2) покажет «0.00». */
export function fmtPrice(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  // Компактная запись для микроцен: $0.0₇123
  const exp = Math.floor(Math.log10(n));
  const zeros = Math.abs(exp) - 1;
  const digits = (n * 10 ** (zeros + 3)).toFixed(0);
  const sub = String(zeros).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]!);
  return `$0.0${sub}${digits}`;
}

/**
 * Процент изменения в компактной записи.
 *
 * У мем-коинов рост за сутки бывает четырёхзначным, и «+120913.90%»
 * растягивает колонку так, что таблица уезжает за экран телефона.
 * Сокращаем до «+120.9K%» — читаемость от этого только выигрывает:
 * точность до сотых при росте в тысячу раз всё равно бессмысленна.
 */
export function fmtPct(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';

  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);

  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M%`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K%`;
  return `${sign}${abs.toFixed(2)}%`;
}
