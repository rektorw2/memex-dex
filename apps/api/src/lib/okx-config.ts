/**
 * Разбор учётных данных OKX и безопасный отчёт о них.
 *
 * Задача узкая и одна: ответить на вопрос «дошли ли переменные
 * до этого процесса», не показав при этом ни одного символа значений.
 *
 * Вопрос не праздный. Переменные задаются в панели Render, и добавить
 * их не в тот сервис — обычное дело. Снаружи это неотличимо от
 * спокойного рынка: лента пуста, ошибок нет, всё «работает».
 * Поэтому наружу идут четыре булевых значения — их достаточно,
 * чтобы понять, где искать, и недостаточно, чтобы что-то утекло.
 *
 * Ни маскированных значений, ни первых символов, ни длины: по длине
 * ключа и по паре символов подбор становится заметно проще, а пользы
 * от них при диагностике нет никакой.
 */

import { env } from './env.js';
import { logger } from './logger.js';

export interface OkxConfigurationStatus {
  apiKeyConfigured: boolean;
  apiSecretConfigured: boolean;
  passphraseConfigured: boolean;
  websocketEnabled: boolean;
}

/**
 * Пустая строка — это отсутствие значения, а не значение.
 *
 * В панелях развёртывания переменную часто заводят заранее и
 * оставляют пустой. Без этой проверки код счёл бы ключи заданными
 * и пошёл бы подписывать запрос пустым секретом — получив отказ
 * авторизации, который выглядит как неверный ключ, хотя ключа нет
 * вовсе.
 */
function present(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Расхождение между новым и устаревшим именем переменной.
 *
 * Если заданы оба и они различаются, угадывать нельзя. Взять первое
 * по порядку значит с равной вероятностью подписывать запросы
 * неверным секретом, а отказ авторизации в этом случае объясняется
 * чем угодно, кроме настоящей причины.
 */
export interface CredentialConflict {
  /** Имена переменных без значений. */
  variables: [string, string];
}

export function credentialConflicts(): CredentialConflict[] {
  const conflicts: CredentialConflict[] = [];

  const pairs: Array<[string, string, string | undefined, string | undefined]> = [
    ['OKX_API_SECRET', 'OKX_SECRET_KEY', rawSecretNew(), rawSecretLegacy()],
    ['OKX_PASSPHRASE', 'OKX_API_PASSPHRASE', rawPassNew(), rawPassLegacy()],
  ];

  for (const [a, b, va, vb] of pairs) {
    if (present(va) && present(vb) && va.trim() !== vb.trim()) {
      conflicts.push({ variables: [a, b] });
    }
  }

  return conflicts;
}

// Чтение исходных значений вынесено в функции, чтобы нигде не
// появилось переменной, содержащей секрет дольше одного выражения.
function rawSecretNew() {
  return process.env.OKX_API_SECRET;
}
function rawSecretLegacy() {
  return process.env.OKX_SECRET_KEY;
}
function rawPassNew() {
  return process.env.OKX_PASSPHRASE;
}
function rawPassLegacy() {
  return process.env.OKX_API_PASSPHRASE;
}

let conflictReported = false;

/**
 * Есть ли расхождение имён.
 *
 * Об этом сообщается один раз за жизнь процесса: повторять при каждом
 * запросе значило бы залить журнал одной и той же строкой и утопить
 * в ней всё остальное.
 */
export function hasCredentialConflict(): boolean {
  const conflicts = credentialConflicts();
  if (conflicts.length === 0) return false;

  if (!conflictReported) {
    conflictReported = true;
    logger.error(
      { variables: conflicts.map((c) => c.variables) },
      'OKX: заданы оба написания переменной с разными значениями — ' +
        'оставьте одно, угадывать какое верное мы не станем',
    );
  }

  return true;
}

/**
 * Что дошло до процесса.
 *
 * Только булевы значения. Этого хватает, чтобы отличить «переменные
 * не в том сервисе» от «ключ неверный» — а это две совершенно разные
 * починки.
 */
export function okxConfigurationStatus(): OkxConfigurationStatus {
  return {
    apiKeyConfigured: present(env.OKX_API_KEY),
    apiSecretConfigured: present(env.OKX_API_SECRET),
    passphraseConfigured: present(env.OKX_PASSPHRASE),
    websocketEnabled: Boolean(env.OKX_WS_ENABLED),
  };
}

/** Все три ключа на месте и без расхождений. */
export function okxCredentialsReady(): boolean {
  const c = okxConfigurationStatus();

  return (
    c.apiKeyConfigured &&
    c.apiSecretConfigured &&
    c.passphraseConfigured &&
    !hasCredentialConflict()
  );
}

/** Для тестов: разрешить повторное сообщение о расхождении. */
export function resetConflictReport(): void {
  conflictReported = false;
}
