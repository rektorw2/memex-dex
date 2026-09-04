import { afterEach, describe, expect, it } from 'vitest';
import {
  getSolanaDepositRuntimeStatus,
  startSolanaDepositWorker,
  stopSolanaDepositWorker,
} from './solana-deposit.js';

afterEach(() => stopSolanaDepositWorker());

describe('Solana deposit worker safe default', () => {
  it('does not start while funding and the source are disabled', () => {
    expect(startSolanaDepositWorker()).toBe(false);
    expect(getSolanaDepositRuntimeStatus()).toMatchObject({
      running: false,
      source: 'disabled',
      credited: 0,
    });
  });
});
