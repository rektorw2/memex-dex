import { defineConfig } from 'vitest/config';

/**
 * Безопасное окружение для тестов API.
 *
 * Тесты запускаются и на машине разработчика с .env, и на чистом CI.
 * Обязательные значения задаются здесь, чтобы результат не зависел от
 * наличия локального файла. Денежные интеграции явно выключены: тест,
 * который проверяет конкретный провайдер, включает его сам.
 */
export default defineConfig({
  test: {
    /*
     * Сквозной стенд сюда не входит.
     *
     * Его файлы называются `*.e2e.test.ts` и подходят под обычный
     * шаблон, поэтому исключение обязательно: без него команда
     * `npm test` пыталась бы поднять их без базы и падала бы на
     * машине, где никакой базы для тестов нет.
     *
     * Запускается стенд отдельно: `npm run test:e2e`.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'src/e2e/**'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/memex_test',
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
      KMS_PROVIDER: 'local',
      // 32 нулевых байта в base64: намеренно непригодный вне тестов ключ.
      KMS_LOCAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      EMAIL_PROVIDER: 'disabled',
      SUBSCRIPTION_PAYMENT_PROVIDER: 'disabled',
      BRIDGE_PAYMENTS_ENABLED: 'false',
      COINBASE_ONRAMP_ENABLED: 'false',
      FUNDING_ENABLED: 'false',
      EXECUTION_MODE: 'paper',
    },
  },
});
