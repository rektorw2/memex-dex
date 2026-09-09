/**
 * Серверная цепочка по одному настоящему сигналу — только чтение базы.
 *
 * Запуск на сервере (нужны DATABASE_URL и работающие воркеры):
 *   npm run okx:signal-chain -w @memex/api            — самый свежий сигнал, поставленный агенту
 *   SIGNAL_ID=<id> npm run okx:signal-chain -w @memex/api — конкретный сигнал
 *   OKX_SIGNAL_CHAIN_WAIT_MS=600000 — сколько ждать сигнала и решения (по умолчанию 5 минут)
 *
 * Коды выхода: 0 — цепочка подтверждена (получение → база → воркер →
 * решение); 9 — проверка неполная (нет сигнала, нет run, нет решения);
 * 3 — база недоступна. Сделок не создаёт, позиций не открывает.
 */
import { prisma } from '../src/lib/prisma.js';
import { runSignalChainCheck } from '../src/smoke/signal-chain.js';
import { SMOKE_EXIT } from '../src/smoke/exit-codes.js';

async function main(): Promise<number> {
  const waitMs = Math.min(3_600_000, Math.max(0, Number(process.env.OKX_SIGNAL_CHAIN_WAIT_MS ?? 300_000) || 300_000));
  const signalId = process.env.SIGNAL_ID?.trim() || null;
  console.log('Проверка серверной цепочки по одному сигналу, только чтение базы\n');
  const report = await runSignalChainCheck({
    waitMs,
    findSignal: async (id) => {
      const row = id
        ? await prisma.okxSignal.findUnique({ where: { id } })
        : await prisma.okxSignal.findFirst({ where: { paperAgentIngestCode: 'QUEUED_LIVE' }, orderBy: { receivedAt: 'desc' } });
      return row ? { id: row.id, providerKey: row.providerKey, chain: row.chain, symbol: row.symbol, ingestOrigin: row.ingestOrigin, paperAgentIngestCode: row.paperAgentIngestCode, signaledAt: row.signaledAt, receivedAt: row.receivedAt } : null;
    },
    findRuns: async (id) => {
      const rows = await prisma.paperAgentRun.findMany({ where: { signalId: id }, include: { strategy: { select: { key: true } } } });
      return rows.map((row) => ({ id: row.id, strategyId: row.strategyId, strategyKey: row.strategy.key, state: row.state, decisionCode: row.decisionCode, decidedAt: row.decidedAt }));
    },
    listEnabledStrategies: () => prisma.paperAgentStrategy.findMany({ where: { isEnabled: true }, select: { id: true, key: true } }),
    log: (line) => console.log(line),
  }, signalId);
  if (report.status === 'complete') console.log('\nСерверная цепочка подтверждена.');
  else if (report.status === 'incomplete') { console.log(`\nПроверка НЕ завершена (код ${report.code}):`); for (const gap of report.gaps) console.log(`  • ${gap}`); }
  return report.code;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: any) => { console.error('Проверка прервалась ошибкой.'); console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`); process.exitCode = SMOKE_EXIT.network; })
  .finally(() => prisma.$disconnect().catch(() => undefined));
