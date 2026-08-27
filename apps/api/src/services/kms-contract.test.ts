import { describe, expect, it } from 'vitest';
import {
  KmsOperationError,
  MemoryTestKms,
  UnavailableProductionKms,
  kmsRuntimeVerdict,
  withKmsAudit,
  type KmsAuditRecord,
} from './kms-contract.js';

const context = { requestId: 'req-1', walletId: 'wallet-1', purpose: 'WALLET_DEK' as const };

describe('production KMS contract', () => {
  it('wraps and unwraps in the test adapter and keeps key version', async () => {
    const kms = new MemoryTestKms(new Uint8Array(32).fill(3));
    const raw = new Uint8Array([1, 2, 3, 4]);
    const wrapped = await kms.wrapDek(raw, context);
    expect(wrapped).not.toEqual(raw);
    expect(await kms.unwrapDek(wrapped, context)).toEqual(raw);
    expect((await kms.rotateKey(context)).version).toBe('2');
  });

  it('fails honestly when a cloud adapter is not configured', async () => {
    const kms = new UnavailableProductionKms({ provider: 'aws-kms', keyId: 'key-1', version: '1' });
    await expect(kms.signDigest(new Uint8Array([1]), { ...context, purpose: 'SOLANA_TRANSACTION' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('audits metadata but never secret bytes or provider error text', async () => {
    const records: KmsAuditRecord[] = [];
    const kms = withKmsAudit(
      new UnavailableProductionKms({ provider: 'gcp-kms', keyId: 'key-2', version: '7' }),
      { record: async (event) => { records.push(event); } },
    );
    const secret = new TextEncoder().encode('private-secret-material');
    await expect(kms.signDigest(secret, { ...context, purpose: 'SOLANA_TRANSACTION' })).rejects.toBeInstanceOf(KmsOperationError);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('private-secret-material');
    expect(records[0]).toMatchObject({ action: 'SIGN', status: 'FAILED', errorCode: 'PROVIDER_NOT_CONFIGURED', keyVersion: '7' });
  });
});

describe('KMS runtime policy', () => {
  it('forbids local KMS for any LIVE execution', () => {
    expect(kmsRuntimeVerdict({ nodeEnv: 'development', provider: 'local', fundingEnabled: false, liveEnabled: true }).allowed).toBe(false);
  });

  it('forbids local KMS for production funding', () => {
    expect(kmsRuntimeVerdict({ nodeEnv: 'production', provider: 'local', fundingEnabled: true, liveEnabled: false }).reason).toBe('LOCAL_KMS_FORBIDDEN_FOR_PRODUCTION_FUNDING');
  });
});
