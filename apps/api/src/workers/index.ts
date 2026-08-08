import { startLimitWatcher, stopLimitWatcher } from './limit-watcher.js';
import { startPriceUpdater, stopPriceUpdater } from './price-updater.js';
import { startCopyExecutor, stopCopyExecutor } from './copy-executor.js';
import { startTokenImporter, stopTokenImporter } from './token-importer.js';
import { startCandleBuilder, stopCandleBuilder } from './candle-builder.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

startPriceUpdater();
startLimitWatcher();
startCopyExecutor();
startTokenImporter();
startCandleBuilder();

const shutdown = async () => {
  logger.info('останавливаем воркеры');
  stopPriceUpdater();
  stopLimitWatcher();
  stopCopyExecutor();
  stopTokenImporter();
  stopCandleBuilder();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
