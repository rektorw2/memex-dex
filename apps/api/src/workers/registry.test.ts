/**
 * Оба способа запуска поднимают один набор воркеров.
 *
 * Проверяется исходник: `server.ts` и `workers/index.ts` не перечисляют
 * воркеры сами, а берут регистр, и регистр содержит финансовые воркеры,
 * которые раньше в API не запускались. Их флаги остаются внутри самих
 * воркеров — регистр вызывает `start`, а тот вправе отказать.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('регистр воркеров', () => {
  it('server.ts и workers/index.ts используют общий регистр, а не свои списки', () => {
    const server = read('../server.ts');
    const index = read('./index.ts');
    for (const source of [server, index]) {
      expect(source).toContain('startBaseWorkers');
      expect(source).toContain('startSchemaWorkers');
      expect(source).not.toMatch(/import\('\.\/workers\/limit-watcher\.js'\)/);
    }
    expect(index).not.toMatch(/^import \{ start[A-Z]\w+ \} from '\.\/(limit-watcher|solana-deposit|intent-signing)\.js';/m);
  });

  it('регистр содержит финансовые воркеры и агента; финансовые — за своими флагами', () => {
    const registry = read('./registry.ts');
    for (const name of ['startSolanaDepositWorker', 'startSolanaReconciliationWorker', 'startIntentExpiryWorker', 'startIntentSigningWorker', 'startPaperAgent', 'startOkxSignalIngest', 'startEntitlementSweeper']) {
      expect(registry).toContain(name);
    }
    expect(read('./solana-deposit.ts')).toContain('if (!env.FUNDING_ENABLED');
    expect(read('./intent-expiry.ts')).toContain('if (!env.LIVE_AGENT_ENABLED');
    expect(read('./intent-signing.ts')).toContain('allowsKmsCall');
  });

  it('отказ воркера по флагу записывается как skipped, остановка идёт в обратном порядке', async () => {
    const order: string[] = [];
    vi.doMock('./limit-watcher.js', () => ({ startLimitWatcher: () => { order.push('start:limit'); }, stopLimitWatcher: () => order.push('stop:limit') }));
    vi.doMock('./price-updater.js', () => ({ startPriceUpdater: () => { order.push('start:price'); }, stopPriceUpdater: () => order.push('stop:price') }));
    vi.doMock('./copy-executor.js', () => ({ startCopyExecutor: () => false, stopCopyExecutor: () => order.push('stop:copy') }));
    for (const [mod, start, stop] of [
      ['./token-importer.js', 'startTokenImporter', 'stopTokenImporter'], ['./candle-builder.js', 'startCandleBuilder', 'stopCandleBuilder'],
      ['./radar-scanner.js', 'startRadarScanner', 'stopRadarScanner'], ['./radar-tracker.js', 'startRadarTracker', 'stopRadarTracker'],
      ['./wallet-tracker.js', 'startWalletTracker', 'stopWalletTracker'], ['./scam-checker.js', 'startScamChecker', 'stopScamChecker'],
      ['./entitlement-sweeper.js', 'startEntitlementSweeper', 'stopEntitlementSweeper'],
      ['./memory-monitor.js', 'startMemoryMonitor', 'stopMemoryMonitor'],
    ] as const) {
      vi.doMock(mod, () => ({ [start]: () => undefined, [stop]: () => undefined }));
    }
    vi.doMock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
    const { startBaseWorkers, stopWorkers, describeWorkers } = await import('./registry.js');
    const handles = await startBaseWorkers();
    expect(describeWorkers(handles).skipped).toEqual(['copy-executor']);
    expect(order).toEqual(['start:price', 'start:limit']);
    stopWorkers(handles);
    expect(order.slice(2)).toEqual(['stop:copy', 'stop:limit', 'stop:price']);
    vi.resetModules();
  });
});
