/**
 * Доступен ли источник сигналов — и что делать агенту, если нет.
 *
 * Источник ровно один: официальный OKX Signal API. У него два
 * транспорта — WebSocket-канал и REST-опрос того же API. Оба
 * документированы и оба считаются источником; ничего третьего
 * (публичные ленты, моки, другие провайдеры) агент не принимает.
 *
 * Правило простое: пока хотя бы один транспорт подтверждённо живой,
 * входы разрешены. Когда живого нет — новые входы останавливаются с
 * названной причиной, а открытые позиции продолжают вестись: цена
 * для них берётся не из сигналов, и бросать их из-за отказа
 * источника значит превратить сбой поставщика в убыток.
 */

export type SignalTransport = 'WEBSOCKET' | 'REST_ONLY' | 'DISABLED';

export interface SignalSourceFacts {
  /** Ключи OKX заданы. Без них ни один транспорт не работает. */
  configured: boolean;
  transportMode: SignalTransport;
  /** Сокет подключён и не молчит дольше допустимого. */
  socketHealthy: boolean;
  /** Числовой код отказа канала, если провайдер его назвал (например 60029). */
  channelDeniedCode: string | null;
  lastRestSuccessAtMs: number | null;
  lastRestErrorCode: string | null;
  restIntervalMs: number;
  /** Когда воркер источника запустился: до первого опроса REST молчание — не отказ. */
  startedAtMs: number | null;
  nowMs: number;
}

export type SignalSourceCode =
  | 'OK'
  | 'OK_REST_ONLY'
  | 'OKX_NOT_CONFIGURED'
  | 'SOURCE_STOPPED'
  | 'REST_AUTH_REJECTED'
  | 'REST_QUOTA_EXHAUSTED'
  | 'REST_STALE'
  | 'REST_PENDING';

export interface SignalSourceVerdict {
  available: boolean;
  code: SignalSourceCode;
  /** Причина словами для интерфейса. */
  message: string;
  transport: SignalTransport;
}

/** Сколько пропущенных интервалов REST считаются потерей источника. */
export const REST_STALE_INTERVALS = 3;

export function signalSourceVerdict(facts: SignalSourceFacts): SignalSourceVerdict {
  if (!facts.configured) {
    return { available: false, code: 'OKX_NOT_CONFIGURED', transport: 'DISABLED', message: 'Ключи OKX Signal API не заданы' };
  }
  if (facts.transportMode === 'WEBSOCKET' && facts.socketHealthy) {
    return { available: true, code: 'OK', transport: 'WEBSOCKET', message: 'OKX Signal API по WebSocket' };
  }
  if (facts.startedAtMs == null) {
    return { available: false, code: 'SOURCE_STOPPED', transport: facts.transportMode, message: 'Приём сигналов не запущен' };
  }

  const staleAfter = facts.restIntervalMs * REST_STALE_INTERVALS;
  /*
   * Два отказа провайдера окончательны сразу, без ожидания трёх
   * интервалов: отклонённый ключ и исчерпанная квота не пройдут и
   * через минуту. Прочие («network:…», «rate-limit», «budget») —
   * временные, и источник считается живым, пока последний
   * подтверждённый успех не устарел. `budget` — отказ нашего учёта,
   * сеть не трогали: он не доказывает ни жизнь, ни смерть источника.
   */
  if (facts.lastRestErrorCode === 'auth') {
    return { available: false, code: 'REST_AUTH_REJECTED', transport: 'REST_ONLY', message: 'OKX отклонил ключ: проверьте OKX_API_KEY, OKX_API_SECRET и OKX_PASSPHRASE; входы приостановлены, открытые позиции ведутся' };
  }
  if (facts.lastRestErrorCode === 'quota') {
    return { available: false, code: 'REST_QUOTA_EXHAUSTED', transport: 'REST_ONLY', message: 'Квота OKX API исчерпана (402): входы приостановлены до обновления квоты, открытые позиции ведутся' };
  }
  if (facts.lastRestSuccessAtMs != null && facts.nowMs - facts.lastRestSuccessAtMs <= staleAfter) {
    const why = facts.channelDeniedCode === '60036' ? ' (ключу недоступен WebSocket по Market API subscription, код 60036)' : facts.channelDeniedCode ? ` (WebSocket-канал требует whitelist, код ${facts.channelDeniedCode})` : facts.transportMode === 'DISABLED' ? ' (WebSocket выключен)' : ' (WebSocket недоступен)';
    return { available: true, code: 'OK_REST_ONLY', transport: 'REST_ONLY', message: `OKX Signal API по REST${why}` };
  }
  if (facts.lastRestSuccessAtMs == null && facts.nowMs - facts.startedAtMs <= staleAfter) {
    return { available: true, code: 'REST_PENDING', transport: 'REST_ONLY', message: 'Ждём первый ответ OKX Signal API' };
  }
  const why = facts.lastRestErrorCode === 'budget'
    ? 'запросы к OKX удерживает лимит бюджета'
    : facts.lastRestErrorCode?.startsWith('rate-limit')
      ? 'OKX ограничил частоту запросов (429)'
      : facts.lastRestErrorCode
        ? `OKX Signal API не отвечает (${facts.lastRestErrorCode})`
        : 'OKX Signal API давно не отвечал';
  return {
    available: false,
    code: 'REST_STALE',
    transport: 'REST_ONLY',
    message: `${why}; входы приостановлены, открытые позиции ведутся`,
  };
}
