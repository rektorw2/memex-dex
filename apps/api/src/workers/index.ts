import { startLimitWatcher, stopLimitWatcher } from './limit-watcher.js';
import { startPriceUpdater, stopPriceUpdater } from './price-updater.js';
import { startCopyExecutor, stopCopyExecutor } from './copy-executor.js';
import { startTokenImporter, stopTokenImporter } from './token-importer.js';
import { startCandleBuilder, stopCandleBuilder } from './candle-builder.js';
import { startRadarScanner, stopRadarScanner } from './radar-scanner.js';
import { startRadarTracker, stopRadarTracker } from './radar-tracker.js';
import { startWalletTracker, stopWalletTracker } from './wallet-tracker.js';
import { startScamChecker, stopScamChecker } from './scam-checker.js';
import { startRadarRisk, stopRadarRisk } from './radar-risk.js';
import { startEntitlementSweeper, stopEntitlementSweeper } from './entitlement-sweeper.js';
import { startWalletDiscovery, stopWalletDiscovery } from './wallet-discovery.js';
import { startActivityIngest, stopActivityIngest } from '../services/okx-ws-pool.js';
import { startLedgerSync, stopLedgerSync } from './wallet-ledger-sync.js';
import { startOkxSignalIngest, stopOkxSignalIngest } from './okx-signal-ingest.js';
import { startPaperAgent, stopPaperAgent } from './paper-agent.js';
import {
  startPaperAgentNotifications,
  stopPaperAgentNotifications,
} from './paper-agent-notifications.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { guardSchemaOnStartup } from '../lib/schema-guard.js';

startPriceUpdater();
startLimitWatcher();
startCopyExecutor();
startTokenImporter();
startCandleBuilder();
startRadarScanner();
startRadarTracker();
startWalletTracker();
startScamChecker();
startRadarRisk();
startEntitlementSweeper();

/**
 * Воркеры кошельков запускаются только после проверки схемы.
 *
 * Отставшая база и запущенный на неё воркер дают худший исход
 * из возможных: часть событий записывается, часть падает, и в итоге
 * позиция собирается из неполного набора сделок — то есть выглядит
 * посчитанной, будучи неверной.
 */
const walletWorkersReady = guardSchemaOnStartup().then(async (ready) => {
  if (!ready) return false;

  startWalletDiscovery();
  startActivityIngest();
  startLedgerSync();
  await startPaperAgent();
  startPaperAgentNotifications();
  startOkxSignalIngest();
  return true;
});

const shutdown = async () => {
  logger.info('останавливаем воркеры');
  stopPriceUpdater();
  stopLimitWatcher();
  stopCopyExecutor();
  stopTokenImporter();
  stopCandleBuilder();
  stopRadarScanner();
  stopRadarTracker();
  stopWalletTracker();
  stopScamChecker();
  stopRadarRisk();
  stopEntitlementSweeper();

  // Останавливаем только то, что действительно запустилось: иначе
  // при отставшей схеме остановка обращалась бы к невыполненному
  // запуску и завершение процесса зависало бы на ошибке.
  if (await walletWorkersReady) {
    stopWalletDiscovery();
    stopActivityIngest();
    stopLedgerSync();
    stopOkxSignalIngest();
    stopPaperAgent();
    stopPaperAgentNotifications();
  }

  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
