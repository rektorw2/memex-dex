/**
 * Запуск проверки контракта истории DEX.
 *
 * Тонкая обёртка: переменные окружения, настоящий REST-клиент
 * и код выхода. Сама проверка — в `src/smoke/ledger-smoke.ts`,
 * она ничего не пишет и покрыта тестами на подделке транспорта.
 *
 * Запуск: npm run okx:ledger-smoke -w @memex/api
 *
 * Переменные:
 *   OKX_SMOKE_WALLET       — адрес кошелька
 *   OKX_SMOKE_CHAIN_INDEX  — индекс сети OKX, по умолчанию 501 (Solana)
 *   OKX_SMOKE_BEGIN        — начало интервала, мс; по умолчанию неделя назад
 *   OKX_SMOKE_END          — конец интервала, мс; по умолчанию сейчас
 */

import { unwrapOkx, OKX_CHAIN_INDEX, type ChainKey } from '@memex/core';
import { runLedgerSmoke } from '../src/smoke/ledger-smoke.js';
import { SMOKE_EXIT } from '../src/smoke/exit-codes.js';
import { okxCall, isOkxWalletConfigured } from '../src/services/okx-client.js';
import { prisma } from '../src/lib/prisma.js';

const HISTORY_PATH = '/api/v6/dex/market/portfolio/dex-history';
const WEEK_MS = 7 * 864e5;

/** Сеть по индексу OKX. Нужна для нормализации адресов при разборе. */
function chainOf(chainIndex: string): ChainKey | null {
  const entry = Object.entries(OKX_CHAIN_INDEX).find(([, index]) => index === chainIndex);
  return (entry?.[0] as ChainKey) ?? null;
}

async function main(): Promise<number> {
  const wallet = process.env.OKX_SMOKE_WALLET ?? '';
  // Solana по умолчанию: там больше всего меметокенов, ради которых
  // всё это и считается.
  const chainIndex = process.env.OKX_SMOKE_CHAIN_INDEX ?? OKX_CHAIN_INDEX.SOLANA ?? '501';

  const end = Number(process.env.OKX_SMOKE_END ?? Date.now());
  const begin = Number(process.env.OKX_SMOKE_BEGIN ?? end - WEEK_MS);

  if (!Number.isFinite(begin) || !Number.isFinite(end)) {
    console.error('OKX_SMOKE_BEGIN и OKX_SMOKE_END должны быть числами (миллисекунды)');
    return SMOKE_EXIT.config;
  }

  const chain = chainOf(chainIndex);

  if (!chain) {
    // Без сети нельзя нормализовать адрес: в EVM он приводится
    // к нижнему регистру, в Solana регистр значим. Угадывать нельзя.
    console.error(`Неизвестный chainIndex: ${chainIndex}`);
    return SMOKE_EXIT.config;
  }

  console.log('Проверка контракта истории DEX, только чтение\n');

  const result = await runLedgerSmoke({
    configured: isOkxWalletConfigured(),
    wallet,
    chain,
    chainIndex,
    begin,
    end,
    log: (line) => console.log(line),
    fetch: async (p) => {
      const params = new URLSearchParams({
        chainIndex: p.chainIndex,
        walletAddress: p.walletAddress,
        begin: String(p.begin),
        end: String(p.end),
        limit: String(p.limit),
      });
      if (p.cursor) params.set('cursor', p.cursor);

      const raw = await okxCall(`${HISTORY_PATH}?${params.toString()}`, { label: 'smoke-history' });
      return unwrapOkx<unknown>(raw, HISTORY_PATH);
    },
  });

  console.log(result.code === SMOKE_EXIT.ok ? '\nПроверка пройдена.' : '\nПроверка не пройдена.');

  return result.code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    console.error('Проверка прервалась ошибкой.');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    process.exitCode = SMOKE_EXIT.network;
  })
  .finally(() => {
    // Клиент Prisma здесь не используется для записи, но модуль
    // окружения поднимает подключение: без явного закрытия процесс
    // остаётся висеть на открытом сокете к базе.
    void prisma.$disconnect();
  });
