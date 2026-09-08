import { describe, expect, it } from 'vitest';
import { agentFailureVerdict, type AgentFailureKind } from './agent-failure.js';

describe('четыре причины различаются', () => {
  const cases: Array<[number | null, AgentFailureKind]> = [
    [401, 'SIGN_IN_REQUIRED'],
    [403, 'ACCESS_REQUIRED'],
    [500, 'SERVER_UNAVAILABLE'],
    [503, 'SERVER_UNAVAILABLE'],
    [null, 'NETWORK_UNAVAILABLE'],
  ];

  for (const [status, kind] of cases) {
    it(`${status ?? 'без ответа'} → ${kind}`, () => {
      expect(agentFailureVerdict({ status }).kind).toBe(kind);
    });
  }

  it('все четыре состояния достижимы', () => {
    /*
     * Смысл файла. Пока состояние было одно, разница между
     * «войдите», «нет доступа» и «сервер не отвечает» существовала
     * только в голове разработчика.
     */
    const produced = new Set(cases.map(([status]) => agentFailureVerdict({ status }).kind));

    expect(produced.size).toBe(4);
  });
});

describe('повтор предлагается там, где он помогает', () => {
  it('истёкшая сессия не чинится повтором', () => {
    // Обновление страницы при истёкшей сессии не поможет никогда.
    expect(agentFailureVerdict({ status: 401 }).retryable).toBe(false);
  });

  it('отсутствие доступа не чинится повтором', () => {
    expect(agentFailureVerdict({ status: 403 }).retryable).toBe(false);
  });

  it('отказ сервера и обрыв сети — повторяемы', () => {
    expect(agentFailureVerdict({ status: 503 }).retryable).toBe(true);
    expect(agentFailureVerdict({ status: null }).retryable).toBe(true);
  });
});

describe('неизвестный код не превращается в вину человека', () => {
  it('418 и 0 считаются отказом сервера', () => {
    /*
     * Сказать «войдите» тому, чья сессия в порядке, — значит
     * отправить его совершать бессмысленные действия и решить,
     * что сломался он.
     */
    for (const status of [0, 418, 429, 502, 504, 599]) {
      expect(agentFailureVerdict({ status }).kind, String(status)).toBe('SERVER_UNAVAILABLE');
    }
  });

  it('отсутствие ответа отличается от ответа с ошибкой', () => {
    // Сервер, ответивший 500, жив. Сервер, не ответивший вовсе, —
    // неизвестно; это разные поломки и разные советы.
    expect(agentFailureVerdict({ status: null }).kind).not.toBe(
      agentFailureVerdict({ status: 500 }).kind,
    );
  });
});
