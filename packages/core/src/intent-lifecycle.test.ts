import { describe, it, expect } from 'vitest';
import {
  checkApprovalPreconditions,
  forbiddenAuditKeys,
  forbiddenClientFields,
  isAllowedOrigin,
  isExpirable,
  presentationIsComplete,
  ALLOWED_INTENT_ORIGINS,
  APPROVAL_WARNING,
  AUDIT_ACTIONS,
  CLIENT_FORBIDDEN_FIELDS,
  type ProposalPresentation,
  type ProposalState,
} from './intent-lifecycle.js';

/**
 * Жизненный цикл предложения.
 *
 * Главное здесь — что человек вправе прислать. Денежное намерение
 * не рождается из данных браузера; от человека приходит согласие,
 * а не транзакция.
 */

// ═══════════════════ Что клиент присылать не вправе ══════════════════════════

describe('данные от клиента', () => {
  it('денежные поля отвергаются поимённо', () => {
    for (const field of ['rawAmount', 'destinationAddress', 'mint', 'feeLimitLamports']) {
      expect(forbiddenClientFields({ [field]: 'что угодно' }), field).toContain(field);
    }
  });

  it('готовая транзакция и инструкции отвергаются', () => {
    const found = forbiddenClientFields({
      transaction: 'base64…',
      serializedTransaction: 'base64…',
      instructions: [],
      programIds: ['x'],
      message: 'bytes',
      messageHash: 'abc',
    });
    // Проверить чужую готовую структуру сложнее, чем построить свою.
    expect(found.length).toBeGreaterThanOrEqual(6);
  });

  it('подмена владельца и кошелька отвергается', () => {
    expect(forbiddenClientFields({ userId: 'чужой', walletId: 'w', sourceAddress: 'a' }))
      .toEqual(expect.arrayContaining(['userId', 'walletId', 'sourceAddress']));
  });

  it('подмена версии ключа и политики отвергается', () => {
    expect(forbiddenClientFields({ keyId: 'k', keyVersion: '9', policyVersion: 'x' }))
      .toEqual(expect.arrayContaining(['keyId', 'keyVersion', 'policyVersion']));
  });

  it('подмена blockhash отвергается', () => {
    expect(forbiddenClientFields({ recentBlockhash: 'h', lastValidBlockHeight: '1' }))
      .toEqual(expect.arrayContaining(['recentBlockhash', 'lastValidBlockHeight']));
  });

  it('разрешённое тело проходит', () => {
    expect(forbiddenClientFields({ decision: 'CONFIRM', shownFingerprint: 'abc' })).toEqual([]);
  });

  it('список запрещённого покрывает всё денежное', () => {
    for (const critical of ['rawAmount', 'destinationAddress', 'messageHash', 'network', 'state']) {
      expect(CLIENT_FORBIDDEN_FIELDS, critical).toContain(critical);
    }
  });
});

// ═══════════════════════ Источник намерения ══════════════════════════════════

describe('источник намерения', () => {
  it('разрешены только предложение агента и служебная фикстура', () => {
    expect([...ALLOWED_INTENT_ORIGINS]).toEqual(['AGENT_PROPOSAL', 'ADMIN_DEVNET_FIXTURE']);
  });

  it('вывод средств пока не подключён', () => {
    expect(isAllowedOrigin('WITHDRAWAL_REQUEST')).toBe(false);
  });

  it('клиент источником не является', () => {
    for (const bad of ['CLIENT', 'BROWSER', 'USER', 'API', '']) {
      expect(isAllowedOrigin(bad), bad).toBe(false);
    }
  });
});

// ═══════════════════════ Предусловия подтверждения ═══════════════════════════

describe('предусловия подтверждения', () => {
  const base = () => ({
    state: 'CREATED' as ProposalState,
    ownerId: 'user-1',
    actorId: 'user-1',
    expiresAt: 2_000,
    now: 1_000,
    shownFingerprint: 'fp-a',
    currentFingerprint: 'fp-a',
    shownPolicyVersion: 'v1',
    currentPolicyVersion: 'v1',
    hasEntitlement: true,
    safetyLatchHealthy: true,
    liveAllowed: true,
  });

  it('всё в порядке — подтверждение принимается', () => {
    expect(checkApprovalPreconditions(base()).allowed).toBe(true);
  });

  it('чужое предложение отвечает как несуществующее', () => {
    // Разные коды на «не ваше» и «нет такого» позволяют по одному
    // запросу узнать, есть ли у соседа предложение.
    expect(checkApprovalPreconditions({ ...base(), actorId: 'user-2' }).refusal).toBe('NOT_FOUND');
  });

  it('владелец проверяется раньше состояния', () => {
    const verdict = checkApprovalPreconditions({
      ...base(), actorId: 'user-2', state: 'CONFIRMED',
    });
    // Чужому не сообщается даже то, что решение уже принято.
    expect(verdict.refusal).toBe('NOT_FOUND');
  });

  it('истёкшее предложение не подтверждается', () => {
    expect(checkApprovalPreconditions({ ...base(), now: 2_000 }).refusal).toBe('PROPOSAL_EXPIRED');
    expect(checkApprovalPreconditions({ ...base(), state: 'EXPIRED' }).refusal)
      .toBe('PROPOSAL_EXPIRED');
  });

  it('уже решённое не решается второй раз', () => {
    for (const state of ['CONFIRMED', 'REJECTED'] as ProposalState[]) {
      expect(checkApprovalPreconditions({ ...base(), state }).refusal, state)
        .toBe('ALREADY_DECIDED');
    }
  });

  it('изменённое предложение недействительно', () => {
    // Человек соглашался на то, что видел.
    expect(checkApprovalPreconditions({ ...base(), currentFingerprint: 'fp-b' }).refusal)
      .toBe('PROPOSAL_CHANGED');
  });

  it('изменённая версия политики недействительна', () => {
    expect(checkApprovalPreconditions({ ...base(), currentPolicyVersion: 'v2' }).refusal)
      .toBe('POLICY_VERSION_CHANGED');
  });

  it('снятое право действует немедленно', () => {
    expect(checkApprovalPreconditions({ ...base(), hasEntitlement: false }).refusal)
      .toBe('ENTITLEMENT_MISSING');
  });

  it('поднятая защёлка останавливает подтверждение', () => {
    expect(checkApprovalPreconditions({ ...base(), safetyLatchHealthy: false }).refusal)
      .toBe('SAFETY_LATCH_RAISED');
  });

  it('заблокированный LIVE останавливает подтверждение', () => {
    expect(checkApprovalPreconditions({ ...base(), liveAllowed: false }).refusal)
      .toBe('LIVE_BLOCKED');
  });
});

// ═══════════════════════ Что показывают человеку ═════════════════════════════

describe('показ предложения', () => {
  const full = (): ProposalPresentation => ({
    asset: 'BONK',
    network: 'devnet',
    direction: 'BUY',
    amountUsd: '25.00',
    estimatedFeeUsd: '0.02',
    maxFeeUsd: '0.10',
    slippageBps: 50,
    riskLevel: 'MEDIUM',
    strategy: 'baseline',
    reason: 'сигнал smart money',
    expiresAt: 2_000,
  });

  it('полного набора достаточно', () => {
    expect(presentationIsComplete(full())).toBe(true);
  });

  it('неизвестная оценка комиссии допустима', () => {
    // Неизвестная оценка честнее выдуманной.
    expect(presentationIsComplete({ ...full(), estimatedFeeUsd: null })).toBe(true);
  });

  it('без суммы, риска или причины согласия не просят', () => {
    for (const field of ['amountUsd', 'riskLevel', 'reason', 'maxFeeUsd', 'strategy'] as const) {
      expect(presentationIsComplete({ ...full(), [field]: '' }), field).toBe(false);
    }
  });

  it('предупреждение говорит, что отправки не будет', () => {
    expect(APPROVAL_WARNING).toContain('не отправляет транзакцию');
  });
});

// ═══════════════════════════════ Журнал ══════════════════════════════════════

describe('журнал', () => {
  it('каждый переход имеет своё событие', () => {
    for (const required of [
      'PROPOSAL_CREATED', 'PROPOSAL_CONFIRMED', 'PROPOSAL_REJECTED', 'PROPOSAL_EXPIRED',
      'INTENT_CREATED', 'INTENT_APPROVED', 'INTENT_SIGNING_CLAIMED',
      'INTENT_KMS_REQUESTED', 'INTENT_KMS_AMBIGUOUS',
      'INTENT_SIGNATURE_VERIFIED', 'INTENT_SIGNATURE_REJECTED',
    ]) {
      expect(AUDIT_ACTIONS, required).toContain(required);
    }
  });

  it('в каталоге нет событий отправки', () => {
    // Подпись и отправка — разные события, и второго пока нет.
    for (const action of AUDIT_ACTIONS) {
      expect(action, action).not.toMatch(/SUBMIT|BROADCAST|CONFIRMED_ON_CHAIN|FINALIZED/);
    }
  });

  it('секреты в записи запрещены поимённо', () => {
    const leaked = forbiddenAuditKeys({
      credentials: 'x', authorization: 'Bearer y', rpcUrl: 'https://…',
      privateKey: 'z', message: 'bytes', signature: 'sig',
    });
    expect(leaked.length).toBe(6);
  });

  it('обычная запись ничего не нарушает', () => {
    expect(forbiddenAuditKeys({
      userId: 'u', intentId: 'i', network: 'devnet', toState: 'APPROVED', reasonCode: null,
    })).toEqual([]);
  });

  it('заголовки в журнале запрещены', () => {
    // `headers`, добавленный однажды для отладки, переживёт отладку.
    expect(forbiddenAuditKeys({ headers: {} })).toContain('headers');
  });
});

// ═════════════════════════════ Истечение ═════════════════════════════════════

describe('истечение', () => {
  it('незакрытая запись со сроком в прошлом истекает', () => {
    for (const state of ['CREATED', 'AWAITING_CONFIRMATION', 'DRAFT', 'VALIDATED', 'APPROVED']) {
      expect(isExpirable(state, 1_000, 2_000), state).toBe(true);
    }
  });

  it('подписанное не истекает', () => {
    // Истечение закрывает забытое, а не отменяет случившееся.
    expect(isExpirable('SIGNED', 1_000, 2_000)).toBe(false);
  });

  it('захваченное на подпись не истекает по таймеру', () => {
    expect(isExpirable('SIGNING', 1_000, 2_000)).toBe(false);
  });

  it('уже закрытое повторно не истекает', () => {
    for (const state of ['EXPIRED', 'REJECTED', 'FAILED', 'CONFIRMED']) {
      expect(isExpirable(state, 1_000, 2_000), state).toBe(false);
    }
  });

  it('живая запись не истекает раньше срока', () => {
    expect(isExpirable('APPROVED', 3_000, 2_000)).toBe(false);
  });
});
