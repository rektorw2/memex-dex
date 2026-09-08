import { describe, expect, it } from 'vitest';
import {
  LIVE_READINESS_STAGES,
  isMainnet,
  liveReadinessStage,
  stageRequirementCounts,
  type LiveStageInput,
} from './live-readiness-stages.js';

/** Всё выполнено. От этого состояния тесты «отламывают» по одному условию. */
const complete: LiveStageInput = {
  paperAgentConfigured: true,
  allocationConfigured: true,
  signingEnabled: true,
  signerProviderSupported: true,
  signerKeyConfigured: true,
  signerKeyFingerprintObserved: true,
  identityRegistered: true,
  expectedKeyMatches: true,
  networkVerified: true,
  reconciliationEnabled: true,
  safetyLatchHealthy: true,
  migrationsReady: true,
  signatureValidated: true,
  hasAmbiguousAttempt: false,
  network: 'devnet',
};

/** Ничего не сделано. */
const nothing: LiveStageInput = {
  ...complete,
  paperAgentConfigured: false,
  allocationConfigured: false,
  signingEnabled: false,
  signerProviderSupported: false,
  signerKeyConfigured: false,
  signerKeyFingerprintObserved: false,
  identityRegistered: false,
  expectedKeyMatches: false,
  networkVerified: false,
  reconciliationEnabled: false,
  safetyLatchHealthy: false,
  migrationsReady: false,
  signatureValidated: false,
};

describe('лестница проходится по порядку', () => {
  it('без бумажного режима говорить не о чем', () => {
    const verdict = liveReadinessStage(nothing);

    expect(verdict.stage).toBe('PAPER_READY');
    expect(verdict.blockers).toContain('PAPER_AGENT_NOT_CONFIGURED');
  });

  it('бумажный режим готов — стоим на первой ступени', () => {
    const verdict = liveReadinessStage({
      ...nothing,
      paperAgentConfigured: true,
      allocationConfigured: true,
    });

    expect(verdict.stage).toBe('PAPER_READY');
    expect(verdict.blockers).toContain('SIGNING_DISABLED');
  });

  it('каждая ступень достигается по очереди', () => {
    /*
     * Сценарий проходится так, как его пройдёт человек: условия
     * выполняются группами, и после каждой группы проверяется,
     * где мы оказались.
     */
    const steps: Array<[Partial<LiveStageInput>, string]> = [
      [{ paperAgentConfigured: true, allocationConfigured: true }, 'PAPER_READY'],
      [
        {
          signingEnabled: true,
          signerProviderSupported: true,
          signerKeyConfigured: true,
          signerKeyFingerprintObserved: true,
        },
        'DEVNET_SIGNING_CONFIGURED',
      ],
      [
        { identityRegistered: true, expectedKeyMatches: true, networkVerified: true },
        'DEVNET_IDENTITY_VERIFIED',
      ],
      [
        { reconciliationEnabled: true, safetyLatchHealthy: true, migrationsReady: true },
        'DEVNET_FUNDING_RECONCILED',
      ],
      [{ signatureValidated: true }, 'MAINNET_BLOCKED'],
    ];

    let state = { ...nothing };
    for (const [patch, expected] of steps) {
      state = { ...state, ...patch };
      expect(liveReadinessStage(state).stage, JSON.stringify(patch)).toBe(expected);
    }
  });

  it('пропустить ступень нельзя', () => {
    /*
     * Подпись состоялась, ключ подтверждён, сверка работает — но
     * сам контур подписи выключен. Формально «дальше» готово,
     * фактически мы стоим на первой ступени.
     *
     * Это и есть запрет прыжка: лестница определяется первой
     * невыполненной ступенью, а не самой дальней выполненной.
     */
    const verdict = liveReadinessStage({ ...complete, signingEnabled: false });

    expect(verdict.stage).toBe('PAPER_READY');
    expect(verdict.blockers).toEqual(['SIGNING_DISABLED']);
  });

  it('поднятая защёлка опускает на ступень ниже', () => {
    // Расхождение в сверке — это не «мелочь на потом»: это
    // незакрытый вопрос о чужих деньгах.
    const verdict = liveReadinessStage({ ...complete, safetyLatchHealthy: false });

    expect(verdict.stage).toBe('DEVNET_IDENTITY_VERIFIED');
    expect(verdict.blockers).toEqual(['SAFETY_LATCH_RAISED']);
  });

  it('неоднозначная попытка подписи не пускает наверх', () => {
    /*
     * «Не знаем, подписалось или нет» — худшее из состояний:
     * оно не является ни успехом, ни отказом, и относиться к нему
     * как к успеху нельзя.
     */
    const verdict = liveReadinessStage({ ...complete, hasAmbiguousAttempt: true });

    expect(verdict.stage).toBe('DEVNET_FUNDING_RECONCILED');
    expect(verdict.blockers).toEqual(['AMBIGUOUS_ATTEMPT_PRESENT']);
  });
});

describe('ни один переход не совершается одним флагом', () => {
  it('у каждой ступени не меньше двух независимых условий', () => {
    /*
     * Главное правило файла, и оно измеримо. Одно условие означало
     * бы, что вся ступень снимается одной строкой в панели
     * развёртывания.
     */
    for (const step of stageRequirementCounts(complete)) {
      expect(step.total, step.stage).toBeGreaterThanOrEqual(2);
    }
  });

  it('у каждой ступени есть хотя бы один наблюдаемый факт', () => {
    /*
     * Настройку можно поставить по ошибке; факт — нельзя.
     * Ступень, целиком собранная из настроек, поднимается правкой
     * конфигурации и ничего не доказывает.
     */
    for (const step of stageRequirementCounts(complete)) {
      expect(step.observed, step.stage).toBeGreaterThanOrEqual(1);
    }
  });

  it('снятие любого одного условия опускает лестницу', () => {
    /*
     * Проверка поведением: для каждого признака строится состояние
     * без него, и лестница обязана перестать быть пройденной.
     * Признак, снятие которого ничего не меняет, — это признак,
     * который никого не защищает.
     */
    const flags: Array<keyof LiveStageInput> = [
      'paperAgentConfigured',
      'allocationConfigured',
      'signingEnabled',
      'signerProviderSupported',
      'signerKeyConfigured',
      'signerKeyFingerprintObserved',
      'identityRegistered',
      'expectedKeyMatches',
      'networkVerified',
      'reconciliationEnabled',
      'safetyLatchHealthy',
      'migrationsReady',
      'signatureValidated',
    ];

    for (const flag of flags) {
      const verdict = liveReadinessStage({ ...complete, [flag]: false });

      expect(verdict.stage, flag).not.toBe('MAINNET_BLOCKED');
      expect(verdict.blockers.length, flag).toBeGreaterThan(0);
    }
  });
});

describe('mainnet не является следующей ступенью', () => {
  it('пройденный devnet упирается в стену', () => {
    const verdict = liveReadinessStage(complete);

    expect(verdict.stage).toBe('MAINNET_BLOCKED');
    expect(verdict.blockers).toEqual([]);
  });

  it('верхняя ступень — последняя в списке', () => {
    // Порядок значим: `MAINNET_BLOCKED` не может оказаться
    // серединой лестницы, за которой есть что-то ещё.
    expect(LIVE_READINESS_STAGES.at(-1)).toBe('MAINNET_BLOCKED');
    expect(LIVE_READINESS_STAGES).toHaveLength(6);
  });

  it('запрос mainnet виден отдельно от ступени', () => {
    /*
     * Отдельное поле, потому что это не место в очереди. Пройденные
     * ступени devnet не открывают mainnet: там другой контур,
     * другие ключи и другие деньги.
     */
    expect(liveReadinessStage({ ...complete, network: 'mainnet-beta' })).toMatchObject({
      stage: 'MAINNET_BLOCKED',
      mainnetRequested: true,
    });
    expect(liveReadinessStage(complete).mainnetRequested).toBe(false);
  });

  it('запрос mainnet не пропадает на нижних ступенях', () => {
    // Иначе о нём узнали бы только наверху — то есть слишком поздно.
    expect(liveReadinessStage({ ...nothing, network: 'mainnet' })).toMatchObject({
      stage: 'PAPER_READY',
      mainnetRequested: true,
    });
  });

  it('оба написания mainnet распознаются', () => {
    expect(isMainnet('mainnet')).toBe(true);
    expect(isMainnet('mainnet-beta')).toBe(true);
    expect(isMainnet('devnet')).toBe(false);
    expect(isMainnet('testnet')).toBe(false);
  });
});
