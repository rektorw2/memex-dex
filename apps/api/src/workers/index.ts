import { startLimitWatcher, stopLimitWatcher } from './limit-watcher.js';
import { startPriceUpdater, stopPriceUpdater } from './price-updater.js';
import { startCopyExecutor, stopCopyExecutor } from './copy-executor.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

startPriceUpdater();
startLimitWatcher();
startCopyExecutor();

const shutdown = async () => {
  logger.info('останавливаем воркеры');
  stopPriceUpdater();
  stopLimitWatcher();
  stopCopyExecutor();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
