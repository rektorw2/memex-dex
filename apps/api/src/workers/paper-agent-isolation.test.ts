import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workerUrl = new URL('./paper-agent.ts', import.meta.url);
const notificationWorkerUrl = new URL('./paper-agent-notifications.ts', import.meta.url);
const ingestUrl = new URL('./okx-signal-ingest.ts', import.meta.url);
const allocationUrl = new URL('../services/paper-agent-allocation.ts', import.meta.url);
const worker = readFileSync(workerUrl, 'utf8');
const notificationWorker = readFileSync(notificationWorkerUrl, 'utf8');
const ingest = readFileSync(ingestUrl, 'utf8');
const allocation = readFileSync(allocationUrl, 'utf8');

describe('paper-agent — изоляция от боевого исполнения', () => {
  it('не импортирует исполнение, адаптеры сетей, KMS или кошельки', () => {
    for (const forbidden of [
      "services/execution",
      "chains/",
      "kms",
      "privateKey",
      "executeOrder",
      "getAdapter",
    ]) {
      expect(worker, forbidden).not.toContain(forbidden);
    }
  });

  it('не ходит в сеть и читает цену только из общей таблицы Token', () => {
    expect(worker).not.toMatch(/\bfetch\s*\(/);
    expect(worker).not.toContain('fetchLivePrices');
    expect(worker).toContain('prisma.token.findMany');
  });

  it('подключается к существующему ingest, а не создаёт второй OKX-клиент', () => {
    expect(worker).not.toContain('OkxWalletWebSocketClient');
    expect(ingest.match(/new OkxWalletWebSocketClient/g)).toHaveLength(1);
    expect(ingest).toContain('queuePaperAgentSignal');
  });

  it('проверяет paper-режим до инициализации конфигурации', () => {
    const gate = worker.indexOf('paperAgentStartVerdict(env.EXECUTION_MODE)');
    const initialization = worker.indexOf('await ensurePaperAgentConfig()', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(initialization).toBeGreaterThan(gate);
  });

  it('notification worker не импортирует боевое исполнение, кошельки, KMS или RPC', () => {
    for (const forbidden of [
      'services/execution',
      'chains/',
      'kms',
      'privateKey',
      'executeOrder',
      'getAdapter',
      'submitSwap',
      'SOLANA_RPC_URL',
    ]) {
      expect(notificationWorker, forbidden).not.toContain(forbidden);
    }
  });

  it('Phase 3 allocation service не получает сетевой или live-execution адаптер', () => {
    const imports = allocation.match(/^import .*$/gm)?.join('\n') ?? '';
    expect(imports).not.toMatch(/services\/execution|chains\/|wallet|kms|private-key|rpc/i);
    expect(allocation).not.toMatch(/\bfetch\s*\(/);
    expect(allocation).toContain("from '@memex/core'");
    expect(allocation).toContain("from '../lib/prisma.js'");
  });
});
