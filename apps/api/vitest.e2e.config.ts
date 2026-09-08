import { defineConfig } from 'vitest/config';

/**
 * Сквозной стенд PAPER-режима.
 *
 * Отдельная конфигурация, а не часть обычного набора: этим тестам нужна
 * настоящая база PostgreSQL, и в обычном прогоне они молча превращались
 * бы в «пропущено» — то есть в зелёный результат, ничего не значащий.
 *
 * Запуск:
 *   E2E_DATABASE_URL=postgresql://user:pass@localhost:5432/memex_e2e \
 *     npm run test:e2e -w @memex/api
 *
 * Значения ниже держат контур закрытым: боевой режим, mainnet, выводы и
 * подпись выключены. Управляемый источник сигналов включён — ради него
 * стенд и существует, и он допустим только в этом сочетании.
 */
export default defineConfig({
  test: {
    include: ['src/e2e/**/*.e2e.test.ts'],
    /*
     * Схема накатывается один раз на весь прогон настоящей командой
     * `prisma migrate deploy`. Отказ здесь останавливает запуск
     * целиком: ошибка подготовки не должна выглядеть как набор
     * пропущенных тестов.
     */
    globalSetup: ['./src/e2e/global-setup.ts'],
    setupFiles: ['./src/e2e/setup-env.ts'],
    /*
     * Файлы идут по очереди: база одна, и параллельные наборы
     * затирали бы данные друг друга. Внутри файла сценарии тоже
     * последовательны — так требует общая база.
     */
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
      KMS_PROVIDER: 'local',
      KMS_LOCAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      EMAIL_PROVIDER: 'disabled',
      SUBSCRIPTION_PAYMENT_PROVIDER: 'disabled',
      BRIDGE_PAYMENTS_ENABLED: 'false',
      COINBASE_ONRAMP_ENABLED: 'false',

      // PAPER и только PAPER.
      EXECUTION_MODE: 'paper',
      FUNDING_ENABLED: 'false',
      LIVE_AGENT_ENABLED: 'false',
      LIVE_EXECUTION_ENABLED: 'false',
      WITHDRAWALS_ENABLED: 'false',
      SOLANA_SIGNING_ENABLED: 'false',
      SOLANA_NETWORK: 'devnet',

      // Управляемый источник: единственная настройка, которую стенд включает.
      PAPER_TEST_SOURCE_ENABLED: 'true',

      // Уведомления наружу не уходят.
      TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: 'false',
    },
  },
});
