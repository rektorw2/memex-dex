import { startLimitWatcher, stopLimitWatcher } from './limit-watcher.js';
import { startPriceUpdater, stopPriceUpdater } from './price-updater.js';
import { startCopyExecutor, stopCopyExecutor } from './copy-executor.js';
import { startTokenImporter, stopTokenImporter } from './token-importer.js';
import { startCandleBuilder, stopCandleBuilder } from './candle-builder.js';
import { startRadarScanner, stopRadarScanner } from './radar-scanner.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

startPriceUpdater();
startLimitWatcher();
startCopyExecutor();
startTokenImporter();
startCandleBuilder();
startRadarScanner();

const shutdown = async () => {
  logger.info('останавливаем воркеры');
  stopPriceUpdater();
  stopLimitWatcher();
  stopCopyExecutor();
  stopTokenImporter();
  stopCandleBuilder();
  stopRadarScanner();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
