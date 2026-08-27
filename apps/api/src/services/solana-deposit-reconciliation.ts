export interface FinalizedDepositFact {
  eventKey: string;
  destination: string;
  rawAmount: string;
  state: 'FINALIZED' | 'REORGED';
}
export interface CreditedDepositFact {
  eventKey: string;
  destination: string;
  rawAmount: string;
}

export type DepositDiscrepancyKind =
  | 'MISSING_CREDIT'
  | 'ORPHAN_CREDIT'
  | 'AMOUNT_MISMATCH'
  | 'DESTINATION_MISMATCH'
  | 'REORG_AFTER_CREDIT';

export interface DepositDiscrepancy {
  eventKey: string;
  kind: DepositDiscrepancyKind;
  expected: FinalizedDepositFact | null;
  actual: CreditedDepositFact | null;
}

/**
 * Reconciliation is intentionally side-effect free. A production worker must
 * persist every result for manual review; it must never "repair" money by
 * silently rewriting a balance.
 */
export function reconcileSolanaDeposits(
  chain: readonly FinalizedDepositFact[],
  credited: readonly CreditedDepositFact[],
): DepositDiscrepancy[] {
  const chainByKey = new Map(chain.map((fact) => [fact.eventKey, fact]));
  const creditByKey = new Map(credited.map((fact) => [fact.eventKey, fact]));
  const keys = new Set([...chainByKey.keys(), ...creditByKey.keys()]);
  const issues: DepositDiscrepancy[] = [];

  for (const eventKey of [...keys].sort()) {
    const expected = chainByKey.get(eventKey) ?? null;
    const actual = creditByKey.get(eventKey) ?? null;
    if (expected?.state === 'REORGED' && actual) {
      issues.push({ eventKey, kind: 'REORG_AFTER_CREDIT', expected, actual });
    } else if (expected?.state === 'FINALIZED' && !actual) {
      issues.push({ eventKey, kind: 'MISSING_CREDIT', expected, actual: null });
    } else if (!expected && actual) {
      issues.push({ eventKey, kind: 'ORPHAN_CREDIT', expected: null, actual });
    } else if (expected && actual && expected.destination !== actual.destination) {
      issues.push({ eventKey, kind: 'DESTINATION_MISMATCH', expected, actual });
    } else if (expected && actual && expected.rawAmount !== actual.rawAmount) {
      issues.push({ eventKey, kind: 'AMOUNT_MISMATCH', expected, actual });
    }
  }
  return issues;
}
