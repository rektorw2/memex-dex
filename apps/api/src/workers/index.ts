import { startLimitWatcher, stopLimitWatcher } from './limit-watcher.js';
import { startPriceUpdater, stopPriceUpdater } from './price-updater.js';
import { startCopyExecutor, stopCopyExecutor } from './copy-executor.js';
import { startTokenImporter, stopTokenImporter } from './token-importer.js';
import { startCandleBuilder, stopCandleBuilder } from './candle-builder.js';
import { startRadarScanner, stopRadarScanner } from './radar-scanner.js';
import { startRadarTracker, stopRadarTracker } from './radar-tracker.js';
import { startWalletTracker, stopWalletTracker } from './wallet-tracker.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

startPriceUpdater();
startLimitWatcher();
startCopyExecutor();
startTokenImporter();
startCandleBuilder();
startRadarScanner();
startRadarTracker();
startWalletTracker();

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
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
