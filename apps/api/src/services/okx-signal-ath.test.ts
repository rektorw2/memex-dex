import { beforeEach, describe, expect, it, vi } from 'vitest';

let updateManyArgs: Array<Record<string, any>> = [];
let signalRows: Array<Record<string, any>> = [];

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    okxSignal: {
      updateMany: async (args: Record<string, any>) => {
        updateManyArgs.push(args);
        return { count: 1 };
      },
      findMany: async () => signalRows,
    },
    $transaction: async (operations: Array<Promise<{ count: number }>>) => Promise.all(operations),
  },
}));

const { recordOkxSignalLivePeak, recordOkxSignalCandlePeaks } = await import(
  './okx-signal-ath.js'
);

beforeEach(() => {
  updateManyArgs = [];
  signalRows = [];
});

describe('накопление ATH OKX Signal', () => {
  it('живая цена обновляет только уже появившиеся сигналы и не может уменьшить пик', async () => {
    const observedAt = new Date('2026-08-23T10:00:00Z');
    await recordOkxSignalLivePeak('token-1', 0.025, observedAt);

    expect(updateManyArgs[0]).toMatchObject({
      where: {
        tokenId: 'token-1',
        signaledAt: { lte: observedAt },
        OR: [{ peakPriceUsd: null }, { peakPriceUsd: { lt: expect.anything() } }],
      },
      data: { peakPriceUsd: expect.anything(), peakObservedAt: observedAt },
    });
  });

  it('история свечей считает отдельный максимум после каждого сигнала', async () => {
    signalRows = [
      {
        id: 'old',
        signaledAt: new Date('2026-08-23T09:00:00Z'),
        peakPriceUsd: { toNumber: () => 1 },
      },
      {
        id: 'new',
        signaledAt: new Date('2026-08-23T09:07:00Z'),
        peakPriceUsd: { toNumber: () => 1 },
      },
    ];

    await recordOkxSignalCandlePeaks('token-1', [
      { openTime: new Date('2026-08-23T09:05:00Z'), high: 8 },
      { openTime: new Date('2026-08-23T09:10:00Z'), high: 3 },
    ]);

    expect(updateManyArgs).toHaveLength(2);
    expect(updateManyArgs[0]?.data.peakPriceUsd.toNumber()).toBe(8);
    expect(updateManyArgs[0]?.data.peakObservedAt).toEqual(new Date('2026-08-23T09:05:00Z'));
    expect(updateManyArgs[1]?.data.peakPriceUsd.toNumber()).toBe(3);
    expect(updateManyArgs[1]?.data.peakObservedAt).toEqual(new Date('2026-08-23T09:10:00Z'));
  });

  it('не принимает high свечи, открывшейся до сигнала', async () => {
    signalRows = [
      {
        id: 'signal',
        signaledAt: new Date('2026-08-23T09:07:00Z'),
        peakPriceUsd: { toNumber: () => 2 },
      },
    ];

    await recordOkxSignalCandlePeaks('token-1', [
      { openTime: new Date('2026-08-23T09:05:00Z'), high: 100 },
      { openTime: new Date('2026-08-23T09:10:00Z'), high: 3 },
    ]);

    expect(updateManyArgs[0]?.data.peakPriceUsd.toNumber()).toBe(3);
  });
});
