/**
 * Кеш с отдачей устаревшего и фоновым обновлением.
 *
 * Обычный TTL-кеш решает только половину задачи. Вторая половина — что
 * делать в момент истечения срока. Наивный ответ «сходить к источнику
 * и подождать» означает, что раз в тридцать секунд один невезучий
 * запрос платит за всех полной задержкой, а если источник в этот момент
 * недоступен — терминал пустеет, хотя данные тридцатисекундной давности
 * были и остаются вполне пригодными.
 *
 * Поэтому здесь три вещи вместо одной:
 *
 *   свежее      — отдаём сразу;
 *   протухшее   — отдаём сразу и обновляем в фоне;
 *   отсутствует — идём к источнику и ждём.
 *
 * Разница между «протухло» и «отсутствует» принципиальна. Протухшая
 * цена — это факт с оговоркой о возрасте. Отсутствующая цена — это
 * незнание, и выдавать его за факт нельзя. Поэтому у записи есть
 * возраст, и вызывающая сторона может его увидеть.
 *
 * Отдельно решается одновременность. Без неё двадцать запросов
 * к пустому ключу порождают двадцать походов к источнику — ровно тогда,
 * когда источник меньше всего к этому готов.
 */

import { logger } from './logger.js';

interface Entry<T> {
  value: T;
  /** Когда значение получено. */
  at: number;
  /** До какого момента считается свежим. */
  freshUntil: number;
  /** После какого момента непригодно даже как устаревшее. */
  hardUntil: number;
}

export interface CacheOptions {
  /** Сколько значение считается свежим. */
  ttlMs: number;
  /**
   * Сколько устаревшее значение ещё можно отдать, пока идёт обновление.
   * По умолчанию — вдесятеро дольше ttl: цена часовой давности бесполезна,
   * а список подтверждённых RWA — вполне.
   */
  staleMs?: number;
}

export interface CacheHit<T> {
  value: T;
  /** Возраст в миллисекундах. Ноль означает только что полученное. */
  ageMs: number;
  /** Значение отдано из кеша, срок которого истёк. */
  isStale: boolean;
}

const store = new Map<string, Entry<unknown>>();
/** Идущие обращения к источнику: ключ → общее обещание. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Получить значение, сходив к источнику только при необходимости.
 *
 * Ошибка загрузчика при наличии устаревшего значения не выбрасывается:
 * старые данные лучше пустого экрана, и об этом мы честно сообщаем
 * через isStale. Ошибка при отсутствии значения выбрасывается —
 * притвориться, что данных нет по причине их отсутствия, нельзя.
 */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  opts: CacheOptions,
): Promise<CacheHit<T>> {
  const now = Date.now();
  const staleMs = opts.staleMs ?? opts.ttlMs * 10;
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry && now < entry.freshUntil) {
    return { value: entry.value, ageMs: now - entry.at, isStale: false };
  }

  // Протухло, но ещё пригодно: отдаём немедленно, обновляем в фоне.
  if (entry && now < entry.hardUntil) {
    void refresh(key, loader, opts).catch(() => undefined);
    return { value: entry.value, ageMs: now - entry.at, isStale: true };
  }

  const value = await refresh(key, loader, opts);
  return { value, ageMs: 0, isStale: false };
}

/**
 * Сходить к источнику, объединяя одновременные обращения.
 *
 * Второй вызывающий с тем же ключом получает то же обещание, а не
 * собственный запрос. Иначе первое обращение к холодному кешу
 * умножается на число одновременных пользователей.
 */
function refresh<T>(key: string, loader: () => Promise<T>, opts: CacheOptions): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const staleMs = opts.staleMs ?? opts.ttlMs * 10;

  const p = loader()
    .then((value) => {
      const at = Date.now();
      store.set(key, {
        value,
        at,
        freshUntil: at + opts.ttlMs,
        hardUntil: at + opts.ttlMs + staleMs,
      });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p as Promise<unknown>);
  return p;
}

/** Заглянуть в кеш, не обращаясь к источнику. */
export function peek<T>(key: string): CacheHit<T> | null {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return null;
  const now = Date.now();
  if (now >= entry.hardUntil) return null;
  return { value: entry.value, ageMs: now - entry.at, isStale: now >= entry.freshUntil };
}

export function invalidate(prefix: string): number {
  let n = 0;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k);
      n++;
    }
  }
  return n;
}

export function cacheSize(): number {
  return store.size;
}

/** Только для тестов: полная очистка. */
export function resetCache(): void {
  store.clear();
  inflight.clear();
}

// ──────────────────────── Повторы и ограничение потока ──────────────────────

export interface RetryOptions {
  attempts?: number;
  /** Задержка перед первым повтором; дальше удваивается. */
  baseDelayMs?: number;
  label?: string;
}

/**
 * Повтор с растущей задержкой.
 *
 * Повторяем не всё подряд. Ошибка сети и 429 — временные, их стоит
 * пережить. Ответ 400 или 401 повторять бессмысленно: неверный запрос
 * не станет верным со второй попытки, а лишний вызов расходует лимит,
 * который понадобится настоящему запросу.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (e?.permanent === true) throw e;
      if (i === attempts - 1) break;

      // Небольшой случайный разброс: без него все ждущие клиенты
      // просыпаются одновременно и повторяют залп, от которого
      // источник только что отказался.
      const delay = base * 2 ** i + Math.random() * base;
      logger.debug({ label: opts.label, attempt: i + 1, delay }, 'повтор запроса');
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

/**
 * Ограничитель одновременных запросов.
 *
 * Нужен там, где обработка идёт списком: сто токенов, у каждого свой
 * запрос. Без ограничения это сто одновременных соединений, и любой
 * поставщик ответит на такое отказом.
 */
export class Concurrency {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Пропустить весь список через ограничитель, сохранив порядок. */
  async map<I, O>(items: I[], fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
    return Promise.all(items.map((item, i) => this.run(() => fn(item, i))));
  }
}

// ───────────────────────────── Частота обращений ────────────────────────────

/**
 * Token bucket: не больше N обращений за период.
 *
 * Отличается от Concurrency тем, что ограничивает не одновременность,
 * а частоту. Поставщик, разрешающий один запрос в секунду, не станет
 * добрее оттого, что мы шлём их по одному — важно, сколько их за минуту.
 */
export class RateLimit {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
  ) {
    this.tokens = capacity;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now - this.last >= this.perMs) {
        this.tokens = this.capacity;
        this.last = now;
      }
      if (this.tokens > 0) {
        this.tokens--;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(50, this.perMs - (Date.now() - this.last))));
    }
  }
}
