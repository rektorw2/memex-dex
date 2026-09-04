import { describe, it, expect } from 'vitest';
import {
  canTransitionIntent,
  changedMoneyFields,
  checkSigningPreconditions,
  compareNumeric,
  intentStage,
  isAllowedPurpose,
  isTerminalIntentState,
  programAllowed,
  ALLOWED_INTENT_PURPOSES,
  MONEY_FIELDS,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type IntentMoneyFacts,
  type TransactionIntentState,
} from './transaction-intent.js';
import { signerBlockers, canSign, kmsCapability, KMS_COMPATIBILITY } from './kms-compatibility.js';

/**
 * Намерение и его состояния.
 *
 * Главное, что проверяется: подпись не превращается в отправку, а
 * одобренные деньги не меняются задним числом.
 */

const facts = (over: Partial<IntentMoneyFacts> = {}): IntentMoneyFacts => ({
  network: 'devnet',
  purpose: 'DEVNET_SELF_TRANSFER',
  mint: null,
  rawAmount: '1000000',
  sourceAddress: 'Addr111',
  destinationAddress: 'Addr111',
  feeLimitLamports: '5000',
  slippageBps: 50,
  allowedProgramIds: [SYSTEM_PROGRAM_ID],
  messageHash: 'hash-a',
  policyVersion: 'phase4d-1',
  ...over,
});

// ═══════════════════════ Подпись — не отправка ═══════════════════════════════

describe('подпись не является отправкой', () => {
  it('SIGNED — конечное состояние', () => {
    // Отсутствие перехода надёжнее проверки перед отправкой:
    // проверку можно обойти, несуществующее состояние — нет.
    expect(isTerminalIntentState('SIGNED')).toBe(true);
  });

  it('из SIGNED нет перехода ни во что', () => {
    const states: TransactionIntentState[] = [
      'DRAFT', 'VALIDATED', 'APPROVED', 'SIGNING', 'SIGNED', 'EXPIRED', 'REJECTED', 'FAILED',
    ];
    for (const to of states) {
      expect(canTransitionIntent('SIGNED', to), to).toBe(false);
    }
  });

  it('состояния отправки в машине отсутствуют', () => {
    const stages = ['PREPARING', 'AWAITING_APPROVAL', 'SIGNING', 'SIGNED', 'CLOSED'];
    for (const state of ['SUBMITTED', 'CONFIRMED', 'FINALIZED', 'BROADCAST']) {
      // Незнакомое состояние закрывается, а не считается успехом.
      expect(intentStage(state as TransactionIntentState), state).toBe('CLOSED');
      expect(stages).toContain(intentStage(state as TransactionIntentState));
    }
  });

  it('прямой переход APPROVED → SIGNED запрещён', () => {
    // Между ними обязателен захват: без него два запроса подпишут
    // одно намерение дважды.
    expect(canTransitionIntent('APPROVED', 'SIGNED')).toBe(false);
    expect(canTransitionIntent('APPROVED', 'SIGNING')).toBe(true);
    expect(canTransitionIntent('SIGNING', 'SIGNED')).toBe(true);
  });

  it('истёкшее и отклонённое не оживают', () => {
    for (const dead of ['EXPIRED', 'REJECTED', 'FAILED'] as TransactionIntentState[]) {
      expect(isTerminalIntentState(dead), dead).toBe(true);
      expect(canTransitionIntent(dead, 'APPROVED'), dead).toBe(false);
    }
  });
});

// ═══════════════════════ Деньги после одобрения ══════════════════════════════

describe('денежные поля после одобрения', () => {
  it('совпадение не даёт расхождений', () => {
    expect(changedMoneyFields(facts(), facts())).toEqual([]);
  });

  it('изменение суммы замечено', () => {
    expect(changedMoneyFields(facts(), facts({ rawAmount: '2000000' })))
      .toContain('rawAmount');
  });

  it('изменение получателя замечено', () => {
    expect(changedMoneyFields(facts(), facts({ destinationAddress: 'Другой' })))
      .toContain('destinationAddress');
  });

  it('изменение актива замечено', () => {
    expect(changedMoneyFields(facts(), facts({ mint: 'EPjF' }))).toContain('mint');
  });

  it('изменение списка программ замечено', () => {
    expect(changedMoneyFields(facts(), facts({ allowedProgramIds: [TOKEN_PROGRAM_ID] })))
      .toContain('allowedProgramIds');
  });

  it('изменение версии политики замечено', () => {
    expect(changedMoneyFields(facts(), facts({ policyVersion: 'phase4d-2' })))
      .toContain('policyVersion');
  });

  it('в списке денежных полей есть всё, что двигает деньги', () => {
    // Новое денежное поле нельзя добавить, молча оставив его
    // изменяемым: список записан явно и проверяется.
    for (const required of ['rawAmount', 'destinationAddress', 'mint', 'feeLimitLamports']) {
      expect(MONEY_FIELDS, required).toContain(required);
    }
  });
});

// ═══════════════════════ Предусловия подписи ═════════════════════════════════

describe('предусловия подписи', () => {
  const base = () => ({
    state: 'APPROVED' as TransactionIntentState,
    ownerId: 'user-1',
    actorId: 'user-1',
    expiresAt: 2_000,
    now: 1_000,
    lastValidBlockHeight: '5000',
    currentBlockHeight: '4900',
    approved: facts(),
    current: facts(),
    approvedKeyVersion: '3',
    currentKeyVersion: '3',
    publicKeyMatchesWallet: true,
    safetyLatchHealthy: true,
  });

  it('всё в порядке — подпись разрешена', () => {
    expect(checkSigningPreconditions(base()).allowed).toBe(true);
  });

  it('чужое намерение не подписывается', () => {
    // Подпись ставится от имени кошелька, а не от имени просящего.
    expect(checkSigningPreconditions({ ...base(), actorId: 'user-2' }).reason).toBe('NOT_OWNER');
  });

  it('неодобренное намерение не подписывается', () => {
    for (const state of ['DRAFT', 'VALIDATED', 'SIGNING'] as TransactionIntentState[]) {
      expect(checkSigningPreconditions({ ...base(), state }).reason, state).toBe('WRONG_STATE');
    }
  });

  it('уже подписанное отвечает своим кодом', () => {
    expect(checkSigningPreconditions({ ...base(), state: 'SIGNED' }).reason).toBe('ALREADY_SIGNED');
  });

  it('истёкшее намерение не подписывается', () => {
    expect(checkSigningPreconditions({ ...base(), now: 2_000 }).reason).toBe('INTENT_EXPIRED');
    expect(checkSigningPreconditions({ ...base(), now: 9_999 }).reason).toBe('INTENT_EXPIRED');
  });

  it('устаревший blockhash не подписывается', () => {
    // Подпись вышла бы валидной, но сеть её не примет — и вызов
    // KMS потрачен на заведомо мёртвые байты.
    expect(checkSigningPreconditions({ ...base(), currentBlockHeight: '5001' }).reason)
      .toBe('BLOCKHASH_EXPIRED');
  });

  it('ровно последняя допустимая высота ещё годится', () => {
    expect(checkSigningPreconditions({ ...base(), currentBlockHeight: '5000' }).allowed).toBe(true);
  });

  it('изменение суммы после одобрения останавливает подпись', () => {
    const verdict = checkSigningPreconditions({
      ...base(),
      current: facts({ rawAmount: '999', messageHash: 'hash-b' }),
    });
    expect(verdict.reason).toBe('MONEY_FIELDS_CHANGED');
    expect(verdict.changedFields).toContain('rawAmount');
  });

  it('изменение получателя после одобрения останавливает подпись', () => {
    const verdict = checkSigningPreconditions({
      ...base(),
      current: facts({ destinationAddress: 'Чужой', messageHash: 'hash-b' }),
    });
    expect(verdict.changedFields).toContain('destinationAddress');
  });

  it('расхождение только по хешу называется точнее', () => {
    expect(checkSigningPreconditions({ ...base(), current: facts({ messageHash: 'hash-b' }) }).reason)
      .toBe('MESSAGE_HASH_MISMATCH');
  });

  it('смена версии ключа останавливает подпись', () => {
    expect(checkSigningPreconditions({ ...base(), currentKeyVersion: '4' }).reason)
      .toBe('KEY_VERSION_CHANGED');
  });

  it('несовпадение публичного ключа останавливает подпись', () => {
    expect(checkSigningPreconditions({ ...base(), publicKeyMatchesWallet: false }).reason)
      .toBe('PUBLIC_KEY_MISMATCH');
  });

  it('поднятая защёлка останавливает подпись', () => {
    expect(checkSigningPreconditions({ ...base(), safetyLatchHealthy: false }).reason)
      .toBe('SAFETY_LATCH_RAISED');
  });

  it('владелец проверяется раньше состояния', () => {
    // Чужому не сообщается даже то, в каком состоянии намерение.
    const verdict = checkSigningPreconditions({ ...base(), actorId: 'user-2', state: 'SIGNED' });
    expect(verdict.reason).toBe('NOT_OWNER');
  });
});

// ═══════════════════════ Разрешённые операции ════════════════════════════════

describe('закрытый список операций', () => {
  it('разрешены только проверочные переводы', () => {
    expect([...ALLOWED_INTENT_PURPOSES]).toEqual([
      'DEVNET_SELF_TRANSFER',
      'DEVNET_SELF_SPL_TRANSFER',
    ]);
  });

  it('произвольная операция не проходит', () => {
    for (const bad of ['SWAP', 'WITHDRAW', 'TRANSFER', 'arbitrary', '']) {
      expect(isAllowedPurpose(bad), bad).toBe(false);
    }
  });

  it('системная программа разрешена для перевода SOL', () => {
    expect(programAllowed('DEVNET_SELF_TRANSFER', SYSTEM_PROGRAM_ID)).toBe(true);
  });

  it('токен-программа для перевода SOL не разрешена', () => {
    // Каждой операции — свой набор программ, а не общий список.
    expect(programAllowed('DEVNET_SELF_TRANSFER', TOKEN_PROGRAM_ID)).toBe(false);
  });

  it('неизвестная программа не разрешена ни для чего', () => {
    for (const purpose of ALLOWED_INTENT_PURPOSES) {
      expect(programAllowed(purpose, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), purpose)
        .toBe(false);
    }
  });
});

// ═══════════════════════ Числа за пределами number ═══════════════════════════

describe('сравнение больших чисел', () => {
  it('высота блока за пределами точного целого сравнивается верно', () => {
    // Через Number обе строки стали бы одним значением.
    const a = '9007199254740993';
    const b = '9007199254740992';
    expect(compareNumeric(a, b)).toBe(1);
    expect(Number(a) > Number(b)).toBe(false);
  });

  it('разная длина сравнивается по длине', () => {
    expect(compareNumeric('100', '99')).toBe(1);
    expect(compareNumeric('99', '100')).toBe(-1);
  });

  it('равные значения дают ноль', () => {
    expect(compareNumeric('42', '42')).toBe(0);
    expect(compareNumeric('0042', '42')).toBe(0);
  });

  it('нечисловое значение отвергается, а не приводится', () => {
    expect(() => compareNumeric('12a', '5')).toThrow();
    expect(() => compareNumeric('-1', '5')).toThrow();
  });
});

// ═══════════════════════ Совместимость KMS ═══════════════════════════════════

describe('совместимость провайдеров с Ed25519', () => {
  it('AWS и Google подтверждены официально', () => {
    expect(kmsCapability('aws-kms')?.verdict).toBe('SUPPORTED');
    expect(kmsCapability('gcp-kms')?.verdict).toBe('SUPPORTED');
  });

  it('оба подписывают сырое сообщение, а не хеш', () => {
    // Solana проверяет PureEdDSA. Провайдер, подписывающий хеш,
    // даст корректную по стандарту и бесполезную подпись.
    expect(kmsCapability('aws-kms')?.inputMode).toBe('RAW_MESSAGE');
    expect(kmsCapability('gcp-kms')?.inputMode).toBe('RAW_MESSAGE');
  });

  it('локальный ключ хранилищем не считается', () => {
    expect(kmsCapability('local')?.verdict).toBe('REQUIRES_EXTERNAL_SIGNER');
    expect(kmsCapability('local')?.privateKeyExportable).toBe(true);
  });

  it('приватный ключ управляемых хранилищ не экспортируется', () => {
    for (const provider of ['aws-kms', 'gcp-kms']) {
      expect(kmsCapability(provider)?.privateKeyExportable, provider).toBe(false);
    }
  });

  it('у каждого подтверждённого провайдера есть первичный источник', () => {
    for (const capability of KMS_COMPATIBILITY) {
      if (capability.verdict !== 'SUPPORTED') continue;
      expect(capability.sources.length, capability.provider).toBeGreaterThan(0);
      for (const source of capability.sources) {
        // Официальная документация вендора, а не статья.
        expect(source, capability.provider).toMatch(/^https:\/\/(docs\.aws\.amazon\.com|cloud\.google\.com)/);
      }
    }
  });

  it('неподтверждённое названо неподтверждённым', () => {
    // Кодировка подписи EdDSA в документации не описана — и это
    // записано, а не додумано.
    expect(kmsCapability('aws-kms')?.signatureFormat).toBe('UNKNOWN');
    expect(kmsCapability('aws-kms')?.unverified.length).toBeGreaterThan(0);
  });
});

describe('что мешает подписывать', () => {
  const ready = {
    provider: 'aws-kms',
    keyConfigured: true,
    publicKeyMatchesWallet: true,
    network: 'devnet',
  };

  it('готовый контур не имеет препятствий', () => {
    expect(signerBlockers(ready)).toEqual([]);
    expect(canSign(ready)).toBe(true);
  });

  it('mainnet запрещён отдельной причиной', () => {
    // «Контур не готов» и «мы сознательно не идём в боевую сеть» —
    // разные решения, и путать их нельзя.
    expect(signerBlockers({ ...ready, network: 'mainnet-beta' })).toContain('MAINNET_NOT_ALLOWED');
  });

  it('локальный ключ отвергается', () => {
    expect(signerBlockers({ ...ready, provider: 'local' }))
      .toContain('REQUIRES_EXTERNAL_SIGNER');
  });

  it('неизвестный провайдер отвергается', () => {
    expect(signerBlockers({ ...ready, provider: 'самодельный' })).toContain('PROVIDER_UNKNOWN');
  });

  it('ненастроенный ключ отвергается', () => {
    expect(signerBlockers({ ...ready, keyConfigured: false })).toContain('KEY_NOT_CONFIGURED');
  });

  it('несовпадение публичного ключа отвергается', () => {
    expect(signerBlockers({ ...ready, publicKeyMatchesWallet: false }))
      .toContain('PUBLIC_KEY_MISMATCH');
  });

  it('препятствия перечисляются все сразу', () => {
    // Иначе оператор чинит их по одному, узнавая о следующем
    // только после перезапуска.
    const blockers = signerBlockers({
      provider: 'local', keyConfigured: false, publicKeyMatchesWallet: false,
      network: 'mainnet-beta',
    });
    expect(blockers.length).toBeGreaterThanOrEqual(4);
  });
});
