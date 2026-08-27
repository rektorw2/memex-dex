import { describe, expect, it } from 'vitest';
import { NotConfiguredComplianceProvider, evaluateCompliance } from './compliance-provider.js';

describe('compliance provider boundary', () => {
  it('keeps missing external providers blocked', async () => {
    const result = await evaluateCompliance(new NotConfiguredComplianceProvider(), {
      userId: 'u1', operationType: 'WITHDRAWAL', operationId: 'w1', amountUsd: '100',
    });
    expect(result.state).toBe('NOT_CONFIGURED');
    expect(result.providerRef).toBeNull();
  });

  it('requires every check to approve', async () => {
    const result = await evaluateCompliance({
      name: 'mock',
      check: async () => ({ kyc: 'APPROVED', aml: 'APPROVED', sanctions: 'REVIEW_REQUIRED', sourceOfFunds: 'APPROVED', providerRef: 'case-1' }),
    }, { userId: 'u1', operationType: 'LIVE_TRADE', operationId: 'p1', amountUsd: '50' });
    expect(result.state).toBe('REVIEW_REQUIRED');
  });
});
