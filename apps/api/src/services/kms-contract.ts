import crypto from 'node:crypto';

export type KmsProviderName = 'local' | 'aws-kms' | 'gcp-kms' | 'memory-test';

export interface KmsKeyRef {
  provider: KmsProviderName;
  keyId: string;
  version: string;
}

export interface KmsOperationContext {
  requestId: string;
  walletId?: string;
  actorId?: string;
  purpose: 'WALLET_DEK' | 'SOLANA_TRANSACTION';
}

export interface ProductionKmsProvider {
  readonly key: KmsKeyRef;
  wrapDek(dek: Uint8Array, context: KmsOperationContext): Promise<Uint8Array>;
  unwrapDek(wrappedDek: Uint8Array, context: KmsOperationContext): Promise<Uint8Array>;
  signDigest(digest: Uint8Array, context: KmsOperationContext): Promise<Uint8Array>;
  rotateKey(context: KmsOperationContext): Promise<KmsKeyRef>;
}

export interface KmsAuditRecord {
  requestId: string;
  walletId: string | null;
  actorId: string | null;
  action: 'WRAP_DEK' | 'UNWRAP_DEK' | 'SIGN' | 'ROTATE';
  provider: KmsProviderName;
  keyId: string;
  keyVersion: string;
  status: 'SUCCEEDED' | 'FAILED';
  errorCode: string | null;
}

export interface KmsAuditSink {
  record(event: KmsAuditRecord): Promise<void>;
}

export class KmsOperationError extends Error {
  constructor(readonly code: string) {
    super(`KMS operation failed (${code})`);
    this.name = 'KmsOperationError';
  }
}

function safeCode(cause: unknown): string {
  if (cause instanceof KmsOperationError) return cause.code;
  return 'KMS_UNAVAILABLE';
}

/**
 * Audit wrapper deliberately records metadata only. Payload, digest, wrapped
 * DEK and provider error text never cross the audit boundary.
 */
export function withKmsAudit(provider: ProductionKmsProvider, audit: KmsAuditSink) {
  const run = async <T>(
    action: KmsAuditRecord['action'],
    context: KmsOperationContext,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await work();
      await audit.record(recordOf(provider, context, action, 'SUCCEEDED', null));
      return result;
    } catch (cause) {
      const code = safeCode(cause);
      await audit.record(recordOf(provider, context, action, 'FAILED', code));
      throw new KmsOperationError(code);
    }
  };

  return {
    key: provider.key,
    wrapDek: (dek: Uint8Array, context: KmsOperationContext) =>
      run('WRAP_DEK', context, () => provider.wrapDek(dek, context)),
    unwrapDek: (wrapped: Uint8Array, context: KmsOperationContext) =>
      run('UNWRAP_DEK', context, () => provider.unwrapDek(wrapped, context)),
    signDigest: (digest: Uint8Array, context: KmsOperationContext) =>
      run('SIGN', context, () => provider.signDigest(digest, context)),
    rotateKey: (context: KmsOperationContext) =>
      run('ROTATE', context, () => provider.rotateKey(context)),
  };
}

function recordOf(
  provider: ProductionKmsProvider,
  context: KmsOperationContext,
  action: KmsAuditRecord['action'],
  status: KmsAuditRecord['status'],
  errorCode: string | null,
): KmsAuditRecord {
  return {
    requestId: context.requestId,
    walletId: context.walletId ?? null,
    actorId: context.actorId ?? null,
    action,
    provider: provider.key.provider,
    keyId: provider.key.keyId,
    keyVersion: provider.key.version,
    status,
    errorCode,
  };
}

/** Honest placeholder: AWS/GCP adapters are externally blocked, not healthy. */
export class UnavailableProductionKms implements ProductionKmsProvider {
  constructor(readonly key: KmsKeyRef) {}
  private unavailable(): never { throw new KmsOperationError('PROVIDER_NOT_CONFIGURED'); }
  async wrapDek(_dek: Uint8Array, _context: KmsOperationContext): Promise<Uint8Array> { return this.unavailable(); }
  async unwrapDek(_wrapped: Uint8Array, _context: KmsOperationContext): Promise<Uint8Array> { return this.unavailable(); }
  async signDigest(_digest: Uint8Array, _context: KmsOperationContext): Promise<Uint8Array> { return this.unavailable(); }
  async rotateKey(_context: KmsOperationContext): Promise<KmsKeyRef> { return this.unavailable(); }
}

/** Deterministic test adapter; startup guards forbid it for LIVE/funding prod. */
export class MemoryTestKms implements ProductionKmsProvider {
  private version = 1;
  constructor(private readonly keyMaterial: Uint8Array = crypto.randomBytes(32)) {}
  get key(): KmsKeyRef {
    return { provider: 'memory-test', keyId: 'test-only', version: String(this.version) };
  }
  async wrapDek(dek: Uint8Array, _context: KmsOperationContext) {
    return Uint8Array.from(dek, (value, index) => value ^ this.keyMaterial[index % this.keyMaterial.length]!);
  }
  async unwrapDek(wrapped: Uint8Array, context: KmsOperationContext) { return this.wrapDek(wrapped, context); }
  async signDigest(digest: Uint8Array, _context: KmsOperationContext) {
    return new Uint8Array(crypto.createHmac('sha256', this.keyMaterial).update(digest).digest());
  }
  async rotateKey(_context: KmsOperationContext) {
    this.version += 1;
    return this.key;
  }
}

export function kmsRuntimeVerdict(input: {
  nodeEnv: 'development' | 'test' | 'production';
  provider: 'local' | 'aws-kms' | 'gcp-kms';
  fundingEnabled: boolean;
  liveEnabled: boolean;
}): { allowed: boolean; reason: string | null } {
  if (input.liveEnabled && input.provider === 'local') {
    return { allowed: false, reason: 'LOCAL_KMS_FORBIDDEN_FOR_LIVE' };
  }
  if (input.nodeEnv === 'production' && input.fundingEnabled && input.provider === 'local') {
    return { allowed: false, reason: 'LOCAL_KMS_FORBIDDEN_FOR_PRODUCTION_FUNDING' };
  }
  return { allowed: true, reason: null };
}
