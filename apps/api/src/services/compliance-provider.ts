import { complianceVerdict, type ComplianceCheck, type ComplianceState } from '@memex/core';

export interface ComplianceSubject {
  userId: string;
  operationType: 'LIVE_TRADE' | 'WITHDRAWAL' | 'FUNDING';
  operationId: string;
  amountUsd: string | null;
  destination?: string;
}
export interface ComplianceProvider {
  readonly name: string;
  check(subject: ComplianceSubject): Promise<ComplianceCheck & { providerRef: string | null }>;
}

export class NotConfiguredComplianceProvider implements ComplianceProvider {
  readonly name = 'not-configured';
  async check(): Promise<ComplianceCheck & { providerRef: null }> {
    return {
      kyc: 'NOT_CONFIGURED',
      aml: 'NOT_CONFIGURED',
      sanctions: 'NOT_CONFIGURED',
      sourceOfFunds: 'NOT_CONFIGURED',
      providerRef: null,
    };
  }
}

export async function evaluateCompliance(
  provider: ComplianceProvider,
  subject: ComplianceSubject,
): Promise<{ state: ComplianceState; check: ComplianceCheck; providerRef: string | null }> {
  const result = await provider.check(subject);
  const check: ComplianceCheck = {
    kyc: result.kyc,
    aml: result.aml,
    sanctions: result.sanctions,
    sourceOfFunds: result.sourceOfFunds,
  };
  return { state: complianceVerdict(check), check, providerRef: result.providerRef };
}
