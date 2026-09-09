import { describe, expect, it } from 'vitest';
import {
  AGENT_HEALTH_STALE_AFTER_MS,
  agentHealthVerdict,
  type AgentHealthInput,
  type HeartbeatObservation,
  type InProcessObservation,
} from './agent-health.js';

const NOW = Date.parse('2026-09-09T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const idle: InProcessObservation = {
  running: false,
  refusalReason: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  consecutiveTickFailures: 0,
  lastErrorCode: null,
};

function verdictOf(inProcess: Partial<InProcessObservation>, rest: Partial<AgentHealthInput> = {}) {
  return agentHealthVerdict({
    workersInApi: true,
    now: NOW,
    staleAfterMs: AGENT_HEALTH_STALE_AFTER_MS,
    inProcess: { ...idle, ...inProcess },
    ...rest,
  });
}

function external(heartbeat: HeartbeatObservation | null | undefined, heartbeatError: string | null = null) {
  return agentHealthVerdict({
    workersInApi: false,
    now: NOW,
    staleAfterMs: AGENT_HEALTH_STALE_AFTER_MS,
    inProcess: idle,
    heartbeat,
    heartbeatError,
  });
}

describe('воркер внутри API', () => {
  it('здоров только по недавно завершённому проходу — HTTP 200', () => {
    const v = verdictOf({ running: true, lastTickStartedAt: ago(500), lastTickCompletedAt: ago(400) });
    expect(v).toMatchObject({ state: 'healthy', httpStatus: 200, reason: 'TICK_COMPLETED_RECENTLY', observedVia: 'in-process' });
  });

  it('остановленный воркер — unhealthy и 503, даже если раньше проходил', () => {
    const v = verdictOf({ running: false, lastTickStartedAt: ago(500), lastTickCompletedAt: ago(400) });
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'WORKER_NOT_RUNNING' });
  });

  it('отказ стартовать называет причину', () => {
    const v = verdictOf({ running: false, refusalReason: 'EXECUTION_MODE=live запрещён для paper-agent' });
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'WORKER_REFUSED_TO_START' });
    expect(v.message).toContain('EXECUTION_MODE=live');
  });

  it('просроченный успешный проход — unhealthy, хотя running=true', () => {
    const v = verdictOf({ running: true, lastTickStartedAt: ago(AGENT_HEALTH_STALE_AFTER_MS + 1), lastTickCompletedAt: ago(AGENT_HEALTH_STALE_AFTER_MS) });
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'TICK_STALE' });
  });

  it('граница: проход ровно на пороге уже просрочен, на миллисекунду моложе — нет', () => {
    expect(verdictOf({ running: true, lastTickCompletedAt: ago(AGENT_HEALTH_STALE_AFTER_MS) }).state).toBe('unhealthy');
    expect(verdictOf({ running: true, lastTickCompletedAt: ago(AGENT_HEALTH_STALE_AFTER_MS - 1) }).state).toBe('healthy');
  });

  it('постоянно падающий воркер: проходы начинаются каждую секунду, но здоровым не считается', () => {
    // Начатый проход свежий, завершённый — старый: именно этот случай
    // прежняя проверка по «возрасту последнего прохода» считала живым.
    const v = verdictOf({
      running: true,
      lastTickStartedAt: ago(300),
      lastTickCompletedAt: ago(5 * 60_000),
      consecutiveTickFailures: 290,
      lastErrorCode: 'P1001',
    });
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'TICK_STALE' });
    expect(v.message).toContain('290');
    expect(v.message).toContain('P1001');
  });

  it('падает с самого старта, ни одного успешного прохода — unhealthy, не «стартует»', () => {
    const v = verdictOf({ running: true, lastTickStartedAt: ago(300), lastTickCompletedAt: null, consecutiveTickFailures: 3, lastErrorCode: 'P1001' });
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'NO_COMPLETED_TICK' });
  });

  it('только что стартовал, первый проход идёт — unknown и 503, не успех', () => {
    const v = verdictOf({ running: true, lastTickStartedAt: ago(300), lastTickCompletedAt: null });
    expect(v).toMatchObject({ state: 'unknown', httpStatus: 503, reason: 'STARTING' });
  });

  it('стартовал давно, первый проход так и не завершился — unhealthy', () => {
    const v = verdictOf({ running: true, lastTickStartedAt: ago(AGENT_HEALTH_STALE_AFTER_MS + 1), lastTickCompletedAt: null });
    expect(v).toMatchObject({ state: 'unhealthy', reason: 'NO_COMPLETED_TICK' });
  });

  it('running=true без единого начатого прохода — unhealthy, не unknown', () => {
    expect(verdictOf({ running: true })).toMatchObject({ state: 'unhealthy', reason: 'NO_COMPLETED_TICK' });
  });
});

describe('воркер в отдельном процессе', () => {
  const beat = (over: Partial<HeartbeatObservation> = {}): HeartbeatObservation => ({
    processId: '4242',
    startedAt: ago(3_600_000),
    lastTickStartedAt: ago(1_000),
    lastTickCompletedAt: ago(800),
    lastErrorCode: null,
    consecutiveFailures: 0,
    updatedAt: ago(700),
    ...over,
  });

  it('локальная память не используется: даже «живой» встроенный статус не делает внешний воркер здоровым', () => {
    const v = agentHealthVerdict({
      workersInApi: false,
      now: NOW,
      staleAfterMs: AGENT_HEALTH_STALE_AFTER_MS,
      inProcess: { ...idle, running: true, lastTickStartedAt: ago(100), lastTickCompletedAt: ago(50) },
      heartbeat: null,
    });
    expect(v).toMatchObject({ state: 'unknown', httpStatus: 503, reason: 'HEARTBEAT_MISSING', observedVia: 'none' });
  });

  it('ненаблюдаемый воркер (строки пульса нет) — unknown, 503', () => {
    expect(external(null)).toMatchObject({ state: 'unknown', httpStatus: 503, reason: 'HEARTBEAT_MISSING' });
  });

  it('пульс не читали вовсе — тоже unknown', () => {
    expect(external(undefined)).toMatchObject({ state: 'unknown', httpStatus: 503, reason: 'HEARTBEAT_MISSING' });
  });

  it('пульс не прочитан (нет таблицы, база недоступна) — unknown с кодом ошибки', () => {
    const v = external(null, 'P2021');
    expect(v).toMatchObject({ state: 'unknown', httpStatus: 503, reason: 'HEARTBEAT_UNREADABLE' });
    expect(v.message).toContain('P2021');
  });

  it('свежий пульс с завершённым проходом — healthy, 200', () => {
    expect(external(beat())).toMatchObject({ state: 'healthy', httpStatus: 200, reason: 'TICK_COMPLETED_RECENTLY', observedVia: 'heartbeat' });
  });

  it('пульс от умершего процесса — просрочен, unhealthy', () => {
    const v = external(beat({ lastTickCompletedAt: ago(10 * 60_000), updatedAt: ago(10 * 60_000) }));
    expect(v).toMatchObject({ state: 'unhealthy', httpStatus: 503, reason: 'HEARTBEAT_STALE' });
  });

  it('пульс свежий, но процесс падает на каждом проходе — unhealthy', () => {
    const v = external(beat({ lastTickCompletedAt: ago(5 * 60_000), updatedAt: ago(500), consecutiveFailures: 300, lastErrorCode: 'P1001' }));
    expect(v).toMatchObject({ state: 'unhealthy', reason: 'HEARTBEAT_STALE' });
    expect(v.message).toContain('4242');
  });

  it('процесс только стартовал, проход не завершён — unknown; с ошибками — unhealthy', () => {
    expect(external(beat({ lastTickCompletedAt: null, updatedAt: ago(500) }))).toMatchObject({ state: 'unknown', reason: 'STARTING' });
    expect(external(beat({ lastTickCompletedAt: null, updatedAt: ago(500), consecutiveFailures: 2 }))).toMatchObject({ state: 'unhealthy', reason: 'HEARTBEAT_NO_COMPLETED_TICK' });
  });

  it('HTTP 200 только за healthy', () => {
    const states = [
      external(beat()),
      external(null),
      external(null, 'X'),
      external(beat({ lastTickCompletedAt: ago(10 * 60_000) })),
      verdictOf({ running: false }),
      verdictOf({ running: true, lastTickStartedAt: ago(1) }),
    ];
    for (const v of states) expect(v.httpStatus === 200).toBe(v.state === 'healthy');
  });
});
