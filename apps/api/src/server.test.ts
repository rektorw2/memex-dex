import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('запуск API', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('регистрирует маршруты без второго JSON-парсера', async () => {
    app = await buildServer();

    await app.ready();
    expect(app.hasContentTypeParser('application/json')).toBe(true);
  });
});
