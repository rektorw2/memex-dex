/**
 * Области доступа программного ключа.
 *
 * Живут в ядре, а не рядом с обработчиками HTTP, по одной причине:
 * список того, что ключ умеет и не умеет, — это правило предметной
 * области, а не деталь транспорта. Здесь оно закрыто тестами.
 *
 * Главное правило проверяется тестом отдельно: среди областей нет и
 * не может появиться права на вывод средств. Ключ хранится в файле на
 * машине, которую мы не контролируем, его нельзя закрыть вторым
 * фактором и нельзя спросить у владельца подтверждение. Единственная
 * надёжная защита денег — отсутствие самой возможности их отправить.
 *
 * Тест на это существует не ради покрытия. Он ловит будущее изменение,
 * которое покажется безобидным: кто-то добавит «wallet:manage» ради
 * удобства скрипта, и вместе с управлением кошельком туда приедет
 * вывод. Проверка обязана сломаться в этот момент, а не после инцидента.
 */

export const ALL_SCOPES = ['radar:ingest', 'trade:read', 'trade:write'] as const;

export type ApiScope = (typeof ALL_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'radar:ingest': 'Добавлять токены в радар',
  'trade:read': 'Читать позиции, ордера и баланс',
  'trade:write': 'Ставить и отменять ордера',
};

/**
 * Слова, наличие которых в названии области означает ошибку.
 *
 * Список намеренно широкий и включает синонимы: запрет должен
 * срабатывать на «payout» и «transfer» так же, как на «withdraw».
 */
export const FORBIDDEN_SCOPE_WORDS = [
  'withdraw',
  'payout',
  'transfer',
  'send',
  'wallet:manage',
  'admin',
] as const;

export function isApiScope(value: string): value is ApiScope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export interface ScopeCheck {
  allowed: boolean;
  /** Причина отказа для показа владельцу ключа. */
  reason: string;
}

/**
 * Проверка права на действие.
 *
 * Отказ объясняет, какой именно области не хватает: без этого владелец
 * ключа перебирает настройки вслепую, а чаще просто выдаёт ключу все
 * области подряд — что хуже, чем понятное сообщение.
 */
export function checkScope(granted: readonly string[], required: ApiScope): ScopeCheck {
  if (!Array.isArray(granted) || granted.length === 0) {
    return { allowed: false, reason: 'У ключа нет ни одной области доступа' };
  }

  // Неизвестные области игнорируются, а не расширяют права: строка
  // из базы могла остаться от прежней версии схемы.
  const known = granted.filter(isApiScope);

  if (known.includes(required)) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason: `Ключу не хватает области доступа «${SCOPE_LABELS[required]}» (${required})`,
  };
}
