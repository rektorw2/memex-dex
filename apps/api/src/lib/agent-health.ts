/**
 * Состояние агента для `/health/agent` — одно из трёх, и каждое
 * означает ровно то, что написано.
 *
 *   healthy   — проход агента недавно *завершился успешно*. Не
 *               «воркер помечен запущенным», не «проход начался»:
 *               воркер, который каждую секунду начинает проход и
 *               каждую секунду падает, здоровым не считается.
 *   unhealthy — есть наблюдение, и оно плохое: воркер остановлен,
 *               отказался стартовать, последний успешный проход
 *               просрочен или его не было вовсе.
 *   unknown   — наблюдения нет. Воркер в другом процессе, а его
 *               пульс не найден или не прочитан; либо воркер только
 *               что стартовал и первый проход ещё не завершился.
 *
 * HTTP-код следует из состояния: 200 только за `healthy`. `unknown`
 * отвечает 503 так же, как `unhealthy`: отсутствие наблюдения —
 * не успех, и внешняя проверка доступности не должна принимать его
 * за «агент работает». Различие видно в теле (`state`, `reason`).
 *
 * Состояние источника сигналов сюда не входит. Недоступный OKX
 * останавливает новые входы, но процесс агента при этом жив и
 * сопровождает открытые позиции; это отдельное поле ответа, а не
 * причина `unhealthy`.
 */

export type AgentHealthState = 'healthy' | 'unhealthy' | 'unknown';

export type AgentHealthReason =
  | 'TICK_COMPLETED_RECENTLY'
  | 'WORKER_NOT_RUNNING'
  | 'WORKER_REFUSED_TO_START'
  | 'NO_COMPLETED_TICK'
  | 'TICK_STALE'
  | 'STARTING'
  | 'HEARTBEAT_MISSING'
  | 'HEARTBEAT_UNREADABLE'
  | 'HEARTBEAT_STALE'
  | 'HEARTBEAT_NO_COMPLETED_TICK';

export interface AgentHealthVerdict {
  state: AgentHealthState;
  httpStatus: 200 | 503;
  reason: AgentHealthReason;
  message: string;
  /** Откуда взято наблюдение. */
  observedVia: 'in-process' | 'heartbeat' | 'none';
}

/** Что известно о воркере в этом же процессе. */
export interface InProcessObservation {
  running: boolean;
  refusalReason: string | null;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  consecutiveTickFailures: number;
  lastErrorCode: string | null;
}

/** Строка пульса воркера из другого процесса. */
export interface HeartbeatObservation {
  processId: string;
  startedAt: string;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface AgentHealthInput {
  /** Воркеры живут внутри API (`RUN_WORKERS_IN_API`). */
  workersInApi: boolean;
  now: number;
  /** Старше этого успешный проход считается просроченным. */
  staleAfterMs: number;
  inProcess: InProcessObservation;
  /** `undefined` — пульс не читали; `null` — читали, строки нет. */
  heartbeat?: HeartbeatObservation | null;
  /** Код ошибки чтения пульса (таблицы нет, база недоступна). */
  heartbeatError?: string | null;
}

/** Проход раз в секунду; минута без успешного завершения — воркер стоит или падает. */
export const AGENT_HEALTH_STALE_AFTER_MS = 60_000;

const ageOf = (iso: string | null, now: number): number | null =>
  iso ? Math.max(0, now - new Date(iso).getTime()) : null;

const seconds = (ms: number) => `${Math.round(ms / 1000)} с`;

export function agentHealthVerdict(input: AgentHealthInput): AgentHealthVerdict {
  const verdict = (
    state: AgentHealthState,
    reason: AgentHealthReason,
    message: string,
    observedVia: AgentHealthVerdict['observedVia'],
  ): AgentHealthVerdict => ({ state, httpStatus: state === 'healthy' ? 200 : 503, reason, message, observedVia });

  if (input.workersInApi) {
    const w = input.inProcess;
    if (!w.running) {
      return w.refusalReason
        ? verdict('unhealthy', 'WORKER_REFUSED_TO_START', `Воркер агента отказался стартовать: ${w.refusalReason}`, 'in-process')
        : verdict('unhealthy', 'WORKER_NOT_RUNNING', 'Воркер агента в этом процессе не запущен', 'in-process');
    }
    const completedAge = ageOf(w.lastTickCompletedAt, input.now);
    const startedAge = ageOf(w.lastTickStartedAt, input.now);
    if (completedAge == null) {
      // Проходы начинаются, но ни один не завершился. Пока это
      // укладывается в срок — старт; дольше — воркер падает на каждом.
      if (startedAge != null && startedAge < input.staleAfterMs && w.consecutiveTickFailures === 0) {
        return verdict('unknown', 'STARTING', 'Воркер стартовал, первый проход ещё не завершился', 'in-process');
      }
      return verdict('unhealthy', 'NO_COMPLETED_TICK',
        `Ни один проход не завершился успешно${w.consecutiveTickFailures > 0 ? `: ${w.consecutiveTickFailures} подряд с ошибкой${w.lastErrorCode ? ` (${w.lastErrorCode})` : ''}` : ''}`,
        'in-process');
    }
    if (completedAge >= input.staleAfterMs) {
      return verdict('unhealthy', 'TICK_STALE',
        `Последний успешный проход ${seconds(completedAge)} назад${w.consecutiveTickFailures > 0 ? `; с тех пор ${w.consecutiveTickFailures} проходов подряд с ошибкой${w.lastErrorCode ? ` (${w.lastErrorCode})` : ''}` : ''}`,
        'in-process');
    }
    return verdict('healthy', 'TICK_COMPLETED_RECENTLY', `Проход завершился ${seconds(completedAge)} назад`, 'in-process');
  }

  // Воркер в другом процессе: память его недоступна, единственное наблюдение — пульс.
  if (input.heartbeatError) {
    return verdict('unknown', 'HEARTBEAT_UNREADABLE', `Пульс воркера не прочитан: ${input.heartbeatError}`, 'none');
  }
  const hb = input.heartbeat;
  if (!hb) {
    return verdict('unknown', 'HEARTBEAT_MISSING', 'Воркер в отдельном процессе, пульса в базе нет: состояние неизвестно', 'none');
  }
  const completedAge = ageOf(hb.lastTickCompletedAt, input.now);
  const updatedAge = ageOf(hb.updatedAt, input.now) ?? Number.POSITIVE_INFINITY;
  if (completedAge == null) {
    if (updatedAge < input.staleAfterMs && hb.consecutiveFailures === 0) {
      return verdict('unknown', 'STARTING', `Процесс ${hb.processId} стартовал, первый проход ещё не завершился`, 'heartbeat');
    }
    return verdict('unhealthy', 'HEARTBEAT_NO_COMPLETED_TICK',
      `Процесс ${hb.processId}: ни один проход не завершился успешно${hb.consecutiveFailures > 0 ? ` (${hb.consecutiveFailures} подряд с ошибкой${hb.lastErrorCode ? `, ${hb.lastErrorCode}` : ''})` : ''}`,
      'heartbeat');
  }
  if (completedAge >= input.staleAfterMs) {
    return verdict('unhealthy', 'HEARTBEAT_STALE',
      `Процесс ${hb.processId}: последний успешный проход ${seconds(completedAge)} назад, пульс обновлён ${seconds(updatedAge)} назад`,
      'heartbeat');
  }
  return verdict('healthy', 'TICK_COMPLETED_RECENTLY', `Процесс ${hb.processId}: проход завершился ${seconds(completedAge)} назад`, 'heartbeat');
}
