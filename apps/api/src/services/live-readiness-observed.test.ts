import { beforeEach, describe, expect, it, vi } from 'vitest';
import { liveReadinessStage, stageRequirementCounts, type LiveStageInput } from '@memex/core';

/**
 * Наблюдаемые факты лестницы готовности — по источнику, а не по имени.
 *
 * Лестница помечает часть своих входов как «наблюдаемый факт, а не
 * настройка». Пометка ничего не стоит, пока её не с чем сверить:
 * `networkVerified` был помечен наблюдаемым и вычислялся как
 * `Boolean(env.SOLANA_PREFLIGHT_RPC_URL)`.
 *
 * Здесь проверяется именно источник. Переменная задана, доказательства
 * нет — ступень не поднимается. Ни одна настройка не должна уметь
 * поднять её в одиночку.
 */

const envMock = {
  // Адрес узла задан. Раньше одного этого хватало.
  SOLANA_PREFLIGHT_RPC_URL: 'https://example.invalid/devnet',
  SOLANA_NETWORK: 'devnet' as const,
  SOLANA_EXPECTED_GENESIS_HASH: undefined as string | undefined,
  SOLANA_SIGNING_ENABLED: true,
  SOLANA_SIGNER_PROVIDER: 'aws-kms',
  SOLANA_SIGNER_KEY_ID: 'key',
  SOLANA_SIGNER_KEY_VERSION: '1',
  WITHDRAWALS_ENABLED: false,
  AWS_KMS_EXPECTED_PUBLIC_KEY: undefined as string | undefined,
};

vi.mock('../lib/env.js', () => ({ env: envMock }));

/** Контур подписи собран целиком: ключ зарегистрирован, подпись была. */
let identity: Record<string, unknown> | null = null;
let networkProof: Record<string, unknown> | null = null;
let successfulAttempts = 0;

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    signingIdentity: { findUnique: async () => identity },
    signingAttempt: {
      count: async ({ where }: any) =>
        where.outcome === 'SUCCEEDED' ? successfulAttempts : 0,
    },
    fundingSafetyLatch: { findUnique: async () => ({ state: 'HEALTHY' }) },
    solanaNetworkProof: { findUnique: async () => networkProof },
  },
}));

const { readSigningState } = await import('./signing-state.js');

beforeEach(() => {
  identity = {
    fingerprint: 'f'.repeat(16),
    solanaAddress: 'A'.repeat(44),
    state: 'REGISTERED',
  };
  networkProof = null;
  successfulAttempts = 1;
  envMock.SOLANA_PREFLIGHT_RPC_URL = 'https://example.invalid/devnet';
  envMock.AWS_KMS_EXPECTED_PUBLIC_KEY = undefined;
});

/**
 * Лестница на настоящем снимке подписи.
 *
 * Всё остальное — выполнено. Так видно, что ступень держит именно
 * непроверенная сеть, а не общий отказ где-то ниже.
 */
async function stageNow(over: Partial<LiveStageInput> = {}) {
  const signing = await readSigningState();

  return {
    signing,
    verdict: liveReadinessStage({
      paperAgentConfigured: true,
      allocationConfigured: true,
      signingEnabled: signing.facts.signingEnabled,
      signerProviderSupported: signing.facts.providerSupported,
      signerKeyConfigured: signing.facts.keyConfigured,
      signerKeyFingerprintObserved: signing.facts.keyFingerprint != null,
      identityRegistered: signing.facts.identityState === 'OK',
      // Ожидание не задано — считаем совпавшим, чтобы ступень держала
      // ровно одно условие и его было видно.
      expectedKeyMatches: signing.facts.expectedKeyMatches !== false,
      networkVerified: signing.facts.networkVerified,
      reconciliationEnabled: true,
      safetyLatchHealthy: true,
      migrationsReady: true,
      signatureValidated: signing.facts.signatureValidated,
      hasAmbiguousAttempt: signing.facts.hasAmbiguousAttempt,
      network: signing.facts.network,
      ...over,
    }),
  };
}

describe('один SOLANA_PREFLIGHT_RPC_URL не поднимает ступень', () => {
  it('переменная задана, проверки не было — сеть не проверена', async () => {
    const { signing } = await stageNow();

    expect(envMock.SOLANA_PREFLIGHT_RPC_URL, 'переменная действительно задана').toBeTruthy();
    expect(signing.facts.networkVerified).toBe(false);
    expect(signing.devnetProof?.code).toBe('NOT_RUN');
  });

  it('лестница останавливается перед DEVNET_IDENTITY_VERIFIED', async () => {
    /*
     * Главный тест задания. Всё, кроме сети, выполнено — и ступень
     * всё равно не поднимается.
     */
    const { verdict } = await stageNow();

    expect(verdict.stage).toBe('DEVNET_SIGNING_CONFIGURED');
    expect(verdict.blockers).toContain('NETWORK_NOT_VERIFIED');
  });

  it('лестница не перепрыгивает через непройденную ступень', async () => {
    // Ни одна ступень выше не достигается, пока держит эта.
    const { verdict } = await stageNow();

    expect(verdict.stage).not.toBe('DEVNET_FUNDING_RECONCILED');
    expect(verdict.stage).not.toBe('DEVNET_SIGNATURE_PROVEN');
    expect(verdict.stage).not.toBe('MAINNET_BLOCKED');
  });

  it('со свежим доказательством ступень поднимается', async () => {
    /*
     * Негативный контроль: ступень держит именно отсутствие
     * доказательства, а не что-то ещё. Без этого теста предыдущие
     * три доказывали бы только то, что лестница вообще не работает.
     */
    const { endpointFingerprint } = await import('./devnet-network-proof.js');
    const now = Date.now();
    networkProof = {
      formatVersion: 1,
      network: 'devnet',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      endpointFingerprint: endpointFingerprint(envMock.SOLANA_PREFLIGHT_RPC_URL),
      outcome: 'VERIFIED',
      failureCode: null,
      methods: ['getHealth', 'getGenesisHash', 'getSlot', 'getSignaturesForAddress'],
      verifiedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 600_000),
      checkedAt: new Date(now - 1_000),
      maxLatencyMs: 42,
      leaseExpiresAt: null,
    };

    const { signing, verdict } = await stageNow();

    expect(signing.facts.networkVerified).toBe(true);
    expect(verdict.stage).toBe('MAINNET_BLOCKED');
    expect(verdict.blockers).toEqual([]);
  });

  it('устаревшее доказательство снова опускает ступень', async () => {
    const { endpointFingerprint } = await import('./devnet-network-proof.js');
    const now = Date.now();
    networkProof = {
      formatVersion: 1,
      network: 'devnet',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      endpointFingerprint: endpointFingerprint(envMock.SOLANA_PREFLIGHT_RPC_URL),
      outcome: 'VERIFIED',
      failureCode: null,
      methods: ['getHealth', 'getGenesisHash', 'getSlot', 'getSignaturesForAddress'],
      verifiedAt: new Date(now - 7_200_000),
      expiresAt: new Date(now - 3_600_000),
      checkedAt: new Date(now - 7_200_000),
      maxLatencyMs: 42,
      leaseExpiresAt: null,
    };

    const { signing, verdict } = await stageNow();

    expect(signing.devnetProof?.code).toBe('EXPIRED');
    expect(signing.devnetProof?.stale).toBe(true);
    expect(verdict.blockers).toContain('NETWORK_NOT_VERIFIED');
  });
});

describe('снимок подписи на старте ничего не подтверждает', () => {
  it('без базы сеть не может быть проверенной', async () => {
    /*
     * Startup guards считают состояние до того, как соединение с
     * базой существует. Доказательство живёт в базе — значит,
     * честный ответ здесь только «не проверена».
     */
    const { signingStateFromConfig } = await import('./signing-state.js');
    const snapshot = signingStateFromConfig();

    expect(snapshot.facts.networkVerified).toBe(false);
    expect(snapshot.devnetProof, 'доказательства без базы не бывает').toBeNull();
  });
});

describe('каждый переход держат минимум два условия', () => {
  it('и хотя бы одно из них — наблюдаемый факт', async () => {
    /*
     * Правило лестницы, записанное измеримо. Ступень, все условия
     * которой — настройки, поднимается правкой конфигурации; ступень
     * с фактом требует, чтобы что-то произошло.
     */
    const { signing } = await stageNow();
    const counts = stageRequirementCounts({
      paperAgentConfigured: true,
      allocationConfigured: true,
      signingEnabled: signing.facts.signingEnabled,
      signerProviderSupported: signing.facts.providerSupported,
      signerKeyConfigured: signing.facts.keyConfigured,
      signerKeyFingerprintObserved: signing.facts.keyFingerprint != null,
      identityRegistered: signing.facts.identityState === 'OK',
      expectedKeyMatches: true,
      networkVerified: signing.facts.networkVerified,
      reconciliationEnabled: true,
      safetyLatchHealthy: true,
      migrationsReady: true,
      signatureValidated: signing.facts.signatureValidated,
      hasAmbiguousAttempt: signing.facts.hasAmbiguousAttempt,
      network: signing.facts.network,
    });

    for (const step of counts) {
      expect(step.total, step.stage).toBeGreaterThanOrEqual(2);
      expect(step.observed, step.stage).toBeGreaterThanOrEqual(1);
    }
  });
});
