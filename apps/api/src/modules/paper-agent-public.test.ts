import { describe, expect, it } from 'vitest';
import { publicSnapshotOf } from './paper-agent.js';

const run = {
  id: 'run-1', tokenId: 'token-1', token: { id: 'token-1', symbol: 'MEME', name: 'Meme', logoUrl: null },
  state: 'PAPER_OPEN', decisionCode: 'ENTRY_OPENED', errorCode: 'SECRET_INTERNAL',
  strategyLabel: 'Baseline', providerKey: 'provider-secret', chain: 'SOLANA', address: 'mint-1', symbol: 'MEME',
  triggerWalletAddresses: ['private-source-wallet'], signaledAt: '2026-08-27T10:00:00.000Z',
  decidedAt: '2026-08-27T10:00:01.000Z', signalOrigin: 'OKX_SIGNAL_WEBSOCKET', entryAt: '2026-08-27T10:00:01.000Z',
  exitAt: null, entryPriceUsd: 1, currentPriceUsd: 1.1, realizedPnlUsd: null, unrealizedPnlUsd: 10,
  maxMultiple: 1.1, durationMs: 1000, positionUsd: 100, totalCostsUsd: 0.2,
  allocation: { mode: 'FIXED', allocatedUsd: 100, signalScore: 75 },
};

function snapshot() {
  return {
    health: 'ACTIVE',
    control: { isEnabled: true, activeAllocationMode: 'FIXED', learningModeEnabled: false },
    runtime: { running: true, lastActivityAt: '2026-08-27T10:00:01.000Z', queued: 0, refusalReason: null },
    okxSignal: { transportMode: 'WEBSOCKET', socket: { state: 'connected' }, lastSignalAt: '2026-08-27T10:00:00.000Z', lastRestSuccessAt: null, nextRestReconciliationAt: null },
    notifications: { unread: 1, telegramEnabled: true, pending: 0 },
    metrics24h: { uniqueSignals: 3, runs: 5, openPositions: 1, states: { PAPER_CLOSED: 2 }, decisionLatencyP50Ms: 120, decisionLatencyP95Ms: 300, decisionLatencySampleSize: 5 },
    allocation: { accounts: [{ kind: 'ACTIVE', status: 'ACTIVE', capital: { initialUsd: 1000, inPositionsUsd: 100 }, ledger: [] }] },
    positions: { open: [run, { ...run, id: 'legacy', allocation: { legacy: true } }] },
    decisions: [run], comparison: [{ key: 'baseline' }],
  };
}

describe('публичный снимок PAPER-агента', () => {
  it('обычный пользователь видит PAPER-счёт, позиции и понятные события', () => {
    const result = publicSnapshotOf(snapshot(), false);
    expect(result).toMatchObject({ paper: true, network: 'Solana', viewer: { isAdmin: false }, metrics24h: { capitalUtilizationPct: 10 } });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({ tokenId: 'token-1', symbol: 'MEME', unrealizedPnlUsd: 10 });
  });

  it('не раскрывает provider key, источник-кошелёк и внутренний error code', () => {
    const serialized = JSON.stringify(publicSnapshotOf(snapshot(), false));
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('private-source-wallet');
    expect(serialized).not.toContain('SECRET_INTERNAL');
  });

  it('администратор отличается только правом показать управляющую вкладку', () => {
    expect(publicSnapshotOf(snapshot(), true).viewer.isAdmin).toBe(true);
    expect(publicSnapshotOf(snapshot(), false).viewer.isAdmin).toBe(false);
  });

  it('REST_ONLY объясняется отдельным признаком резервного канала', () => {
    const source: any = snapshot();
    source.okxSignal.transportMode = 'REST_ONLY';
    expect(publicSnapshotOf(source, false).source.fallbackActive).toBe(true);
  });
});
