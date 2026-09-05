import { appRelativePath, safeNextPath } from '@memex/core';

/**
 * Адреса внутри приложения — в одном месте.
 *
 * Роутер Next сам добавляет `basePath` к каждому переходу, а
 * `window.location.pathname` этот префикс уже содержит. Сложение двух
 * фактов давало `/memex-dex/memex-dex/agent`: человека, которого
 * попросили войти, возвращало на несуществующую страницу — ровно
 * тогда, когда он сделал всё правильно.
 *
 * Правило одно: в `next` и в роутер попадает путь **без** префикса.
 * Префикс добавляет только роутер и только один раз.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * Текущий адрес в виде пути приложения.
 *
 * Читается из окна целиком — с параметрами и якорем: `/radar/alerts`
 * без `?filter=new` это другой экран, и вернуть туда значит вернуть
 * не туда.
 */
export function currentAppPath(): string | null {
  if (typeof window === 'undefined') return null;

  const full = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return appRelativePath(full, BASE_PATH);
}

/**
 * Значение `next` из строки запроса, приведённое к пути приложения.
 *
 * Снятие префикса нужно и здесь: в закладках и в открытых вкладках
 * уже лежат ссылки, где `next` записан вместе с префиксом. Они
 * должны продолжать работать, а не приводить в никуда.
 */
export function readNextParam(search: string): string | null {
  const raw = new URLSearchParams(search).get('next');
  return appRelativePath(raw, BASE_PATH);
}

/**
 * Проверка значения без снятия префикса.
 *
 * Нужна там, где путь заведомо собран приложением, а не прочитан
 * из окна. Экспортируется, чтобы вызывающим не приходилось тянуть
 * ядро напрямую и решать этот вопрос по месту.
 */
export { safeNextPath };

/** Префикс развёртывания. Только для тестов и диагностики. */
export const DEPLOY_BASE_PATH = BASE_PATH;
