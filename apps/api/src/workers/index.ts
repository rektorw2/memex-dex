import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { guardSchemaOnStartup } from '../lib/schema-guard.js';
import { describeWorkers, startBaseWorkers, startSchemaWorkers, stopWorkers } from './registry.js';

/*
 * Отдельный процесс воркеров. Набор — из общего регистра: тот же, что
 * поднимает API при RUN_WORKERS_IN_API=true. Финансовые воркеры
 * (startSolanaDepositWorker, startSolanaReconciliationWorker,
 * startIntentExpiryWorker, startIntentSigningWorker) включаются только
 * своими флагами; регистр их не обходит.
 */
const baseWorkers = await startBaseWorkers();

/**
 * Воркеры кошельков запускаются только после проверки схемы.
 *
 * Отставшая база и запущенный на неё воркер дают худший исход
 * из возможных: часть событий записывается, часть падает, и в итоге
 * позиция собирается из неполного набора сделок — то есть выглядит
 * посчитанной, будучи неверной.
 */
const schemaWorkers = guardSchemaOnStartup().then(async (ready) => {
  if (!ready) return [];
  const handles = await startSchemaWorkers();
  logger.info(describeWorkers([...baseWorkers, ...handles]), 'воркеры запущены отдельным процессом');
  return handles;
});

const shutdown = async () => {
  logger.info('останавливаем воркеры');
  // Останавливаем только то, что действительно запустилось: иначе
  // при отставшей схеме остановка обращалась бы к невыполненному
  // запуску и завершение процесса зависало бы на ошибке.
  stopWorkers(await schemaWorkers);
  stopWorkers(baseWorkers);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
