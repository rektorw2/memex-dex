/**
 * Один набор воркеров на оба способа запуска.
 *
 * Раньше `server.ts` (RUN_WORKERS_IN_API=true) и `workers/index.ts`
 * (отдельный процесс) перечисляли воркеры каждый по-своему, и наборы
 * разошлись: в API не запускались сборщик подписок, приём и сверка
 * депозитов Solana, закрытие просроченных намерений и подпись. На
 * Render воркеры живут внутри API, то есть в бою не работало ровно
 * то, что стояло в списке standalone.
 *
 * Здесь набор один. Финансовые воркеры (депозиты, сверка, намерения,
 * подпись) по-прежнему решают сами, стартовать ли им — по своим
 * флагам (`FUNDING_ENABLED`, `LIVE_AGENT_ENABLED`, состояние
 * подписи): регистр их вызывает, но не включает в обход флагов. Что
 * стартовало, а что отказалось, видно по возвращаемому списку.
 */
import { logger } from '../lib/logger.js';

export interface WorkerHandle {
  name: string;
  /** `false` — воркер отказался стартовать по своему флагу. */
  started: boolean;
  stop: () => void;
}

interface Named {
  name: string;
  start: () => Promise<boolean | void> | boolean | void;
  stop: () => void;
}

async function startAll(list: Named[]): Promise<WorkerHandle[]> {
  const handles: WorkerHandle[] = [];
  for (const item of list) {
    const result = await item.start();
    const started = result !== false;
    handles.push({ name: item.name, started, stop: item.stop });
  }
  return handles;
}

/** Воркеры, не зависящие от схемы кошельков: цены, лимитки, импорт, радар. */
export async function startBaseWorkers(): Promise<WorkerHandle[]> {
  const [memory, limit, price, copy, importer, candles, radar, tracker, wallets, scam, sweeper] = await Promise.all([
    import('./memory-monitor.js'),
    import('./limit-watcher.js'),
    import('./price-updater.js'),
    import('./copy-executor.js'),
    import('./token-importer.js'),
    import('./candle-builder.js'),
    import('./radar-scanner.js'),
    import('./radar-tracker.js'),
    import('./wallet-tracker.js'),
    import('./scam-checker.js'),
    import('./entitlement-sweeper.js'),
  ]);
  return startAll([
    // Первым: строка памяти в журнале должна появиться раньше любой работы.
    { name: 'memory-monitor', start: memory.startMemoryMonitor, stop: memory.stopMemoryMonitor },
    { name: 'price-updater', start: price.startPriceUpdater, stop: price.stopPriceUpdater },
    { name: 'limit-watcher', start: limit.startLimitWatcher, stop: limit.stopLimitWatcher },
    { name: 'copy-executor', start: copy.startCopyExecutor, stop: copy.stopCopyExecutor },
    { name: 'token-importer', start: importer.startTokenImporter, stop: importer.stopTokenImporter },
    { name: 'candle-builder', start: candles.startCandleBuilder, stop: candles.stopCandleBuilder },
    { name: 'radar-scanner', start: radar.startRadarScanner, stop: radar.stopRadarScanner },
    { name: 'radar-tracker', start: tracker.startRadarTracker, stop: tracker.stopRadarTracker },
    { name: 'wallet-tracker', start: wallets.startWalletTracker, stop: wallets.stopWalletTracker },
    { name: 'scam-checker', start: scam.startScamChecker, stop: scam.stopScamChecker },
    { name: 'entitlement-sweeper', start: sweeper.startEntitlementSweeper, stop: sweeper.stopEntitlementSweeper },
  ]);
}

/**
 * Воркеры, пишущие в таблицы кошельков и агента. Запускаются только
 * после проверки схемы — вызывающий обязан проверить её сам.
 *
 * Порядок важен: сначала потребитель сигналов (агент), потом
 * источник (OKX Signal), чтобы первое событие не попало в зазор.
 */
export async function startSchemaWorkers(): Promise<WorkerHandle[]> {
  const [pool, ledger, discovery, walletRisk, okxSignal, paperAgent, paperNotifications, deposit, reconciliation, expiry, signing] = await Promise.all([
    import('../services/okx-ws-pool.js'),
    import('./wallet-ledger-sync.js'),
    import('./wallet-discovery.js'),
    import('./radar-risk.js'),
    import('./okx-signal-ingest.js'),
    import('./paper-agent.js'),
    import('./paper-agent-notifications.js'),
    import('./solana-deposit.js'),
    import('./solana-reconciliation.js'),
    import('./intent-expiry.js'),
    import('./intent-signing.js'),
  ]);
  return startAll([
    { name: 'okx-activity-ingest', start: pool.startActivityIngest, stop: pool.stopActivityIngest },
    { name: 'wallet-ledger-sync', start: ledger.startLedgerSync, stop: ledger.stopLedgerSync },
    { name: 'wallet-discovery', start: discovery.startWalletDiscovery, stop: discovery.stopWalletDiscovery },
    { name: 'radar-risk', start: walletRisk.startRadarRisk, stop: walletRisk.stopRadarRisk },
    { name: 'paper-agent', start: paperAgent.startPaperAgent, stop: paperAgent.stopPaperAgent },
    { name: 'paper-agent-notifications', start: paperNotifications.startPaperAgentNotifications, stop: paperNotifications.stopPaperAgentNotifications },
    { name: 'okx-signal-ingest', start: okxSignal.startOkxSignalIngest, stop: okxSignal.stopOkxSignalIngest },
    // Финансовые воркеры: каждый сам проверяет свой флаг и отказывается стартовать без него.
    { name: 'solana-deposit', start: deposit.startSolanaDepositWorker, stop: deposit.stopSolanaDepositWorker },
    { name: 'solana-reconciliation', start: reconciliation.startSolanaReconciliationWorker, stop: reconciliation.stopSolanaReconciliationWorker },
    { name: 'intent-expiry', start: expiry.startIntentExpiryWorker, stop: expiry.stopIntentExpiryWorker },
    { name: 'intent-signing', start: signing.startIntentSigningWorker, stop: signing.stopIntentSigningWorker },
  ]);
}

export function stopWorkers(handles: WorkerHandle[]): void {
  // В обратном порядке: источник сигналов раньше потребителя.
  for (const handle of [...handles].reverse()) {
    try { handle.stop(); } catch (error: any) { logger.warn({ worker: handle.name, code: error?.code }, 'воркер не остановился чисто'); }
  }
}

export function describeWorkers(handles: WorkerHandle[]): { started: string[]; skipped: string[] } {
  return {
    started: handles.filter((h) => h.started).map((h) => h.name),
    skipped: handles.filter((h) => !h.started).map((h) => h.name),
  };
}
