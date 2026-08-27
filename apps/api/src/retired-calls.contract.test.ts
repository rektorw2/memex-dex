// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const api = fileURLToPath(new URL('../', import.meta.url));

describe('Calls API и процессы отключены без удаления данных', () => {
  it('маршруты Calls и auto-rule отсутствуют', () => {
    expect(existsSync(`${api}src/modules/calls.ts`)).toBe(false);
    expect(existsSync(`${api}src/modules/auto-rule.ts`)).toBe(false);
  });

  it('сервер не регистрирует удалённые маршруты', () => {
    const server = readFileSync(`${api}src/server.ts`, 'utf8');
    expect(server).not.toContain('callRoutes');
    expect(server).not.toContain('autoRuleRoutes');
  });

  it('worker не запускает auto-publisher ни в одном режиме', () => {
    const server = readFileSync(`${api}src/server.ts`, 'utf8');
    const worker = readFileSync(`${api}src/workers/index.ts`, 'utf8');
    expect(server).not.toContain('auto-publisher');
    expect(worker).not.toContain('AutoPublisher');
    expect(existsSync(`${api}src/workers/auto-publisher.ts`)).toBe(false);
  });

  it('исторические модели остаются в Prisma schema', () => {
    const schema = readFileSync(`${api}../../prisma/schema.prisma`, 'utf8');
    expect(schema).toContain('model Call {');
    expect(schema).toContain('model AutoRule {');
  });
});
